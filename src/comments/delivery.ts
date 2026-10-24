// Sends, delivery records and presence in the state directory (docs/COMMENTS-PLAN.md §9.4, §9.8, §9.9).
// `pushed/<sendId>.json` is the single arbiter of a send's fate: created exclusively, once, by the routed server
// (before it pushes) or by the extension (to cancel or retire). Whoever creates it decides.
import { join } from 'node:path';
import { z } from 'zod';
import { anchorIdSchema, explainerNameSchema } from '../core/manifest.ts';
import { isNonce } from '../core/threads/prompt.ts';
import { CAPS, COMMIT_RE, EVENT_ID_RE, isPlainPath, isSafeBranch, SEND_ID_RE, SERVER_ID_RE, THREAD_ID_RE } from '../core/threads/schema.ts';
import { listDir, readSmall, writeNoReplace, writeReplace } from './fsx.ts';
import { checkPrivate } from './state-dir.ts';

export const HEARTBEAT_MS = 15_000;
export const LIVE_MS = 45_000;
export const ENDED_MS = 120_000;
export const RECORD_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

export const sendSchema = z.object({
  v: z.literal(1),
  send: z.string().regex(SEND_ID_RE),
  event: z.string().regex(EVENT_ID_RE),
  thread: z.string().regex(THREAD_ID_RE),
  root: z.string().min(1).max(4096),
  repoKey: z.string().regex(/^[0-9a-f]{16}$/),
  sidestory: explainerNameSchema.optional(),
  tier: z.enum(['local', 'shared']),
  text: z.string().min(1).max(CAPS.bodyChars),
  intent: z.enum(['answer', 'edit']),
  mode: z.enum(['file', 'branch', 'review']),
  commit: z.string().regex(COMMIT_RE).optional(),
  branch: z.string().refine(isSafeBranch).optional(),
  via: z.string().max(64).optional(),
  workspaceTrusted: z.boolean(),
  target: z.object({
    step: anchorIdSchema.optional(),
    file: z.string().refine(isPlainPath).optional(),
    lines: z.tuple([z.number().int().min(1).max(9_999_999), z.number().int().min(1).max(9_999_999)]).optional(),
    side: z.enum(['head', 'base']).optional(),
  }),
  followUp: z.number().int().min(0).max(10_000),
  route: z.string().regex(SERVER_ID_RE),
  at: z.string().max(40),
});
export type Send = z.infer<typeof sendSchema>;

export type Pushed = { at: string; serverId: string; nonce: string } | { cancelled: true; by: 'extension'; at: string };

export const presenceSchema = z.object({
  v: z.literal(1),
  serverId: z.string().regex(SERVER_ID_RE),
  pid: z.number().int(),
  startedAt: z.string().max(40),
  heartbeatAt: z.string().max(40),
  roots: z.array(z.string().max(4096)).max(50),
  repoKeys: z.array(z.string().regex(/^[0-9a-f]{16}$/)).max(200),
  channel: z.enum(['confirmed', 'likely', 'unknown']),
  client: z.string().max(64),
  label: z.string().max(200),
  sessionId: z.string().max(100).optional(),
});
export type Presence = z.infer<typeof presenceSchema>;

export type Liveness = 'live' | 'not-responding' | 'ended';

export function liveness(p: Presence | undefined, now = Date.now()): Liveness {
  if (!p) return 'ended';
  const age = now - Date.parse(p.heartbeatAt);
  if (!(age >= -LIVE_MS)) return 'ended';
  return age < LIVE_MS ? 'live' : age < ENDED_MS ? 'not-responding' : 'ended';
}

function parseJson<T>(text: string | undefined, schema: z.ZodType<T>): T | undefined {
  if (!text) return undefined;
  try {
    const r = schema.safeParse(JSON.parse(text));
    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
}

export class StateStore {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }

  async writeSend(s: Send): Promise<void> {
    checkPrivate(this.dir);
    checkPrivate(join(this.dir, 'sends'));
    sendSchema.parse(s);
    if (!(await writeNoReplace(join(this.dir, 'sends'), `${s.send}.json`, JSON.stringify(s), 0o600))) throw new Error('send exists');
  }

  async readSend(id: string): Promise<Send | undefined> {
    if (!SEND_ID_RE.test(id)) return undefined;
    return parseJson(await readSmall(join(this.dir, 'sends', `${id}.json`), 64_000), sendSchema);
  }

  async sendIds(): Promise<string[]> {
    return (await listDir(join(this.dir, 'sends'))).filter((f) => f.endsWith('.json') && SEND_ID_RE.test(f.slice(0, -5))).map((f) => f.slice(0, -5));
  }

  /**
   * Creates `pushed/<sendId>.json` exclusively, complete in one step. True when this caller won (it may push, or
   * the cancel took effect); false when the record already exists.
   */
  async claim(sendId: string, record: Pushed): Promise<boolean> {
    if (!SEND_ID_RE.test(sendId)) return false;
    checkPrivate(join(this.dir, 'pushed'));
    return writeNoReplace(join(this.dir, 'pushed'), `${sendId}.json`, JSON.stringify(record), 0o600);
  }

  /** The arbiter record; `pending` when it exists but can't be parsed yet. */
  async pushed(sendId: string): Promise<Pushed | 'pending' | undefined> {
    if (!SEND_ID_RE.test(sendId)) return undefined;
    const t = await readSmall(join(this.dir, 'pushed', `${sendId}.json`), 4096);
    if (t === undefined) return undefined;
    try {
      const v = JSON.parse(t) as Record<string, unknown>;
      if (v.cancelled === true) return { cancelled: true, by: 'extension', at: String(v.at ?? '') };
      if (typeof v.serverId === 'string' && SERVER_ID_RE.test(v.serverId) && isNonce(v.nonce)) return { at: String(v.at ?? ''), serverId: v.serverId, nonce: v.nonce };
    } catch {
      /* partial */
    }
    return 'pending';
  }

  async markSeen(sendId: string): Promise<void> {
    if (!SEND_ID_RE.test(sendId)) return;
    await writeNoReplace(join(this.dir, 'seen'), `${sendId}.json`, JSON.stringify({ at: new Date().toISOString() }), 0o600);
  }

  async seen(sendId: string): Promise<{ at: string } | undefined> {
    if (!SEND_ID_RE.test(sendId)) return undefined;
    const t = await readSmall(join(this.dir, 'seen', `${sendId}.json`), 4096);
    try {
      return t ? (JSON.parse(t) as { at: string }) : undefined;
    } catch {
      return undefined;
    }
  }

  async writePresence(p: Presence): Promise<void> {
    await writeReplace(join(this.dir, 'sessions'), `${p.serverId}.json`, JSON.stringify(p));
  }

  async readPresence(serverId: string): Promise<Presence | undefined> {
    if (!SERVER_ID_RE.test(serverId)) return undefined;
    return parseJson(await readSmall(join(this.dir, 'sessions', `${serverId}.json`), 64_000), presenceSchema);
  }

  async sessions(): Promise<Presence[]> {
    const out: Presence[] = [];
    for (const f of await listDir(join(this.dir, 'sessions'))) {
      if (!f.endsWith('.json')) continue;
      const p = await this.readPresence(f.slice(0, -5));
      if (p) out.push(p);
    }
    return out;
  }
}

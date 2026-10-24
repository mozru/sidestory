// Comment threads: the event format (docs/COMMENTS-PLAN.md §3.3). Thread files are untrusted repository data:
// everything is validated and size-limited here, and nothing from a file is ever used as a path.
import { z } from 'zod';
import { displayText } from '../display-text.ts';
import { anchorIdSchema, explainerNameSchema, isSafeRelativePath } from '../manifest.ts';

/** Crockford base32, 26 characters: 48 bits of milliseconds, then 80 random bits. */
const ULID = '[0-9A-HJKMNP-TV-Z]{26}';
export const ULID_RE = new RegExp(`^${ULID}$`);
export const THREAD_ID_RE = new RegExp(`^t_${ULID}$`);
export const EVENT_ID_RE = new RegExp(`^e_${ULID}$`);
export const SEND_ID_RE = new RegExp(`^s_${ULID}$`);
export const SERVER_ID_RE = new RegExp(`^srv_${ULID}$`);
export const isThreadId = (s: unknown): s is string => typeof s === 'string' && THREAD_ID_RE.test(s);
export const isEventId = (s: unknown): s is string => typeof s === 'string' && EVENT_ID_RE.test(s);

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** The millisecond time a ULID (or a `t_`/`e_`/`s_` id) carries. */
export function ulidTime(id: string): number {
  const u = id.slice(id.indexOf('_') + 1, id.indexOf('_') + 11);
  let t = 0;
  for (const c of u) t = t * 32 + B32.indexOf(c);
  return t;
}

/** A ULID from a time and 10 random bytes (the caller supplies randomness: core has no crypto). */
export function encodeUlid(time: number, random: Uint8Array): string {
  let out = '';
  let t = Math.max(0, Math.floor(time));
  for (let i = 0; i < 10; i++) {
    out = B32[t % 32]! + out;
    t = Math.floor(t / 32);
  }
  // 80 bits as 16 base32 digits, 5 bits at a time.
  let bits = 0;
  let value = 0;
  for (const byte of random.slice(0, 10)) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]!;
      bits -= 5;
    }
  }
  return out;
}

export const CAPS = {
  eventBytes: 32_000,
  eventsPerThread: 200,
  threadsPerSidestory: 1000,
  threadsTotal: 5000,
  bytesPerSidestory: 20_000_000,
  bodyChars: 8000,
  nameChars: 64,
  edited: 20,
} as const;

export type Trust = 'local_user' | 'claude' | 'agent' | 'repository';
export type AuthorKind = 'human' | 'claude' | 'agent';
export type EventType = 'open' | 'comment' | 'edit' | 'retract' | 'resolve' | 'reopen';
export type Tier = 'local' | 'shared';

export interface Author {
  kind: AuthorKind;
  /** Cleaned; empty means "you" on the machine that wrote it and "Anonymous" elsewhere. */
  name: string;
  /** For `claude` and `agent`: the human whose session wrote it. */
  via?: string;
}

export interface StepAnchor {
  kind: 'step';
  step: string;
}

export interface CodeAnchor {
  kind: 'code';
  file: string;
  side: 'head' | 'base';
  quote: { exact: string; prefix: string; suffix: string };
  range: [number, number];
  commit?: string;
}

/** Reserved for 0.2.2 (§4.1); shown as a thread on its step. */
export interface ElementAnchor {
  kind: 'element';
  step: string;
  label?: string;
}

export type ThreadAnchor = StepAnchor | CodeAnchor | ElementAnchor;

export interface Origin {
  branch?: string;
  head?: string;
  /** The sidestory's stable manifest `id` when it was written. */
  sidestory?: string;
}

export interface ThreadEvent {
  v: 1;
  id: string;
  thread: string;
  type: EventType;
  at: string;
  by: Author;
  anchor?: ThreadAnchor;
  origin?: Origin;
  body?: string;
  to?: 'claude';
  /** edit / retract: the event changed. */
  target?: string;
  inReplyTo?: string;
  edited?: string[];
  resolveSuggested?: boolean;
}

/** Normalizes a comment body: `\n` line endings; NUL and other C0 controls except tab and newline removed; capped. */
export function cleanBody(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .slice(0, CAPS.bodyChars);
}

/**
 * A display name safe to store and show: no address-like tokens (anything in `<…>`, any token with `@`), cleaned by
 * `displayText`, at most 64 characters. Empty when nothing is left.
 */
export function cleanAuthorName(s: string): string {
  const noAngles = s.replace(/<[^>]*>?/g, ' ');
  const noAt = noAngles
    .split(/\s+/)
    .filter((t) => !t.includes('@'))
    .join(' ');
  return displayText(noAt, CAPS.nameChars);
}

const BRANCH_RE = /^[A-Za-z0-9._/-]{1,100}$/;
export const COMMIT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const isSafeBranch = (s: unknown): s is string => typeof s === 'string' && BRANCH_RE.test(s) && !s.includes('..');

/** A path shown or sent: a safe relative path in a conservative alphabet. */
export const isPlainPath = (s: unknown): s is string => typeof s === 'string' && isSafeRelativePath(s) && /^[A-Za-z0-9._/-]{1,200}$/.test(s);

const authorSchema = z.object({
  kind: z.enum(['human', 'claude', 'agent']),
  name: z.string().max(400),
  via: z.string().max(400).optional(),
});

const quoteSchema = z.object({ exact: z.string().min(1).max(64_000), prefix: z.string().max(1000).default(''), suffix: z.string().max(1000).default('') });
const lineNo = z.number().int().min(1).max(10_000_000);

const anchorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('step'), step: anchorIdSchema }),
  z.object({
    kind: z.literal('code'),
    file: z.string().max(1024).refine(isSafeRelativePath),
    side: z.enum(['head', 'base']).default('head'),
    quote: quoteSchema,
    range: z.tuple([lineNo, lineNo]).refine(([a, b]) => b >= a),
    commit: z.string().regex(COMMIT_RE).optional(),
  }),
  z.looseObject({ kind: z.literal('element'), step: anchorIdSchema, label: z.string().max(200).optional() }),
]);

const editedItem = z.string().max(300).refine((s) => (s.startsWith('step:') ? anchorIdSchema.safeParse(s.slice(5)).success : isPlainPath(s)));

const eventSchema = z.looseObject({
  v: z.number(),
  id: z.string().regex(EVENT_ID_RE),
  thread: z.string().regex(THREAD_ID_RE),
  type: z.string().max(20),
  at: z.string().max(40),
  by: authorSchema,
  anchor: z.unknown().optional(),
  origin: z.unknown().optional(),
  body: z.string().max(CAPS.bodyChars * 2).optional(),
  to: z.literal('claude').optional(),
  target: z.string().regex(EVENT_ID_RE).optional(),
  inReplyTo: z.string().regex(EVENT_ID_RE).optional(),
  edited: z.array(z.unknown()).max(CAPS.edited * 5).optional(),
  resolveSuggested: z.boolean().optional(),
});

const TYPES = new Set<EventType>(['open', 'comment', 'edit', 'retract', 'resolve', 'reopen']);

export type ParsedEvent = { ok: true; event: ThreadEvent } | { ok: false; skip: 'newer' | 'invalid' | 'unknown-type' | 'mismatch'; error: string };

/**
 * Parses one event file. `fileId` and `threadId` are the file and folder names: an event must name itself and its
 * thread exactly as its location does, so a copied or renamed file can't pose as another event.
 */
export function parseEvent(text: string, fileId: string, threadId: string): ParsedEvent {
  if (text.length > CAPS.eventBytes) return { ok: false, skip: 'invalid', error: 'event file is larger than 32 KB' };
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    return { ok: false, skip: 'invalid', error: `not valid JSON: ${(e as Error).message}` };
  }
  const r = eventSchema.safeParse(raw);
  if (!r.success) return { ok: false, skip: 'invalid', error: r.error.issues[0]?.message ?? 'invalid' };
  const e = r.data;
  if (e.v !== 1) return e.v > 1 ? { ok: false, skip: 'newer', error: 'made by a newer Sidestory' } : { ok: false, skip: 'invalid', error: 'unknown format version' };
  if (e.id !== fileId || e.thread !== threadId) return { ok: false, skip: 'mismatch', error: 'its id or thread differs from its file or folder name' };
  if (!TYPES.has(e.type as EventType)) return { ok: false, skip: 'unknown-type', error: `unknown event type` };
  const type = e.type as EventType;
  const by: Author = { kind: e.by.kind, name: cleanAuthorName(e.by.name) };
  if (e.by.kind !== 'human' && e.by.via !== undefined) by.via = cleanAuthorName(e.by.via);
  const out: ThreadEvent = { v: 1, id: e.id, thread: e.thread, type, at: displayText(e.at, 40), by };
  if (type === 'open') {
    const a = anchorSchema.safeParse(e.anchor);
    if (!a.success) return { ok: false, skip: 'invalid', error: 'open event without a valid anchor' };
    out.anchor = a.data.kind === 'element' ? { kind: 'element', step: a.data.step, ...(a.data.label ? { label: displayText(a.data.label, 200) } : {}) } : (a.data as ThreadAnchor);
    const o = parseOrigin(e.origin);
    if (o) out.origin = o;
  }
  if (e.body !== undefined) out.body = cleanBody(e.body);
  if ((type === 'open' || type === 'comment' || type === 'edit') && out.body === undefined) return { ok: false, skip: 'invalid', error: `${type} event without a body` };
  if ((type === 'edit' || type === 'retract') && !e.target) return { ok: false, skip: 'invalid', error: `${type} event without a target` };
  if (e.target) out.target = e.target;
  if (e.to) out.to = 'claude';
  if (e.inReplyTo) out.inReplyTo = e.inReplyTo;
  if (e.edited) {
    const items = e.edited.filter((x): x is string => editedItem.safeParse(x).success).slice(0, CAPS.edited);
    if (items.length) out.edited = items;
  }
  if (e.resolveSuggested) out.resolveSuggested = true;
  return { ok: true, event: out };
}

function parseOrigin(v: unknown): Origin | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const out: Origin = {};
  if (isSafeBranch(o.branch)) out.branch = o.branch;
  if (typeof o.head === 'string' && COMMIT_RE.test(o.head)) out.head = o.head;
  if (typeof o.sidestory === 'string' && ULID_RE.test(o.sidestory)) out.sidestory = o.sidestory;
  return Object.keys(out).length ? out : undefined;
}

/** The event as written to disk (keys in a stable order, then the file is canonicalized for the ledger). */
export function serializeEvent(e: ThreadEvent): string {
  return `${JSON.stringify(e, null, 2)}\n`;
}

/** Canonical JSON: keys sorted, no whitespace. The ledger hashes this, so reformatting and CRLF don't matter. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`;
}

/** The manifest's stable sidestory id (§3.1), when it has a valid one. */
export function manifestId(raw: Record<string, unknown> | undefined, parsed?: { id?: unknown }): string | undefined {
  // Read through the manifest parser's `id` once Changes 1b adds it; until then, from the raw manifest (a shim).
  const v = parsed?.id ?? raw?.id;
  return typeof v === 'string' && ULID_RE.test(v) ? v : undefined;
}

export const sidestoryNameSchema = explainerNameSchema;

// Thread files in a repository (docs/COMMENTS-PLAN.md §3): one folder per thread, one immutable file per event,
// shared under `.sidestory/<name>/threads/`, local under `.sidestory/.local/`. Node only; the extension, the MCP
// server and the checker all read and write through this.
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { explainerNameSchema } from '../core/manifest.ts';
import { reduceThread, type Thread, type TrustedEvent } from '../core/threads/reduce.ts';
import { CAPS, EVENT_ID_RE, isThreadId, parseEvent, serializeEvent, type AuthorKind, type Tier, type ThreadEvent } from '../core/threads/schema.ts';
import { exists, listDir, mkdirsNoFollow, readSmall, realInside, retrying, UnsafePathError, writeNoReplace } from './fsx.ts';
import { hashText, type Ledger } from './ledger.ts';

export type Scope = { kind: 'sidestory'; name: string } | { kind: 'code' } | { kind: 'review'; slug: string };
export interface Location {
  tier: Tier;
  scope: Scope;
}

const REVIEW_SLUG = /^[A-Za-z0-9._-]{1,80}-[0-9a-f]{7}$/;
export const LOCAL_GITIGNORE = '*\n';

export function locationKey(l: Location): string {
  const s = l.scope.kind === 'sidestory' ? `s:${l.scope.name}` : l.scope.kind === 'review' ? `r:${l.scope.slug}` : 'c';
  return `${l.tier}|${s}`;
}

/** The thread folder's path segments below the repository root. Throws for a location that can't exist. */
export function threadsSegments(l: Location): string[] {
  if (l.scope.kind === 'sidestory') {
    if (!explainerNameSchema.safeParse(l.scope.name).success) throw new UnsafePathError('bad sidestory name');
    return l.tier === 'shared' ? ['.sidestory', l.scope.name, 'threads'] : ['.sidestory', '.local', l.scope.name, 'threads'];
  }
  if (l.tier === 'shared') throw new UnsafePathError('code and review threads are local only');
  if (l.scope.kind === 'code') return ['.sidestory', '.local', '_code', 'threads'];
  if (!REVIEW_SLUG.test(l.scope.slug)) throw new UnsafePathError('bad review slug');
  return ['.sidestory', '.local', '_review', l.scope.slug, 'threads'];
}

export type LocalTierCheck = { ok: true } | { ok: false; why: string };

export interface ThreadRead {
  location: Location;
  threadId: string;
  events: TrustedEvent[];
  diagnostics: string[];
  /** Relative paths of the event files read, by event id. */
  paths: Map<string, string>;
}

export interface ReadBudget {
  bytes: number;
  threads: number;
}

export class ThreadFiles {
  readonly root: string;
  readonly ledger: Ledger;
  constructor(root: string, ledger: Ledger) {
    this.root = root;
    this.ledger = ledger;
  }

  /**
   * The local tier must ignore itself (§3.1): `.sidestory/.local` a real folder whose `.gitignore` is exactly `*\n`.
   * Creates both when `.local` is missing; refuses when either was changed (a repository could commit `!*`).
   */
  async checkLocalTier(create: boolean): Promise<LocalTierCheck> {
    const local = join(this.root, '.sidestory', '.local');
    const why = "Local comments here wouldn't stay private: .sidestory/.local is changed in this repository";
    try {
      const info = await fs.lstat(local);
      if (info.isSymbolicLink() || !info.isDirectory()) return { ok: false, why };
    } catch {
      if (!create) return { ok: true };
      await mkdirsNoFollow(this.root, ['.sidestory', '.local']);
      // Written before anything else in .local.
      await writeNoReplace(local, '.gitignore', LOCAL_GITIGNORE);
    }
    const text = await readSmall(join(local, '.gitignore'), 100);
    if (text === undefined && create) {
      await writeNoReplace(local, '.gitignore', LOCAL_GITIGNORE);
      return (await readSmall(join(local, '.gitignore'), 100)) === LOCAL_GITIGNORE ? { ok: true } : { ok: false, why };
    }
    return text === LOCAL_GITIGNORE ? { ok: true } : { ok: false, why };
  }

  /** Relative path of an event file. */
  eventPath(l: Location, threadId: string, eventId: string): string {
    return [...threadsSegments(l), threadId, `${eventId}.json`].join('/');
  }

  /**
   * Writes an event no-replace and records it in the ledger as `kind`. The order is the file, then its ledger
   * entry (§9.4). For the local tier, the `.gitignore` check runs first, every time.
   */
  async write(l: Location, event: ThreadEvent, kind: AuthorKind): Promise<string> {
    if (!isThreadId(event.thread) || !EVENT_ID_RE.test(event.id)) throw new UnsafePathError('bad ids');
    if (l.tier === 'local') {
      const c = await this.checkLocalTier(true);
      if (!c.ok) throw new Error(c.why);
    }
    const dir = await mkdirsNoFollow(this.root, [...threadsSegments(l), event.thread]);
    const text = serializeEvent(event);
    if (!(await writeNoReplace(dir, `${event.id}.json`, text))) throw new Error('an event with this id already exists');
    if (!(await realInside(join(dir, `${event.id}.json`), this.root))) throw new UnsafePathError('event file escaped the repository');
    const path = this.eventPath(l, event.thread, event.id);
    await this.ledger.record({ path, id: event.id, kind, hash: hashText(text)! });
    return path;
  }

  /** Every thread location under the root that exists (shared and local sidestories, `_code`, reviews). */
  async locations(): Promise<Location[]> {
    const out: Location[] = [];
    const ss = join(this.root, '.sidestory');
    for (const name of await listDir(ss)) {
      if (explainerNameSchema.safeParse(name).success && (await isPlainDir(join(ss, name, 'threads')))) out.push({ tier: 'shared', scope: { kind: 'sidestory', name } });
    }
    const local = join(ss, '.local');
    for (const name of await listDir(local)) {
      if (explainerNameSchema.safeParse(name).success && (await isPlainDir(join(local, name, 'threads')))) out.push({ tier: 'local', scope: { kind: 'sidestory', name } });
    }
    if (await isPlainDir(join(local, '_code', 'threads'))) out.push({ tier: 'local', scope: { kind: 'code' } });
    for (const slug of await listDir(join(local, '_review'))) {
      if (REVIEW_SLUG.test(slug) && (await isPlainDir(join(local, '_review', slug, 'threads')))) out.push({ tier: 'local', scope: { kind: 'review', slug } });
    }
    return out;
  }

  /** Thread ids in a location, newest first, with threads the ledger knows first (so junk can't push them out). */
  async threadIds(l: Location, known?: Set<string>): Promise<string[]> {
    const ids = (await listDir(join(this.root, ...threadsSegments(l)))).filter(isThreadId).sort().reverse();
    if (!known) return ids;
    return [...ids.filter((i) => known.has(i)), ...ids.filter((i) => !known.has(i))];
  }

  /** Where a thread id exists under this root. */
  async findThread(threadId: string): Promise<Location[]> {
    if (!isThreadId(threadId)) return [];
    const out: Location[] = [];
    for (const l of await this.locations()) if (await isPlainDir(join(this.root, ...threadsSegments(l), threadId))) out.push(l);
    return out;
  }

  /** Reads one thread's events with their trust (caps: 200 events, ledger-known and newest kept). */
  async readThread(l: Location, threadId: string, budget?: ReadBudget): Promise<ThreadRead> {
    const diagnostics: string[] = [];
    const paths = new Map<string, string>();
    const dir = join(this.root, ...threadsSegments(l), threadId);
    const rel = threadsSegments(l).join('/') + `/${threadId}`;
    const names = (await listDir(dir)).filter((f) => f.endsWith('.json') && EVENT_ID_RE.test(f.slice(0, -5))).sort().reverse();
    const known: string[] = [];
    const rest: string[] = [];
    for (const n of names) ((await this.ledger.get(`${rel}/${n}`, n.slice(0, -5))) ? known : rest).push(n);
    const pick = [...known, ...rest].slice(0, CAPS.eventsPerThread);
    if (names.length > pick.length) diagnostics.push(`only ${pick.length} of ${names.length} events read`);
    const events: TrustedEvent[] = [];
    if (!(await isPlainDir(dir)) || !(await realInside(dir, this.root))) return { location: l, threadId, events, diagnostics: ['not a plain folder'], paths };
    for (const n of pick) {
      if (budget && budget.bytes <= 0) {
        diagnostics.push('read budget used up');
        break;
      }
      const text = await readSmall(join(dir, n), CAPS.eventBytes);
      if (text === undefined) {
        diagnostics.push(`${n}: unreadable, a link, or too large`);
        continue;
      }
      if (budget) budget.bytes -= text.length;
      const id = n.slice(0, -5);
      const p = parseEvent(text, id, threadId);
      if (!p.ok) {
        diagnostics.push(`${n}: ${p.error}`);
        continue;
      }
      const path = `${rel}/${n}`;
      paths.set(id, path);
      events.push({ event: p.event, trust: await this.ledger.trustOf(path, id, hashText(text)) });
    }
    return { location: l, threadId, events, diagnostics, paths };
  }

  /** Reads and reduces every thread in a location, within the caps of §3.3. */
  async readLocation(l: Location, now = Date.now(), budget: ReadBudget = { bytes: CAPS.bytesPerSidestory, threads: CAPS.threadsPerSidestory }): Promise<{ read: ThreadRead; thread: Thread | null }[]> {
    const known = new Set((await this.ledger.all()).map((e) => e.path.split('/').at(-2) ?? ''));
    const ids = await this.threadIds(l, known);
    const out: { read: ThreadRead; thread: Thread | null }[] = [];
    for (const id of ids) {
      if (budget.threads <= 0 || budget.bytes <= 0) break;
      budget.threads--;
      const read = await this.readThread(l, id, budget);
      out.push({ read, thread: reduceThread(read.events, now) });
    }
    return out;
  }

  /**
   * Moves a thread between locations (Share, Make Local, Move to a Sidestory): ledger entries for the new path are
   * written before the rename and the old ones dropped after it. Refuses when the target already has the thread.
   */
  async move(threadId: string, from: Location, to: Location): Promise<void> {
    if (!isThreadId(threadId)) throw new UnsafePathError('bad thread id');
    if (to.tier === 'local') {
      const c = await this.checkLocalTier(true);
      if (!c.ok) throw new Error(c.why);
    }
    const src = join(this.root, ...threadsSegments(from), threadId);
    if (!(await isPlainDir(src))) throw new Error('thread not found');
    const parent = await mkdirsNoFollow(this.root, threadsSegments(to));
    const dst = join(parent, threadId);
    if (await exists(dst)) throw new Error('a thread with this id already exists there');
    const fromPrefix = `${threadsSegments(from).join('/')}/${threadId}/`;
    const toPrefix = `${threadsSegments(to).join('/')}/${threadId}/`;
    const moved = await this.ledger.prepareMove(fromPrefix, toPrefix);
    await retrying(() => fs.rename(src, dst), 8);
    await this.ledger.finishMove(moved);
  }

  /** Deletes a local thread's folder (Delete Thread). Shared threads are never deleted here. */
  async deleteThread(l: Location, threadId: string): Promise<void> {
    if (l.tier !== 'local' || !isThreadId(threadId)) throw new UnsafePathError('only local threads can be deleted');
    const dir = join(this.root, ...threadsSegments(l), threadId);
    if (!(await isPlainDir(dir))) return;
    for (const f of await listDir(dir)) {
      if (f.endsWith('.json') || f.includes('.tmp-')) await fs.unlink(join(dir, f)).catch(() => undefined);
    }
    await fs.rmdir(dir);
  }
}

async function isPlainDir(p: string): Promise<boolean> {
  try {
    const s = await fs.lstat(p);
    return s.isDirectory() && !s.isSymbolicLink();
  } catch {
    return false;
  }
}

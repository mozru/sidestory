// The authored ledger (docs/COMMENTS-PLAN.md §5.2): which event files this machine wrote, for whom, with what
// content. Kept in the state directory, so trust never comes from a file in the repository.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, type AuthorKind, type Trust } from '../core/threads/schema.ts';
import { listDir, mkdirsNoFollow, readSmall, writeReplace } from './fsx.ts';
import { checkPrivate } from './state-dir.ts';

export interface LedgerEntry {
  /** The event file, relative to the repository root, `/` separators. */
  path: string;
  id: string;
  kind: AuthorKind;
  /** SHA-256 of the event's canonical JSON. */
  hash: string;
}

/** The hash the ledger keeps: of the parsed file's canonical JSON, so line endings and formatting don't matter. */
export function eventHash(raw: unknown): string {
  return createHash('sha256').update(canonicalJson(raw), 'utf8').digest('hex');
}

export function hashText(text: string): string | undefined {
  try {
    return eventHash(JSON.parse(text.replace(/^﻿/, '')));
  } catch {
    return undefined;
  }
}

const keyOf = (path: string, id: string) => createHash('sha256').update(`${path}\0${id}`, 'utf8').digest('hex').slice(0, 40);

const TRUST: Record<AuthorKind, Trust> = { human: 'local_user', claude: 'claude', agent: 'agent' };

export class Ledger {
  private readonly state: string;
  readonly repoKey: string;
  /** The state directory failed its checks: nothing is trusted and nothing is recorded (fails closed). */
  disabled = false;
  constructor(state: string, repoKey: string) {
    this.state = state;
    this.repoKey = repoKey;
  }

  private dir() {
    return join(this.state, 'authored', this.repoKey);
  }

  async record(e: LedgerEntry): Promise<void> {
    if (this.disabled) throw new Error("the state directory failed its safety checks");
    checkPrivate(this.state);
    const dir = await mkdirsNoFollow(this.state, ['authored', this.repoKey], 0o700);
    checkPrivate(dir);
    await writeReplace(dir, `${keyOf(e.path, e.id)}.json`, JSON.stringify(e));
  }

  async get(path: string, id: string): Promise<LedgerEntry | undefined> {
    if (this.disabled) return undefined;
    const t = await readSmall(join(this.dir(), `${keyOf(path, id)}.json`), 4096);
    if (!t) return undefined;
    try {
      const v = JSON.parse(t) as LedgerEntry;
      return v.path === path && v.id === id ? v : undefined;
    } catch {
      return undefined;
    }
  }

  async drop(path: string, id: string): Promise<void> {
    await fs.unlink(join(this.dir(), `${keyOf(path, id)}.json`)).catch(() => undefined);
  }

  /** The trust of an event file at `path` with this canonical hash. */
  async trustOf(path: string, id: string, hash: string | undefined): Promise<Trust> {
    return trustFrom(await this.get(path, id), hash);
  }

  /** Every entry (for Share, Make Local and the sweep). */
  async all(): Promise<LedgerEntry[]> {
    return (await this.files()).map((f) => f.entry);
  }

  private async files(): Promise<{ name: string; entry: LedgerEntry }[]> {
    if (this.disabled) return [];
    const out: { name: string; entry: LedgerEntry }[] = [];
    for (const name of await listDir(this.dir())) {
      if (!name.endsWith('.json')) continue;
      const t = await readSmall(join(this.dir(), name), 4096);
      try {
        if (t) out.push({ name, entry: JSON.parse(t) as LedgerEntry });
      } catch {
        /* skipped */
      }
    }
    return out;
  }

  /**
   * The whole ledger read once, for a pass over many threads: `get` then answers from memory, as the ledger stood
   * when the snapshot was taken (instead of a file read per event and a full read per location).
   */
  async snapshot(): Promise<LedgerSnapshot> {
    const byKey = new Map<string, LedgerEntry>();
    const threads = new Set<string>();
    for (const { name, entry } of await this.files()) {
      if (typeof entry.path !== 'string' || typeof entry.id !== 'string') continue;
      threads.add(entry.path.split('/').at(-2) ?? '');
      // What `get` finds: only the entry in the file named for its own path and id.
      if (name === `${keyOf(entry.path, entry.id)}.json`) byKey.set(`${entry.path}\0${entry.id}`, entry);
    }
    return { threads, get: async (path, id) => byKey.get(`${path}\0${id}`) };
  }

  /**
   * Re-keys the entries under `fromPrefix` to `toPrefix` (a thread folder moving between tiers or sidestories).
   * Call `prepareMove` before the rename and `finishMove` after it, so a crash in between can't demote the
   * reader's own comments.
   */
  async prepareMove(fromPrefix: string, toPrefix: string): Promise<LedgerEntry[]> {
    const moved = (await this.all()).filter((e) => e.path.startsWith(fromPrefix));
    for (const e of moved) await this.record({ ...e, path: toPrefix + e.path.slice(fromPrefix.length) });
    return moved;
  }

  async finishMove(moved: readonly LedgerEntry[]): Promise<void> {
    for (const e of moved) await this.drop(e.path, e.id);
  }

  /**
   * Drops entries for local-tier event files that are gone (a deleted thread). Only the local tier: checkouts never
   * touch it, while a shared thread's files also vanish on a branch without them and come back with it. Entries
   * younger than `minAgeMs` stay, so a move between `prepareMove` and the rename (in any process) keeps its new ones.
   */
  async sweep(root: string, minAgeMs = 10 * 60_000, now = Date.now()): Promise<number> {
    let n = 0;
    for (const { name, entry } of await this.files()) {
      if (typeof entry.path !== 'string' || !entry.path.startsWith('.sidestory/.local/')) continue;
      const gone = await fs.lstat(join(root, ...entry.path.split('/'))).then(() => false, () => true);
      if (!gone) continue;
      const recorded = await fs.lstat(join(this.dir(), name)).catch(() => undefined);
      if (!recorded || now - recorded.mtimeMs < minAgeMs) continue;
      await fs.unlink(join(this.dir(), name)).catch(() => undefined);
      n++;
    }
    return n;
  }
}

/** Ledger lookups for one read: the ledger itself, or a snapshot of it. */
export interface LedgerView {
  get(path: string, id: string): Promise<LedgerEntry | undefined>;
}

export interface LedgerSnapshot extends LedgerView {
  /** Thread folder names with an entry (a read puts these threads first). */
  threads: ReadonlySet<string>;
}

/** An event's trust: its entry's author when the file still has the content recorded, else `repository`. */
export function trustFrom(entry: LedgerEntry | undefined, hash: string | undefined): Trust {
  return entry && hash && entry.hash === hash ? TRUST[entry.kind] : 'repository';
}

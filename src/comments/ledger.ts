// The authored ledger (docs/COMMENTS-PLAN.md §5.2): which event files this machine wrote, for whom, with what
// content. Kept in the state directory, so trust never comes from a file in the repository.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, type AuthorKind, type Trust } from '../core/threads/schema.ts';
import { listDir, mkdirsNoFollow, readSmall, writeReplace } from './fsx.ts';

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
  constructor(state: string, repoKey: string) {
    this.state = state;
    this.repoKey = repoKey;
  }

  private dir() {
    return join(this.state, 'authored', this.repoKey);
  }

  async record(e: LedgerEntry): Promise<void> {
    const dir = await mkdirsNoFollow(this.state, ['authored', this.repoKey], 0o700);
    await writeReplace(dir, `${keyOf(e.path, e.id)}.json`, JSON.stringify(e));
  }

  async get(path: string, id: string): Promise<LedgerEntry | undefined> {
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
    const e = await this.get(path, id);
    return e && hash && e.hash === hash ? TRUST[e.kind] : 'repository';
  }

  /** Every entry (for Share, Make Local and the sweep). */
  async all(): Promise<LedgerEntry[]> {
    const out: LedgerEntry[] = [];
    for (const f of await listDir(this.dir())) {
      if (!f.endsWith('.json')) continue;
      const t = await readSmall(join(this.dir(), f), 4096);
      try {
        if (t) out.push(JSON.parse(t) as LedgerEntry);
      } catch {
        /* skipped */
      }
    }
    return out;
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

  /** Drops entries whose file is gone. */
  async sweep(root: string): Promise<number> {
    let n = 0;
    for (const e of await this.all()) {
      try {
        await fs.lstat(join(root, ...e.path.split('/')));
      } catch {
        await this.drop(e.path, e.id);
        n++;
      }
    }
    return n;
  }
}

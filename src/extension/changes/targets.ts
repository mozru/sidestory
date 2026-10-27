// Targets keyed by (repo-relative path, side), never by a document URI (docs/CHANGES-PLAN.md §6.2, §8): the same
// targets serve a plain editor, either side of a diff, and a `HEAD` URI that changes with every commit. And the
// cursor rule on either side: on the head side, the head-side targets; on the base side, base-side targets first,
// else the line mapped old → new (§5.3) and the head-side targets there. Both through the shared cursor helper,
// with the "only sections count" rule. Pure: no vscode import.
import type { FileDiff } from '../../core/hunks.ts';
import { oldToNew } from '../../core/hunks.ts';
import type { LineRange, Side } from '../../core/manifest.ts';
import type { AnchorState } from '../../core/resolve.ts';
import { anchorForCursor } from '../cursor.ts';

export interface SideKey {
  /** Repo-relative path on its side: the new path on the head side, the merge-base path on the base side. */
  readonly path: string;
  readonly side: Side;
}

export const targetKey = (k: SideKey): string => `${k.side}\0${k.path}`;

/**
 * A `sidestory-git:` document as (path, side) in a comparison (§8): the merge-base is the base side, any other commit
 * of the same repository the head side. Keys never hold a commit, so a tab opened at an older head commit (before
 * the last commit, in committed mode) still maps to the head side.
 */
export function gitSideKey<R>(g: { repo: R; sha: string; path: string } | undefined, s: { repo: R; mergeBase: string }, same: (a: R, b: R) => boolean = (a, b) => a === b): SideKey | undefined {
  if (!g || !same(g.repo, s.repo)) return undefined;
  return { path: g.path, side: g.sha === s.mergeBase ? 'base' : 'head' };
}

type Resolved = { range: LineRange | null; state: AnchorState | 'pending' };

/** Anchor ids by side key; resolutions by id. */
export interface TargetTable {
  ids(key: SideKey): readonly string[];
  resolution(id: string): Resolved | undefined;
}

/**
 * The anchor the cursor at `line` of (path, side) is in (§8). On the base side, `diff` (the file's diff) and
 * `headPath` (its new path) let a line with no base-side target follow the step about the matching new lines.
 */
export function anchorAtSide(table: TargetTable, at: SideKey, line: number, opts: { sections?: ReadonlySet<string>; diff?: FileDiff; headPath?: string } = {}): string | undefined {
  const pairs = (key: SideKey) => table.ids(key).map((id) => [id, table.resolution(id) ?? { range: null, state: 'pending' as const }] as const);
  const own = anchorForCursor(pairs(at), line, { sections: opts.sections });
  if (own || at.side === 'head' || !opts.diff) return own;
  return anchorForCursor(pairs({ path: opts.headPath ?? at.path, side: 'head' }), oldToNew(opts.diff, line), { sections: opts.sections });
}

/** Lines `start`–`end` of the old side, mapped to the new side (the inline fallback, §7.5): never empty. */
export function mapOldRange(diff: FileDiff, r: LineRange): LineRange {
  const start = oldToNew(diff, r.start);
  const end = Math.max(start, oldToNew(diff, r.end));
  return { start, end };
}

interface EntryLike {
  readonly path: string;
  readonly oldPath?: string;
  readonly status: string;
}

/** A comparison's entries by path, each map holding the first match (as a scan in list order would find). */
export interface EntryIndex<E extends EntryLike> {
  byPath: ReadonlyMap<string, E>;
  /** Not deleted, by path: the head side. */
  head: ReadonlyMap<string, E>;
  /** Not added, by old path (or path): the base side. */
  base: ReadonlyMap<string, E>;
  /** The old paths of renames. */
  renamedFrom: ReadonlySet<string>;
}

const indexes = new WeakMap<readonly EntryLike[], EntryIndex<EntryLike>>();

/** The index of an entry list, built once per list (a snapshot's list never changes once it's set). */
export function entryIndex<E extends EntryLike>(entries: readonly E[]): EntryIndex<E> {
  let ix = indexes.get(entries) as EntryIndex<E> | undefined;
  if (!ix) {
    const byPath = new Map<string, E>();
    const head = new Map<string, E>();
    const base = new Map<string, E>();
    const renamedFrom = new Set<string>();
    const first = (m: Map<string, E>, k: string, e: E) => m.has(k) || m.set(k, e);
    for (const e of entries) {
      first(byPath, e.path, e);
      if (e.status !== 'D') first(head, e.path, e);
      if (e.status !== 'A') first(base, e.oldPath ?? e.path, e);
      if (e.status === 'R' && e.oldPath !== undefined) renamedFrom.add(e.oldPath);
    }
    ix = { byPath, head, base, renamedFrom };
    indexes.set(entries, ix);
  }
  return ix;
}

/** The empty side of an added or deleted file's diff (`sidestory-empty:/<path>`) as the file's other side. */
export function emptySideKey(path: string, entries: readonly EntryLike[]): SideKey | undefined {
  const e = entryIndex(entries).byPath.get(path);
  return e?.status === 'D' ? { path: e.oldPath ?? e.path, side: 'base' } : e?.status === 'A' ? { path: e.path, side: 'head' } : undefined;
}

/**
 * VS Code's own `git:` documents (the left side of Source Control and Git Tree Compare diffs): the query is JSON with
 * the file's `path` and a `ref`. Only the comparison's own commits are sides: the merge-base is the base side, and in
 * committed mode (`headSha` given) HEAD's commit is the head side. Anything else (`~` and `''` for the index, `HEAD`,
 * another commit) is a different version of the file than either side: undefined.
 */
export function vscodeGitSideKey(query: string, rel: (fsPath: string) => string | undefined, mergeBase: string, headSha?: string): SideKey | undefined {
  try {
    const q = JSON.parse(query) as { path?: unknown; ref?: unknown };
    const p = typeof q.path === 'string' ? rel(q.path) : undefined;
    if (!p || typeof q.ref !== 'string') return undefined;
    if (q.ref === mergeBase) return { path: p, side: 'base' };
    if (headSha && q.ref === headSha) return { path: p, side: 'head' };
    return undefined;
  } catch {
    return undefined;
  }
}

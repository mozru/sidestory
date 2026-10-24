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
export function gitSideKey<R>(g: { repo: R; sha: string; path: string } | undefined, s: { repo: R; mergeBase: string }): SideKey | undefined {
  if (!g || g.repo !== s.repo) return undefined;
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

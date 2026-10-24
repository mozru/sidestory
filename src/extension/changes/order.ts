// The order Next/Previous Unexplained Change and Next/Previous Changed File walk (docs/CHANGES-PLAN.md §9.3), with no
// tree to follow: files in the belonging sidestory's step order first (the order its steps first touch them, so the
// unexplained changes come up where the reader already is), then the rest in repo path order; within a file, by line.
// The walk starts from the active editor (a diff side or a plain editor of a changed file), else from the first.
// Pure: no vscode import.
import { comparePaths } from './model.ts';

export interface OpenChange {
  /** The file's head path. */
  path: string;
  key: string;
  /** Its place on the new side (a pure deletion: the line it sits before). */
  pos: number;
}

/**
 * A change's place in the walk: changes with no lines (a move, a whole-file change) sit at 0, before line 1, where a
 * cursor in a file with no lines is too; any other at its first new line (a pure deletion: the line it sits before).
 */
export function walkPos(b: { move?: unknown; new: { start: number } | null; newAt: number }, whole: boolean): number {
  return b.move || whole ? 0 : (b.new?.start ?? b.newAt);
}

/** Rank per path: `first` (deduplicated, in order) before the rest by path. */
export function fileRanks(paths: readonly string[], first: readonly string[] = []): Map<string, number> {
  const rank = new Map<string, number>();
  const known = new Set(paths);
  for (const p of first) if (known.has(p) && !rank.has(p)) rank.set(p, rank.size);
  for (const p of [...paths].sort(comparePaths)) if (!rank.has(p)) rank.set(p, rank.size);
  return rank;
}

/** The changes in walking order. */
export function orderChanges(list: readonly OpenChange[], rank: ReadonlyMap<string, number>): OpenChange[] {
  const r = (p: string) => rank.get(p) ?? Number.MAX_SAFE_INTEGER;
  return [...list].sort((a, b) => r(a.path) - r(b.path) || a.pos - b.pos || byKey(a.key, b.key));
}

const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The change after (or before) the place `at`, wrapping; with no place (the active editor isn't a changed file), the
 * first (or the last). `wrapped` says it went round. With `at.key` (the last change walked to), changes at the same
 * position are told apart by key, so two stops at one place (a move and a line-1 edit) are both visited.
 */
export function nextChange(list: readonly OpenChange[], rank: ReadonlyMap<string, number>, at: { path: string; pos: number; key?: string } | undefined, dir: 1 | -1): { target: OpenChange; wrapped: boolean } | undefined {
  const sorted = orderChanges(list, rank);
  if (!sorted.length) return undefined;
  if (!at || !rank.has(at.path)) return { target: dir === 1 ? sorted[0]! : sorted.at(-1)!, wrapped: false };
  const r = (p: string) => rank.get(p) ?? Number.MAX_SAFE_INTEGER;
  const cmp = (x: OpenChange) => r(x.path) - r(at.path) || x.pos - at.pos || (at.key !== undefined ? byKey(x.key, at.key) : 0);
  const found = dir === 1 ? sorted.find((x) => cmp(x) > 0) : [...sorted].reverse().find((x) => cmp(x) < 0);
  if (found) return { target: found, wrapped: false };
  return { target: dir === 1 ? sorted[0]! : sorted.at(-1)!, wrapped: true };
}

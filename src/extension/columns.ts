// Which editor group shows an explainer's code. No VS Code API here, so it can be unit tested.

/** What an editor group shows on top. */
export interface GroupView {
  /** The group's view column (1-based). */
  column: number;
  /** The visible tab: a text editor and its URI, a diff editor and its two sides, an explainer panel, something else, or nothing. */
  shows: { kind: 'text'; uri: string } | { kind: 'diff'; original: string; modified: string } | { kind: 'explainer' } | { kind: 'other' } | undefined;
}

/**
 * The column to open `uri` in, so code never covers a visible explainer (this one or another): a group already
 * showing the same diff (docs/CHANGES-PLAN.md §7.4: `diff` names its two sides), else a group showing the file
 * (alone or as either side of a diff), else a group showing other code or a diff, else any group not showing an
 * explainer, else a new group after the last one.
 */
export function codeColumnFor(groups: readonly GroupView[], panelColumn: number | undefined, uri: string, diff?: { original: string; modified: string }): number {
  const usable = groups.filter((g) => g.column !== panelColumn && g.shows?.kind !== 'explainer');
  const sameDiff = diff ? usable.find((g) => g.shows?.kind === 'diff' && g.shows.original === diff.original && g.shows.modified === diff.modified) : undefined;
  const same = usable.find((g) => (g.shows?.kind === 'text' && g.shows.uri === uri) || (g.shows?.kind === 'diff' && (g.shows.original === uri || g.shows.modified === uri)));
  const code = usable.find((g) => g.shows?.kind === 'text' || g.shows?.kind === 'diff');
  const pick = sameDiff ?? same ?? code ?? usable[0];
  if (pick) return pick.column;
  // VS Code has at most 9 numbered columns; past that, the last one.
  return Math.min(9, Math.max(0, panelColumn ?? 0, ...groups.map((g) => g.column)) + 1);
}

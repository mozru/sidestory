// Which editor group shows an explainer's code. No VS Code API here, so it can be unit tested.

/** What an editor group shows on top. */
export interface GroupView {
  /** The group's view column (1-based). */
  column: number;
  /** The visible tab: a text editor and its URI, an explainer panel, something else, or nothing. */
  shows: { kind: 'text'; uri: string } | { kind: 'explainer' } | { kind: 'other' } | undefined;
}

/**
 * The column to open `uri` in, so code never covers a visible explainer (this one or another):
 * a group already showing the file, else a group showing other code, else any group not showing an
 * explainer, else a new group after the last one.
 */
export function codeColumnFor(groups: readonly GroupView[], panelColumn: number | undefined, uri: string): number {
  const usable = groups.filter((g) => g.column !== panelColumn && g.shows?.kind !== 'explainer');
  const same = usable.find((g) => g.shows?.kind === 'text' && g.shows.uri === uri);
  const code = usable.find((g) => g.shows?.kind === 'text');
  const pick = same ?? code ?? usable[0];
  if (pick) return pick.column;
  // VS Code has at most 9 numbered columns; past that, the last one.
  return Math.min(9, Math.max(0, panelColumn ?? 0, ...groups.map((g) => g.column)) + 1);
}

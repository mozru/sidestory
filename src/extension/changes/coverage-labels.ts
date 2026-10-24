// The coverage layer's words and marks (docs/CHANGES-PLAN.md §9.6): file marks as text (descriptions can't be
// coloured, and text reads the same in every theme and to screen readers), their accessibility labels, the file
// tooltip's list of unexplained changes, change item labels and icons, and the totals. Pure: no vscode import.
import type { ChangeCoverage, ChangeState, FileCoverage, Totals } from '../../core/coverage.ts';
import type { ChangeBlock } from '../../core/hunks.ts';
import type { LineRange } from '../../core/manifest.ts';

const span = (r: LineRange) => (r.start === r.end ? `${r.start}` : `${r.start}–${r.end}`);

/** Done means explained or trivial (§6.3). */
export const isDone = (s: ChangeState) => s === 'explained' || s === 'trivial';

/** `✓`, `✓ · 1 trivial`, `– trivial`, `◐ 2/3`, `○`, `!` (something needs a look). Undefined: nothing to count. */
export function fileMark(f: FileCoverage): string | undefined {
  const n = f.changes.length;
  if (!n) return undefined;
  if (f.needsLook) return '!';
  if (f.left === 0) {
    if (f.explained === 0) return '– trivial';
    return f.trivial ? `✓ · ${f.trivial} trivial` : '✓';
  }
  if (f.explained + f.trivial === 0) return '○';
  return `◐ ${f.explained}/${n}`;
}

/** What a screen reader says for the mark: "2 of 3 changes explained, 1 marked trivial". */
export function fileMarkLabel(f: FileCoverage): string {
  const n = f.changes.length;
  const parts = [`${f.explained} of ${n} ${n === 1 ? 'change' : 'changes'} explained`];
  if (f.trivial) parts.push(`${f.trivial} marked trivial`);
  if (f.needsLook) parts.push(`${f.needsLook} changed since the step was written`);
  return parts.join(', ');
}

/** A change's place: `L40–44` on the new side, `L39–62 (removed)` for a pure deletion (old lines). */
export function changeLabel(b: ChangeBlock): string {
  if (b.new) return `L${span(b.new)}`;
  return b.old ? `L${span(b.old)} (removed)` : `L${b.newAt}`;
}

export function changeCounts(b: ChangeBlock): string {
  return [b.added ? `+${b.added}` : '', b.removed ? `−${b.removed}` : ''].filter(Boolean).join(' ');
}

/** The kind the "Explain This Change" prompt names. */
export const changeKind = (b: ChangeBlock): 'added' | 'removed' | 'replaced' => (b.added && b.removed ? 'replaced' : b.added ? 'added' : 'removed');

/** The words for a change's state, as the file tooltip lists them. */
export function stateWords(c: ChangeCoverage): string {
  switch (c.state) {
    case 'explained':
      return c.stale ? 'explained, may be out of date' : c.broad ? 'explained by a broad step' : 'explained';
    case 'trivial':
      return c.why?.length ? `marked trivial: ${c.why[0]}` : 'marked trivial';
    case 'needsLook':
      return 'changed since the step was written';
    case 'partly': {
      const left = c.uncovered.map((u) => `${span(u.range)}${u.side === 'base' ? ' removed' : ''}`).join(', ');
      return `partly (${left} left)`;
    }
    default:
      return 'not explained';
  }
}

/** The tooltip's lines for a file: each change that isn't done ("L40–44 (+5): not explained"). */
export function hunkLines(f: FileCoverage, blocks: ReadonlyMap<string, ChangeBlock>, max = 20): string[] {
  const out: string[] = [];
  const open = f.changes.filter((c) => !isDone(c.state));
  for (const c of open.slice(0, max)) {
    const b = blocks.get(c.key);
    if (!b) continue;
    const counts = changeCounts(b);
    out.push(`${changeLabel(b)}${c.state === 'partly' ? '' : counts ? ` (${counts})` : ''}: ${stateWords(c)}`);
  }
  if (open.length > max) out.push(`and ${open.length - max} more`);
  return out;
}

/** The codicon for a change item (§9.6), and whether it takes the unexplained colour. */
export function changeIcon(c: ChangeCoverage): { id: string; colored?: boolean } {
  switch (c.state) {
    case 'explained':
      return { id: c.stale || c.broad ? 'warning' : 'check' };
    case 'trivial':
      return { id: 'dash' };
    case 'needsLook':
      return { id: 'diff-modified' };
    case 'partly':
      return { id: 'circle-large-filled', colored: true };
    default:
      return { id: 'circle-large-outline' };
  }
}

/** `9 explained · 3 trivial · 0 left`. */
export function totalsLabel(t: Totals): string {
  return `${t.explained} explained · ${t.trivial} trivial · ${t.left} left`;
}

/** Folders: "· 2 left" over the files below. */
export function folderLeft(files: readonly (FileCoverage | undefined)[]): number {
  return files.reduce((n, f) => n + (f?.left ?? 0), 0);
}

import type { LineRange, Norm, Quote } from './manifest.ts';
import { LIMITS } from './manifest.ts';

const CONTEXT_LINES = 3;
const CONTEXT_CHARS = 160;

/**
 * Records the anchored text and its surroundings, so the anchor can be found again after edits.
 * Blank lines at either edge of the range are left out (they become context): see `trimBlankLines`.
 * Returns null for a range outside the text, one with nothing but blank lines, or one too big to store.
 */
export function pinQuote(lines: readonly string[], range: LineRange, norm: Norm = 'ws'): Quote | null {
  const trimmed = trimBlankLines(lines, range);
  if (!trimmed) return null;
  const s = trimmed.start - 1;
  const exactLines = lines.slice(s, trimmed.end);
  if (exactLines.length > LIMITS.quoteLines || exactLines.join('\n').length > LIMITS.quoteChars) return null;
  const before = lines.slice(Math.max(0, s - CONTEXT_LINES), s).reverse();
  const after = lines.slice(trimmed.end, trimmed.end + CONTEXT_LINES);
  return { exact: exactLines.join('\n'), prefix: nearest(before).reverse().join('\n'), suffix: nearest(after).join('\n'), norm };
}

/** Whole context lines, nearest first, up to about CONTEXT_CHARS (always at least one line). */
function nearest(linesNearestFirst: readonly string[]): string[] {
  const out: string[] = [];
  let used = 0;
  for (const l of linesNearestFirst) {
    if (out.length > 0 && used + l.length > CONTEXT_CHARS) break;
    out.push(l.slice(0, 1000));
    used += l.length + 1;
  }
  return out;
}

/**
 * The range without blank lines at its edges (clipped to the text): what `pinQuote` quotes, so the
 * range to store beside the quote. Null for a range outside the text or with nothing but blank lines.
 */
export function trimBlankLines(lines: readonly string[], range: LineRange): LineRange | null {
  if (range.start < 1 || range.end < range.start || range.start > lines.length) return null;
  let start = range.start;
  let end = Math.min(range.end, lines.length);
  while (start <= end && lines[start - 1]!.trim() === '') start++;
  while (end >= start && lines[end - 1]!.trim() === '') end--;
  return start <= end ? { start, end } : null;
}

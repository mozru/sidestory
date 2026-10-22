import type { LineRange, Norm, Quote } from './manifest.ts';
import { LIMITS } from './manifest.ts';

const CONTEXT_LINES = 3;
const CONTEXT_CHARS = 160;

/**
 * Records the anchored text and its surroundings, so the anchor can be found again after edits.
 * Returns null for a range outside the text, one with nothing but blank lines, or one too big to store.
 */
export function pinQuote(lines: readonly string[], range: LineRange, norm: Norm = 'ws'): Quote | null {
  if (range.start < 1 || range.end < range.start || range.start > lines.length) return null;
  const s = range.start - 1;
  const exactLines = lines.slice(s, range.end);
  if (exactLines.every((l) => l.trim() === '')) return null;
  if (exactLines.length > LIMITS.quoteLines || exactLines.join('\n').length > LIMITS.quoteChars) return null;
  const before = lines.slice(Math.max(0, s - CONTEXT_LINES), s).reverse();
  const after = lines.slice(range.end, range.end + CONTEXT_LINES);
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

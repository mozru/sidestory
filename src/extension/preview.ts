// The hover card's code (`sidestory.hoverPreview`): the first lines of a link's range, as the panel shows them.
import type { LineRange } from '../core/manifest.ts';
import { PREVIEW_LINE_CHARS, PREVIEW_LINES } from '../shared/protocol.ts';

/**
 * Lines `range` of `text` (1-based, clamped to the text), at most PREVIEW_LINES of them, with their common
 * indentation removed and each cut at PREVIEW_LINE_CHARS; `more` counts the range's lines left out. Undefined when
 * the range starts past the end. Copies only the lines shown.
 */
export function previewLines(text: string, range: LineRange): { start: number; end: number; lines: string[]; more: number } | undefined {
  const lines: string[] = [];
  let line = 1;
  let at = 0;
  const next = (from: number) => {
    const m = /\r\n|\r|\n/g;
    m.lastIndex = from;
    const hit = m.exec(text);
    return hit ? { end: hit.index, after: hit.index + hit[0].length } : { end: text.length, after: -1 };
  };
  while (line < range.start) {
    const n = next(at);
    if (n.after < 0) return undefined;
    at = n.after;
    line++;
  }
  let end = line;
  for (;;) {
    const n = next(at);
    // Past the lines shown, the rest is only counted.
    if (lines.length < PREVIEW_LINES) lines.push(text.slice(at, n.end));
    end = line;
    if (n.after < 0 || line >= range.end) break;
    at = n.after;
    line++;
  }
  const indent = commonIndent(lines);
  return { start: range.start, end, lines: lines.map((l) => l.slice(indent).slice(0, PREVIEW_LINE_CHARS).trimEnd()), more: end - range.start + 1 - lines.length };
}

/** The length of the whitespace every non-blank line starts with (the same characters, so tabs and spaces don't mix). */
function commonIndent(lines: string[]): number {
  let prefix: string | undefined;
  for (const l of lines) {
    if (!/\S/.test(l)) continue;
    const own = /^[ \t]*/.exec(l)![0];
    if (prefix === undefined) prefix = own;
    else {
      let i = 0;
      while (i < prefix.length && i < own.length && prefix[i] === own[i]) i++;
      prefix = prefix.slice(0, i);
    }
    if (prefix === '') return 0;
  }
  return prefix?.length ?? 0;
}

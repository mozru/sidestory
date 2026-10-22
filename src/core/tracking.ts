// Moves a line range through text edits as they happen, the way editor decorations move.
import type { LineRange } from './manifest.ts';

/** A position: 1-based line, 0-based column. */
export interface Pos {
  line: number;
  col: number;
}

export interface TextEdit {
  /** Start and end of the replaced text, in the document before the edit. */
  start: Pos;
  end: Pos;
  text: string;
  /**
   * Characters that followed `end` on its line before the edit (0 = the edit ends at the end of
   * the line). Lets us tell "replaced the whole range" from "replaced most of it". Optional.
   */
  endTail?: number;
}

export interface Tracked {
  range: LineRange;
  /** The edit replaced every line of the range. */
  orphaned: boolean;
}

const atOrBefore = (a: Pos, b: Pos) => a.line < b.line || (a.line === b.line && a.col <= b.col);
const NEWLINE = /\r\n|\r|\n/g;

export function trackRange(range: LineRange, edit: TextEdit): Tracked {
  const removed = edit.end.line - edit.start.line;
  const added = (edit.text.match(NEWLINE) ?? []).length;
  const delta = added - removed;
  const startsRange: Pos = { line: range.start, col: 0 };
  const endsAtLineEnd = edit.endTail === 0;

  // Entirely above, or exactly at column 0 of the first line: shift.
  if (atOrBefore(edit.end, startsRange)) return { range: { start: range.start + delta, end: range.end + delta }, orphaned: false };
  // Entirely below.
  if (edit.start.line > range.end) return { range, orphaned: false };
  // Enter at the very end of the last line (possibly replacing trailing text): new lines go below the range.
  if (edit.start.line === range.end && edit.end.line === range.end && endsAtLineEnd && /^(\r\n|\r|\n)/.test(edit.text)) {
    return { range, orphaned: false };
  }

  // The last line that holds inserted text. If the edit ends at column 0 after a line break,
  // that line is the old line after the edit, not part of what was inserted.
  const spills = edit.end.line > edit.start.line && edit.end.col === 0 && (/(\r\n|\r|\n)$/.test(edit.text) || (edit.text === '' && edit.start.col === 0));
  const insertedEnd = edit.start.line + added - (spills ? 1 : 0);
  const coversLastLine = edit.end.line > range.end || (edit.end.line === range.end && endsAtLineEnd);

  if (atOrBefore(edit.start, startsRange) && coversLastLine) {
    // Every line of the range was replaced. Follow the new text, but flag it.
    return { range: { start: edit.start.line, end: Math.max(edit.start.line, insertedEnd) }, orphaned: true };
  }
  const startsBefore = !atOrBefore(startsRange, edit.start);
  // Starts above the range and ends inside it: the surviving lines follow the inserted text.
  const start = startsBefore ? edit.start.line + added : range.start;
  // Ends below the range: the range now ends where the inserted text ends.
  const end = edit.end.line > range.end ? insertedEnd : range.end + delta;
  return { range: { start, end: Math.max(start, end) }, orphaned: false };
}

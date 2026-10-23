// Where each pinned anchor's quote sits in manifest.json (docs/NAVIGATION-PLAN.md §7.2), so the workspace
// index can later read just those bytes instead of whole manifests. A linear, non-recursive scan over JSON
// that `JSON.parse` already accepted; it keeps the *last* occurrence of a duplicate key, as `JSON.parse` does.
// Offsets are UTF-8 byte offsets into the file (after `bomBytes`), not string indices.
import type { Quote } from './manifest.ts';

export interface QuoteSpan {
  /** Byte offset of the quote object's source text in the file. */
  offset: number;
  /** Its length in bytes. */
  length: number;
}

/** Spans of `anchors.<id>.quote` values, by anchor id. Empty when the text isn't shaped like a manifest. */
export function quotePositions(json: string, bomBytes = 0): Map<string, QuoteSpan> {
  const chars = new Map<string, { start: number; end: number }>();
  const s = json;
  let i = 0;
  const ws = () => {
    while (i < s.length) {
      const c = s.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 0xfeff) i++;
      else break;
    }
  };
  /** Reads a string at `i` (which is at its opening quote); returns its raw text, decoded. */
  const str = (): string => {
    const start = i + 1;
    let j = start;
    let escaped = false;
    for (; j < s.length; j++) {
      const c = s.charCodeAt(j);
      if (c === 92) {
        escaped = true;
        j++;
      } else if (c === 34) break;
    }
    const raw = s.slice(start, j);
    i = j + 1;
    if (!escaped) return raw;
    try {
      return JSON.parse(`"${raw}"`) as string;
    } catch {
      return raw;
    }
  };
  /** Skips one value at `i`, iteratively (nesting depth costs nothing). */
  const skip = () => {
    ws();
    const c = s[i];
    if (c === '"') {
      str();
      return;
    }
    if (c !== '{' && c !== '[') {
      while (i < s.length && !/[,}\]\s]/.test(s[i]!)) i++;
      return;
    }
    let depth = 0;
    while (i < s.length) {
      const d = s[i];
      if (d === '"') {
        str();
        continue;
      }
      if (d === '{' || d === '[') depth++;
      else if (d === '}' || d === ']') {
        depth--;
        if (depth === 0) {
          i++;
          return;
        }
      }
      i++;
    }
  };
  /** Iterates an object's members at `i`, calling `member(key)` positioned at the value; it must consume it. */
  const object = (member: (key: string) => void) => {
    ws();
    if (s[i] !== '{') {
      skip();
      return;
    }
    i++;
    for (;;) {
      ws();
      if (s[i] === '}') {
        i++;
        return;
      }
      if (s[i] !== '"') return; // not JSON after all
      const key = str();
      ws();
      if (s[i] !== ':') return;
      i++;
      ws();
      member(key);
      ws();
      if (s[i] === ',') i++;
      else if (s[i] === '}') {
        i++;
        return;
      } else return;
    }
  };

  object((key) => {
    if (key !== 'anchors') return skip();
    chars.clear(); // a later "anchors" replaces an earlier one, as in JSON.parse
    object((id) => {
      ws();
      if (s[i] !== '{') {
        chars.delete(id);
        return skip();
      }
      let span: { start: number; end: number } | undefined;
      object((field) => {
        if (field !== 'quote') return skip();
        const start = i;
        skip();
        span = { start, end: i };
      });
      if (span) chars.set(id, span);
      else chars.delete(id);
    });
  });

  // Character offsets to UTF-8 byte offsets, in one pass over the text.
  const marks = [...new Set([...chars.values()].flatMap((c) => [c.start, c.end]))].sort((a, b) => a - b);
  const bytesAt = new Map<number, number>();
  let bytes = bomBytes;
  let k = 0;
  for (let p = 0; p <= s.length && k < marks.length; p++) {
    while (k < marks.length && marks[k] === p) bytesAt.set(marks[k++]!, bytes);
    if (p === s.length) break;
    const c = s.charCodeAt(p);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && p + 1 < s.length && (s.charCodeAt(p + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      p++;
    } else bytes += 3;
  }
  const out = new Map<string, QuoteSpan>();
  for (const [id, c] of chars) {
    const a = bytesAt.get(c.start);
    const b = bytesAt.get(c.end);
    if (a !== undefined && b !== undefined) out.set(id, { offset: a, length: b - a });
  }
  return out;
}

/** A short hash of a parsed quote, to tell a slice that still holds the same quote from one that doesn't. */
export function quoteHash(q: Quote): number {
  let h = 0x811c9dc5;
  for (const part of [q.exact, '\u0000', q.prefix, '\u0000', q.suffix, '\u0000', q.norm]) {
    for (let i = 0; i < part.length; i++) {
      h ^= part.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  }
  return h | 0;
}

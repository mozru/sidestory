// What a change is (docs/CHANGES-PLAN.md §5.2) and the line maps between the two sides of a diff (§5.3), computed
// by our own code from the two texts so the extension and the checker agree to the line, whatever diff.algorithm
// the user configured. Pure: no vscode or node import, shared by both.
//
// The diff is Myers' algorithm in linear space (the bisecting middle-snake recursion: memory O(N + M), never
// O(D²)) over interned line ids, after trimming the common head and tail. Its work has a deterministic budget, the
// same everywhere: past 5,000 lines of edit distance or 5×10⁷ snake steps the file is one change spanning both
// sides, so a slow machine never changes the answer.
import type { LineRange } from './manifest.ts';

export const DIFF_LIMITS = {
  maxEditDistance: 5000,
  maxSnakeSteps: 50_000_000,
  maxBytes: 2 * 1024 * 1024,
  maxLines: 50_000,
  /** Change blocks separated by at most this many unchanged lines are one change (§5.2 step 6). */
  mergeGap: 1,
} as const;

// ---- decoding (§5.2 step 2) ----

/**
 * Decodes both sides the same way: UTF-8 with a leading BOM dropped, or, when either side isn't valid UTF-8, both
 * as Latin-1 (byte for byte). So a BOM or an editor encoding never makes a file "all changed". A missing side
 * (an added or deleted file) decodes to the empty string.
 */
export function decodePair(oldBytes: Uint8Array | undefined, newBytes: Uint8Array | undefined): { old: string; new: string; latin1: boolean } {
  const a = oldBytes ? decodeUtf8(oldBytes) : '';
  const b = newBytes ? decodeUtf8(newBytes) : '';
  if (a !== undefined && b !== undefined) return { old: a, new: b, latin1: false };
  return { old: oldBytes ? decodeLatin1(oldBytes) : '', new: newBytes ? decodeLatin1(newBytes) : '', latin1: true };
}

/** Strict UTF-8 (no overlongs, surrogates or code points past U+10FFFF), a leading BOM dropped; undefined when invalid. */
export function decodeUtf8(bytes: Uint8Array): string | undefined {
  let i = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  const n = bytes.length;
  const parts: string[] = [];
  const units: number[] = [];
  const flush = () => {
    if (units.length) parts.push(String.fromCharCode.apply(null, units));
    units.length = 0;
  };
  while (i < n) {
    const c = bytes[i]!;
    let cp: number;
    if (c < 0x80) {
      cp = c;
      i += 1;
    } else if (c >= 0xc2 && c <= 0xdf) {
      const c1 = bytes[i + 1];
      if (c1 === undefined || (c1 & 0xc0) !== 0x80) return undefined;
      cp = ((c & 0x1f) << 6) | (c1 & 0x3f);
      i += 2;
    } else if (c >= 0xe0 && c <= 0xef) {
      const c1 = bytes[i + 1];
      const c2 = bytes[i + 2];
      if (c1 === undefined || c2 === undefined || (c1 & 0xc0) !== 0x80 || (c2 & 0xc0) !== 0x80) return undefined;
      if ((c === 0xe0 && c1 < 0xa0) || (c === 0xed && c1 > 0x9f)) return undefined; // overlong, surrogate
      cp = ((c & 0x0f) << 12) | ((c1 & 0x3f) << 6) | (c2 & 0x3f);
      i += 3;
    } else if (c >= 0xf0 && c <= 0xf4) {
      const c1 = bytes[i + 1];
      const c2 = bytes[i + 2];
      const c3 = bytes[i + 3];
      if (c1 === undefined || c2 === undefined || c3 === undefined || (c1 & 0xc0) !== 0x80 || (c2 & 0xc0) !== 0x80 || (c3 & 0xc0) !== 0x80) return undefined;
      if ((c === 0xf0 && c1 < 0x90) || (c === 0xf4 && c1 > 0x8f)) return undefined; // overlong, past U+10FFFF
      cp = ((c & 0x07) << 18) | ((c1 & 0x3f) << 12) | ((c2 & 0x3f) << 6) | (c3 & 0x3f);
      i += 4;
    } else return undefined;
    if (cp > 0xffff) {
      cp -= 0x10000;
      units.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    } else units.push(cp);
    if (units.length >= 8192) flush();
  }
  flush();
  return parts.join('');
}

export function decodeLatin1(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 8192) parts.push(String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 8192))));
  return parts.join('');
}

// ---- changes ----

export interface ChangeBlock {
  /** §5.2's content key: a hash of (path, the removed and added lines, the ordinal among changes with the same text). No line numbers. */
  key: string;
  /** The removed lines' span on the old side (1-based, inclusive); null when nothing was removed. */
  old: LineRange | null;
  /** The added lines' span on the new side; null when nothing was added. */
  new: LineRange | null;
  /** The removed lines themselves (an unchanged line merged into the change isn't in them). */
  removedRuns: LineRange[];
  addedRuns: LineRange[];
  added: number;
  removed: number;
  /**
   * The old-side line the change starts at; for a pure addition, the old line it sits before (1..oldLines+1). With
   * `oldLen`, the change's whole region on the old side, merged unchanged lines included.
   */
  oldAt: number;
  /** The new-side line the change starts at; for a pure deletion, the new line it sits before (1..newLines+1). */
  newAt: number;
  /** Lines of the change's region on each side (removed or added lines plus merged unchanged ones). */
  oldLen: number;
  newLen: number;
}

export interface FileDiff {
  changes: ChangeBlock[];
  /** 'budget' | 'size': too large to compare line by line, so one change spans both sides. */
  tooLarge?: 'budget' | 'size';
  /** Only line endings (or a final newline) differ: no changes, listed as "line endings only". */
  lineEndingsOnly: boolean;
  oldLines: number;
  newLines: number;
}

/** A text's lines after §5.2 step 3: `\r\n` and `\r` become `\n`, and a final newline ends the last line rather than starting an empty one. */
export function textLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** Raised inside the diff when its budget runs out; never escapes `diffTexts`. */
class OverBudget extends Error {}

/** The changes between two texts of the file at `path` (its new path; it seeds the content keys). */
export function diffTexts(path: string, oldText: string, newText: string): FileDiff {
  if (oldText === newText) return { changes: [], lineEndingsOnly: false, oldLines: textLines(oldText).length, newLines: textLines(newText).length };
  const tooBig = (t: string) => utf8Length(t) > DIFF_LIMITS.maxBytes;
  if (tooBig(oldText) || tooBig(newText)) return wholeFile(path, oldText, newText, 'size');
  const a = textLines(oldText);
  const b = textLines(newText);
  if (a.length > DIFF_LIMITS.maxLines || b.length > DIFF_LIMITS.maxLines) return wholeFile(path, oldText, newText, 'size', a, b);

  // Interned line ids: equal lines compare as equal numbers.
  const ids = new Map<string, number>();
  const intern = (lines: string[]) => {
    const out = new Int32Array(lines.length);
    for (let i = 0; i < lines.length; i++) {
      let id = ids.get(lines[i]!);
      if (id === undefined) ids.set(lines[i]!, (id = ids.size));
      out[i] = id;
    }
    return out;
  };
  const x = intern(a);
  const y = intern(b);
  // trimCommon, on the typed arrays: the common head and tail never enter the search.
  let head = 0;
  while (head < x.length && head < y.length && x[head] === y[head]) head++;
  if (head === x.length && head === y.length) return { changes: [], lineEndingsOnly: true, oldLines: a.length, newLines: b.length };
  let tail = 0;
  while (tail < x.length - head && tail < y.length - head && x[x.length - 1 - tail] === y[y.length - 1 - tail]) tail++;

  // The edit script as two flags arrays: removed[i] for old line i, added[j] for new line j (0-based).
  const removed = new Uint8Array(x.length);
  const added = new Uint8Array(y.length);
  const myers = new Myers(x, y, removed, added);
  try {
    myers.diff(head, x.length - tail, head, y.length - tail);
  } catch (e) {
    if (e instanceof OverBudget) return wholeFile(path, oldText, newText, 'budget', a, b);
    throw e;
  }
  if (myers.edits > DIFF_LIMITS.maxEditDistance) return wholeFile(path, oldText, newText, 'budget', a, b);
  return { changes: blocks(path, a, b, removed, added), lineEndingsOnly: false, oldLines: a.length, newLines: b.length };
}

function utf8Length(s: string): number {
  let n = s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x80) n += c >= 0x800 && (c < 0xd800 || c > 0xdfff) ? 2 : 1;
  }
  return n;
}

function wholeFile(path: string, oldText: string, newText: string, why: 'budget' | 'size', a = textLines(oldText), b = textLines(newText)): FileDiff {
  const old = a.length ? { start: 1, end: a.length } : null;
  const nu = b.length ? { start: 1, end: b.length } : null;
  const change: ChangeBlock = {
    key: contentKey(path, a, b, 0),
    old,
    new: nu,
    removedRuns: old ? [old] : [],
    addedRuns: nu ? [nu] : [],
    added: b.length,
    removed: a.length,
    oldAt: 1,
    newAt: 1,
    oldLen: a.length,
    newLen: b.length,
  };
  return { changes: [change], tooLarge: why, lineEndingsOnly: false, oldLines: a.length, newLines: b.length };
}

/**
 * Myers' O((N+M)·D) algorithm in linear space, bisecting at a middle snake (as diff-match-patch's `bisect`) and
 * recursing on both halves. `steps` counts diagonal visits and snake slides; past the budget it throws OverBudget.
 * `edits` is the total edit distance found.
 */
class Myers {
  steps = 0;
  edits = 0;
  private readonly x: Int32Array;
  private readonly y: Int32Array;
  private readonly removed: Uint8Array;
  private readonly added: Uint8Array;
  constructor(x: Int32Array, y: Int32Array, removed: Uint8Array, added: Uint8Array) {
    this.x = x;
    this.y = y;
    this.removed = removed;
    this.added = added;
  }

  diff(aLo: number, aHi: number, bLo: number, bHi: number): void {
    // An explicit stack, not recursion: a hostile file can't overflow the call stack.
    const stack: number[] = [aLo, aHi, bLo, bHi];
    while (stack.length) {
      let bh = stack.pop()!;
      let bl = stack.pop()!;
      let ah = stack.pop()!;
      let al = stack.pop()!;
      // Common head and tail of this part.
      while (al < ah && bl < bh && this.x[al] === this.y[bl]) al++, bl++;
      while (al < ah && bl < bh && this.x[ah - 1] === this.y[bh - 1]) ah--, bh--;
      if (al === ah || bl === bh) {
        for (let i = al; i < ah; i++) this.removed[i] = 1;
        for (let j = bl; j < bh; j++) this.added[j] = 1;
        this.edits += ah - al + (bh - bl);
        if (this.edits > DIFF_LIMITS.maxEditDistance) throw new OverBudget();
        continue;
      }
      const split = this.bisect(al, ah, bl, bh);
      if (!split) {
        // No common line at all: everything in this part is replaced.
        for (let i = al; i < ah; i++) this.removed[i] = 1;
        for (let j = bl; j < bh; j++) this.added[j] = 1;
        this.edits += ah - al + (bh - bl);
        if (this.edits > DIFF_LIMITS.maxEditDistance) throw new OverBudget();
        continue;
      }
      stack.push(split[0], ah, split[1], bh, al, split[0], bl, split[1]);
    }
  }

  /** The middle snake's start (old, new indices) of x[al..ah) vs y[bl..bh), or undefined when nothing is common. */
  private bisect(al: number, ah: number, bl: number, bh: number): [number, number] | undefined {
    const x = this.x;
    const y = this.y;
    const n = ah - al;
    const m = bh - bl;
    // Half the edit distance bounds the search; beyond the budget's half the whole diff is over budget anyway.
    const maxD = Math.min(Math.ceil((n + m) / 2), Math.ceil(DIFF_LIMITS.maxEditDistance / 2) + 1);
    const off = maxD + 1;
    const len = 2 * off + 1;
    const v1 = new Int32Array(len).fill(-1);
    const v2 = new Int32Array(len).fill(-1);
    v1[off + 1] = 0;
    v2[off + 1] = 0;
    const delta = n - m;
    const front = (delta & 1) !== 0;
    let k1start = 0;
    let k1end = 0;
    let k2start = 0;
    let k2end = 0;
    for (let d = 0; d < maxD; d++) {
      for (let k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
        const k1o = off + k1;
        let x1 = k1 === -d || (k1 !== d && v1[k1o - 1]! < v1[k1o + 1]!) ? v1[k1o + 1]! : v1[k1o - 1]! + 1;
        let y1 = x1 - k1;
        const from = x1;
        while (x1 < n && y1 < m && x[al + x1] === y[bl + y1]) x1++, y1++;
        this.spend(1 + x1 - from);
        v1[k1o] = x1;
        if (x1 > n) k1end += 2;
        else if (y1 > m) k1start += 2;
        else if (front) {
          const k2o = off + delta - k1;
          if (k2o >= 0 && k2o < len && v2[k2o] !== -1) {
            if (x1 >= n - v2[k2o]!) return [al + x1, bl + y1];
          }
        }
      }
      for (let k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
        const k2o = off + k2;
        let x2 = k2 === -d || (k2 !== d && v2[k2o - 1]! < v2[k2o + 1]!) ? v2[k2o + 1]! : v2[k2o - 1]! + 1;
        let y2 = x2 - k2;
        const from = x2;
        while (x2 < n && y2 < m && x[ah - 1 - x2] === y[bh - 1 - y2]) x2++, y2++;
        this.spend(1 + x2 - from);
        v2[k2o] = x2;
        if (x2 > n) k2end += 2;
        else if (y2 > m) k2start += 2;
        else if (!front) {
          const k1o = off + delta - k2;
          if (k1o >= 0 && k1o < len && v1[k1o] !== -1) {
            const x1 = v1[k1o]!;
            const y1 = x1 - (k1o - off);
            if (x1 >= n - x2) return [al + x1, bl + y1];
          }
        }
      }
    }
    // The search ran to its bound: either nothing is common (n + m small) or the distance is past the budget.
    if (maxD < Math.ceil((n + m) / 2)) throw new OverBudget();
    return undefined;
  }

  private spend(n: number) {
    this.steps += n;
    if (this.steps > DIFF_LIMITS.maxSnakeSteps) throw new OverBudget();
  }
}

/** Runs of removed and added lines, merged across at most `mergeGap` unchanged lines, with their keys. */
function blocks(path: string, a: string[], b: string[], removed: Uint8Array, added: Uint8Array): ChangeBlock[] {
  // Raw blocks: maximal runs with no unchanged line, as [i0, i1) on the old side and [j0, j1) on the new.
  const raw: [number, number, number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && !removed[i] && !added[j]) {
      i++, j++;
      continue;
    }
    // A valid script never leaves unchanged lines on one side only; stop rather than loop if it did.
    if (!(i < a.length && removed[i]) && !(j < b.length && added[j])) break;
    const i0 = i;
    const j0 = j;
    while (i < a.length && removed[i]) i++;
    while (j < b.length && added[j]) j++;
    // Removed and added lines may interleave without an unchanged line between them.
    while ((i < a.length && removed[i]) || (j < b.length && added[j])) {
      while (i < a.length && removed[i]) i++;
      while (j < b.length && added[j]) j++;
    }
    raw.push([i0, i, j0, j]);
  }
  // Merge raw blocks separated by at most mergeGap unchanged lines (the gap is the same on both sides).
  const merged: [number, number, number, number][][] = [];
  for (const r of raw) {
    const last = merged.at(-1);
    const prev = last?.at(-1);
    if (last && prev && r[0] - prev[1] <= DIFF_LIMITS.mergeGap) last.push(r);
    else merged.push([r]);
  }
  const seen = new Map<string, number>();
  return merged.map((group) => {
    const removedRuns: LineRange[] = [];
    const addedRuns: LineRange[] = [];
    const removedText: string[] = [];
    const addedText: string[] = [];
    for (const [i0, i1, j0, j1] of group) {
      if (i1 > i0) removedRuns.push({ start: i0 + 1, end: i1 });
      if (j1 > j0) addedRuns.push({ start: j0 + 1, end: j1 });
      for (let k = i0; k < i1; k++) removedText.push(a[k]!);
      for (let k = j0; k < j1; k++) addedText.push(b[k]!);
    }
    const first = group[0]!;
    const lastRaw = group.at(-1)!;
    const hash = contentHash(path, removedText, addedText);
    const ordinal = seen.get(hash) ?? 0;
    seen.set(hash, ordinal + 1);
    return {
      key: `${hash}-${ordinal}`,
      old: removedRuns.length ? { start: removedRuns[0]!.start, end: removedRuns.at(-1)!.end } : null,
      new: addedRuns.length ? { start: addedRuns[0]!.start, end: addedRuns.at(-1)!.end } : null,
      removedRuns,
      addedRuns,
      added: addedText.length,
      removed: removedText.length,
      oldAt: first[0] + 1,
      newAt: first[2] + 1,
      oldLen: lastRaw[1] - first[0],
      newLen: lastRaw[3] - first[2],
    };
  });
}

function contentKey(path: string, removed: readonly string[], added: readonly string[], ordinal: number): string {
  return `${contentHash(path, removed, added)}-${ordinal}`;
}

/** Two independent 32-bit FNV-1a hashes over the path and the lines, as 16 hex digits. */
function contentHash(path: string, removed: readonly string[], added: readonly string[]): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x5bd1e995;
  const feed = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193);
      h2 = Math.imul(h2 ^ c, 0x0100019d);
    }
    // A separator no line can hold (lines have no \n), so ["ab"] and ["a","b"] differ.
    h1 = Math.imul(h1 ^ 10, 0x01000193);
    h2 = Math.imul(h2 ^ 10, 0x0100019d);
  };
  feed(path);
  for (const l of removed) feed(`-${l}`);
  feed('\u0000');
  for (const l of added) feed(`+${l}`);
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

// ---- line maps (§5.3) ----

/**
 * An old-side line on the new side: unchanged lines map one to one; a line inside a change maps to the first line
 * of the change's new side, or, when nothing was added, to the line just after where the removed lines were
 * (clamped to the last line). Lines past either end are clamped.
 */
export function oldToNew(diff: FileDiff, line: number): number {
  return mapLine(diff, line, true);
}

/** The reverse of `oldToNew`. */
export function newToOld(diff: FileDiff, line: number): number {
  return mapLine(diff, line, false);
}

function mapLine(diff: FileDiff, line: number, forward: boolean): number {
  const toCount = forward ? diff.newLines : diff.oldLines;
  const clamp = (n: number) => Math.max(1, Math.min(n, Math.max(1, toCount)));
  let shift = 0;
  for (const c of diff.changes) {
    const fromAt = forward ? c.oldAt : c.newAt;
    const fromLen = forward ? c.oldLen : c.newLen;
    const toAt = forward ? c.newAt : c.oldAt;
    const toLen = forward ? c.newLen : c.oldLen;
    if (line < fromAt) break;
    if (line < fromAt + fromLen) {
      const other = forward ? c.new : c.old;
      return clamp(other ? other.start : toAt + toLen);
    }
    shift = toAt + toLen - (fromAt + fromLen);
  }
  return clamp(line + shift);
}

// Finds the code an anchor is about in the current text of its file.
// Strategy and thresholds: docs/research/anchors.md §4–§5. Exact hits and fuzzy windows
// compete under one score, so context and proximity can overrule a far-away duplicate.
import type { Anchor, LineRange, Quote } from './manifest.ts';
import { contentSimilarity, jaccard, lcsRatio, trimCommon } from './similarity.ts';
import type { PreparedText } from './text.ts';
import { identifiers, normalizeLines, splitLines } from './text.ts';

export type AnchorState = 'exact' | 'moved' | 'changed' | 'stale' | 'lost';

export interface Resolution {
  state: AnchorState;
  /** Where the code is now. Null when it can't be found. */
  range: LineRange | null;
  /** Location confidence L in [0, 1]. */
  location: number;
  /** Content similarity S in [0, 1]: is the prose still true? */
  similarity: number;
  /** Two different places scored about the same. */
  ambiguous: boolean;
  method: 'hint' | 'exact' | 'fuzzy' | 'head' | 'range' | 'none';
}

export interface ResolveOptions {
  /**
   * Where we last saw the code: live-tracked through edits, or a confident earlier resolution.
   * Without it the manifest range is used, which is weaker evidence.
   */
  hint?: LineRange;
  /** The previous state, for hysteresis. */
  previous?: AnchorState;
  /** An edit just replaced the whole region, so the hint is a guess: don't let it carry the result. */
  orphaned?: boolean;
}

const HYSTERESIS = 0.03;
const AMBIGUITY = 0.05;
const MAX_CLUSTERS = 12;
/** A hint window this good means the code is right there; skip the whole-file search. */
const GOOD_ENOUGH = 0.9;
/** Cap on comparison work per anchor (line or token pairs), so hostile manifests can't stall the editor. */
const WORK_BUDGET = 3_000_000;
/** Exact copies considered, nearest to the hint first. More than this is itself ambiguous. */
const MAX_EXACT = 50;
/**
 * The fuzzy search looks this many lines either side of the hint, to stay within the per-anchor time
 * budget (docs/research/anchors.md §7). Exact copies are found anywhere; code that moved further than
 * this *and* changed is reported lost.
 */
const SCAN_RADIUS = 5000;

export function resolveAnchor(text: PreparedText, anchor: Anchor, opts: ResolveOptions = {}): Resolution {
  const hint = opts.hint ?? anchor.range;
  if (anchor.quote) return resolveQuote(text, anchor, anchor.quote, hint, opts.hint !== undefined && !opts.orphaned, opts);
  if (anchor.snippet) return resolveHead(text, anchor, anchor.snippet, hint);
  return resolveRange(text.lines.length, hint);
}

interface Candidate {
  i: number;
  len: number;
  exact: boolean;
}

function resolveQuote(text: PreparedText, anchor: Anchor, quote: Quote, hint: LineRange, trustHint: boolean, opts: ResolveOptions): Resolution {
  const n = text.normalized(quote.norm);
  const q = normalizeLines(splitLines(quote.exact), quote.norm);
  const k = q.length;
  const pre = quote.prefix ? normalizeLines(splitLines(quote.prefix), quote.norm) : [];
  const suf = quote.suffix ? normalizeLines(splitLines(quote.suffix), quote.norm) : [];
  const context = (i: number, len: number) => contextSimilarity(n, i, len, pre, suf);
  const home = (i: number) => i + 1 === hint.start || i + 1 === anchor.range.start;
  const rangeAt = (i: number, len: number): LineRange => ({ start: i + 1, end: i + len });
  const h = clamp(hint.start - 1, 0, Math.max(0, n.length - 1));

  // Fast path: still exactly where we last saw it, with the same surroundings.
  if (!opts.orphaned && matchesAt(n, q, hint.start - 1) && (context(hint.start - 1, k) ?? 1) === 1) {
    return { state: 'exact', range: rangeAt(hint.start - 1, k), location: 1, similarity: 1, ambiguous: false, method: 'hint' };
  }

  const quoteIds = identifiers(quote.exact, quote.norm);
  let budget = WORK_BUDGET;
  const scored: (Candidate & { S: number; L: number })[] = [];
  const seen = new Set<string>();
  const consider = (c: Candidate) => {
    const key = `${c.i}:${c.len}`;
    if (seen.has(key) && !c.exact) return;
    seen.add(key);
    let S = 1;
    if (!c.exact) {
      const window = n.slice(c.i, c.i + c.len);
      // Charge what the comparison really costs: only the differing middle is quadratic.
      const { head, tail } = trimCommon(q, window);
      const cost = (k - head - tail) * (c.len - head - tail) + k;
      if (cost > budget) return;
      budget -= cost;
      S = contentSimilarity(q, window);
    }
    const C = context(c.i, c.len);
    const T = c.exact ? 1 : jaccard(quoteIds, identifiers(text.lines.slice(c.i, c.i + c.len).join('\n'), quote.norm));
    // After a whole-region replacement the hint is only a guess, so it earns no proximity.
    const P = opts.orphaned ? 0 : Math.exp(-Math.abs(c.i - h) / 200);
    // Code that moved keeps its body but loses its neighbours. For a nearly identical body, unfamiliar
    // surroundings are no evidence against the place, so count them as neutral rather than zero.
    // (Exact copies keep the real context score: it is what tells duplicates apart.)
    // The floors below only apply when the names still match: a renamed sibling block (same shape,
    // other identifiers) is not the code that moved, so it gets no benefit of the doubt.
    const sameNames = T >= 0.5;
    // The floor rises smoothly with S (no cliff where a small edit flips the state).
    const Ceff = C !== null && !c.exact && sameNames ? Math.max(C, 0.5 * clamp((S - 0.7) / 0.2, 0, 1)) : C;
    let L = Ceff === null ? (0.45 * S + 0.1 * T + 0.1 * P) / 0.65 : 0.45 * S + 0.35 * Ceff + 0.1 * T + 0.1 * P;
    // Live tracking says the code is here and it still mostly matches: we know where it is.
    if (trustHint && c.i === h && S >= 0.7) L = Math.max(L, 0.6);
    // Elsewhere, code whose names mostly differ is some other code that looks alike, not this one.
    else if (!c.exact && !sameNames) L = Math.min(L, 0.59);
    scored.push({ ...c, S, L });
  };

  // Exact copies and the windows at the hint first; the whole-file search only if they aren't convincing.
  // Exact copies are found through the quote's rarest line, so the scan is cheap even in huge files.
  let checked = 0;
  for (const i of exactStarts(text, quote.norm, q, h, Math.floor(budget / Math.max(1, k)))) {
    if (checked === MAX_EXACT || budget < k) break;
    budget -= k;
    if (matchesAt(n, q, i)) {
      consider({ i, len: k, exact: true });
      checked++;
    }
  }
  const tooManyCopies = checked === MAX_EXACT;
  for (const len of windowLengths(k, n.length)) consider({ i: clamp(h, 0, n.length - len), len, exact: false });
  // An exact copy only settles it when its surroundings match too; otherwise an edited copy
  // elsewhere (the real one) may score higher.
  const convincing = scored.some((c) => (c.exact ? context(c.i, c.len) === 1 : c.L >= GOOD_ENOUGH));
  if (!convincing) for (const c of shortlist(n, q, h)) consider({ ...c, exact: false });
  if (scored.length === 0) return lost();

  scored.sort((a, b) => b.L - a.L || Math.abs(a.len - k) - Math.abs(b.len - k) || Math.abs(a.i - h) - Math.abs(b.i - h));
  const best = scored[0]!;
  const rival = scored.find((c) => c.i + c.len <= best.i || c.i >= best.i + best.len);
  // A trusted hint (live-tracked, or confidently resolved before) is strong evidence: a close
  // rival elsewhere only makes the result ambiguous when the winner is somewhere else.
  // A near-copy at a trusted hint is also a rival: the code the reader is editing may be the real one.
  const overlapsBest = (c: { i: number; len: number }) => c.i < best.i + best.len && best.i < c.i + c.len;
  const atTrustedHint = trustHint && best.i === h;
  const hintRival = trustHint && !overlapsBest({ i: h, len: k }) && scored.some((c) => c.i === h && c.S >= 0.8);
  const ambiguous = (tooManyCopies && !atTrustedHint) || hintRival || (rival !== undefined && best.L - rival.L < AMBIGUITY && !atTrustedHint);

  // Same text, ignoring whitespace: the prose still holds.
  if (best.S === 1) {
    return {
      state: home(best.i) ? 'exact' : 'moved',
      range: rangeAt(best.i, best.len),
      location: ambiguous ? 0.9 : 1,
      similarity: 1,
      ambiguous,
      method: best.exact ? 'exact' : 'fuzzy',
    };
  }
  const L = ambiguous ? Math.min(best.L, 0.75) : best.L;
  const state = classify(L, best.S, opts.previous);
  if (state === 'lost') return { ...lost(), location: L, similarity: best.S, ambiguous };
  return { state, range: rangeAt(best.i, best.len), location: L, similarity: best.S, ambiguous, method: 'fuzzy' };
}

/** v1 anchors: a snippet of text near the start of the range. Keeps the range's length. */
function resolveHead(text: PreparedText, anchor: Anchor, snippet: string, hint: LineRange): Resolution {
  const n = text.normalized('ws');
  const s = normalizeLines(splitLines(snippet)).filter((l) => l !== '');
  const span = anchor.range.end - anchor.range.start;
  let best = -1;
  for (let i = 0; i + s.length <= n.length; i++) {
    if (s.every((l, j) => n[i + j]!.includes(l)) && (best < 0 || Math.abs(i + 1 - hint.start) < Math.abs(best + 1 - hint.start))) best = i;
  }
  if (best < 0) {
    const fallback = resolveRange(n.length, hint);
    return fallback.range ? { ...fallback, state: 'stale', location: 0.6, similarity: 0 } : fallback;
  }
  const range = { start: best + 1, end: Math.min(n.length, best + 1 + span) };
  return { state: best + 1 === hint.start ? 'exact' : 'moved', range, location: 1, similarity: 1, ambiguous: false, method: 'head' };
}

/** No text to check against: trust the range if it still fits in the file. */
function resolveRange(lineCount: number, hint: LineRange): Resolution {
  if (hint.start > lineCount) return lost();
  return { state: 'exact', range: { start: hint.start, end: Math.min(hint.end, lineCount) }, location: 1, similarity: 1, ambiguous: false, method: 'range' };
}

function lost(): Resolution {
  return { state: 'lost', range: null, location: 0, similarity: 0, ambiguous: false, method: 'none' };
}

const RANK: Record<AnchorState, number> = { exact: 0, moved: 0, changed: 1, stale: 2, lost: 3 };

function rawState(L: number, S: number): AnchorState {
  if (L >= 0.8 && S >= 0.7) return 'changed';
  if (L >= 0.6) return 'stale';
  return 'lost';
}

/**
 * Turns fuzzy scores into a state. To leave the previous state, the scores must cross the
 * boundary by HYSTERESIS, so badges don't flicker while someone types. An exact/moved
 * anchor that starts to drift is treated as if it were `changed`.
 */
export function classify(L: number, S: number, previous?: AnchorState): AnchorState {
  const raw = rawState(L, S);
  if (!previous) return raw;
  const prevRank = Math.max(RANK[previous], 1);
  if (prevRank === RANK[raw]) return raw;
  const towardPrevious = RANK[raw] > prevRank ? HYSTERESIS : -HYSTERESIS;
  return rawState(L + towardPrevious, S + towardPrevious);
}

function matchesAt(n: readonly string[], q: readonly string[], i: number): boolean {
  if (i < 0 || i + q.length > n.length) return false;
  for (let j = 0; j < q.length; j++) if (n[i + j] !== q[j]) return false;
  return true;
}

/** How well the lines around a candidate match the recorded context, or null when there is none. */
function contextSimilarity(n: readonly string[], i: number, len: number, pre: readonly string[], suf: readonly string[]): number | null {
  const parts: number[] = [];
  if (pre.length) parts.push(lcsRatio(pre, n.slice(Math.max(0, i - pre.length), i)));
  if (suf.length) parts.push(lcsRatio(suf, n.slice(i + len, i + len + suf.length)));
  return parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null;
}

/**
 * Possible start lines of an exact copy, nearest to `h` first, at most `limit` of them: where the
 * quote's rarest non-blank line occurs, shifted back. Walks outward from `h` in the (sorted)
 * position list, so the cost doesn't grow with how often the line occurs.
 */
function* exactStarts(text: PreparedText, norm: Quote['norm'], q: readonly string[], h: number, limit: number): Generator<number> {
  const index = text.positions(norm);
  let rarest = -1;
  let rarestCount = Infinity;
  q.forEach((l, j) => {
    if (l === '') return;
    const count = index.get(l)?.length ?? 0;
    if (count < rarestCount) {
      rarest = j;
      rarestCount = count;
    }
  });
  if (rarest < 0) return; // a quote of blank lines only can't be pinned
  const at = index.get(q[rarest]!) ?? [];
  const valid = (p: number) => p - rarest >= 0 && p - rarest + q.length <= text.lines.length;
  // Binary search for the first occurrence at or after the hint, then walk both ways.
  const target = h + rarest;
  let lo = 0;
  let hi = at.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (at[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  let up = lo - 1;
  let down = lo;
  for (let n = 0; n < limit && (up >= 0 || down < at.length); n++) {
    const takeDown = down < at.length && (up < 0 || at[down]! - target <= target - at[up]!);
    const p = takeDown ? at[down++]! : at[up--]!;
    if (valid(p)) yield p - rarest;
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(Math.max(x, lo), hi);
}

/** Window sizes to try: around the quote's length, and the whole file if it got shorter. */
function windowLengths(k: number, lineCount: number): number[] {
  const out = new Set([k, Math.round(k * 0.85), Math.round(k * 1.15), Math.round(k * 0.7), Math.round(k * 1.3)].filter((m) => m >= 1 && m <= lineCount));
  if (k > lineCount && lineCount > 0) out.add(lineCount);
  return [...out];
}

/**
 * Windows that share the most lines with the quote, best per region. Ranked by a Dice score so
 * oversized windows that merely contain the region don't crowd out the right one.
 */
function shortlist(n: readonly string[], q: readonly string[], h: number): { i: number; len: number }[] {
  const k = q.length;
  const want = new Map<string, number>();
  for (const l of q) if (l !== '') want.set(l, (want.get(l) ?? 0) + 1);
  const found: { i: number; len: number; dice: number }[] = [];
  const from = Math.max(0, h - SCAN_RADIUS);
  const to = Math.min(n.length, h + k + SCAN_RADIUS);
  for (const m of windowLengths(k, n.length)) {
    const have = new Map<string, number>();
    let overlap = 0;
    for (let i = from; i < to; i++) {
      const inLine = n[i]!;
      const h = have.get(inLine) ?? 0;
      if (h < (want.get(inLine) ?? 0)) overlap++;
      have.set(inLine, h + 1);
      if (i - from >= m) {
        const outLine = n[i - m]!;
        const o = have.get(outLine)! - 1;
        have.set(outLine, o);
        if (o < (want.get(outLine) ?? 0)) overlap--;
      }
      const start = i - m + 1;
      if (start >= from && overlap > 0) found.push({ i: start, len: m, dice: (2 * overlap) / (m + k) });
    }
  }
  found.sort((a, b) => b.dice - a.dice || Math.abs(a.len - k) - Math.abs(b.len - k) || Math.abs(a.i - h) - Math.abs(b.i - h));
  const picked: { i: number; len: number }[] = [];
  for (const c of found) {
    const overlapsPicked = picked.some((p) => Math.min(p.i + p.len, c.i + c.len) - Math.max(p.i, c.i) > Math.min(p.len, c.len) / 2);
    if (overlapsPicked) continue;
    picked.push(c);
    if (picked.length === MAX_CLUSTERS) break;
  }
  return picked;
}

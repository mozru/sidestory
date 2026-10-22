import { codeTokens } from './text.ts';

/** Above this many cells, token edit distance is too slow; compare lines instead. */
const MAX_CELLS = 400_000;

/** Lengths of the common prefix and suffix, which the quadratic algorithms can skip. */
export function trimCommon<T>(a: readonly T[], b: readonly T[]): { head: number; tail: number } {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return { head, tail };
}

/** Length of the longest common subsequence. O(n·m) on the differing middle part. */
export function lcsLength<T>(a: readonly T[], b: readonly T[]): number {
  const { head, tail } = trimCommon(a, b);
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);
  if (x.length === 0 || y.length === 0) return head + tail;
  let prev = new Array<number>(y.length + 1).fill(0);
  let cur = new Array<number>(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    for (let j = 1; j <= y.length; j++) {
      cur[j] = x[i - 1] === y[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    }
    [prev, cur] = [cur, prev];
  }
  return head + tail + prev[y.length]!;
}

/** Dice-style LCS ratio in [0, 1]. Two empty sequences are identical. */
export function lcsRatio<T>(a: readonly T[], b: readonly T[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  return (2 * lcsLength(a, b)) / (a.length + b.length);
}

/** Levenshtein distance between sequences. O(n·m) on the differing middle part. */
export function editDistance<T>(a: readonly T[], b: readonly T[]): number {
  const { head, tail } = trimCommon(a, b);
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  let cur = new Array<number>(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    [prev, cur] = [cur, prev];
  }
  return prev[y.length]!;
}

/**
 * Content similarity S of two normalized line lists, in [0, 1].
 * Token edit distance for short regions, line LCS for long or very wide ones.
 */
export function contentSimilarity(a: readonly string[], b: readonly string[]): number {
  if (Math.max(a.length, b.length) <= 20) {
    const ta = codeTokens(a.join('\n'));
    const tb = codeTokens(b.join('\n'));
    const longest = Math.max(ta.length, tb.length);
    if (longest === 0) return 1;
    // Only the differing middle is quadratic; a small edit to a huge line stays cheap.
    const { head, tail } = trimCommon(ta, tb);
    if ((ta.length - head - tail) * (tb.length - head - tail) <= MAX_CELLS) return 1 - editDistance(ta, tb) / longest;
    if (Math.max(a.length, b.length) <= 2) return (head + tail) / longest; // too wide to compare: shared ends only
  }
  return lcsRatio(a, b);
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let both = 0;
  for (const x of a) if (b.has(x)) both++;
  return both / (a.size + b.size - both);
}

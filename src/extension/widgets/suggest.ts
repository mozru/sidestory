// "Did you mean" for import specifiers and export names.

export function levenshtein(a: string, b: string, max = Infinity): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

/** Up to `limit` candidates close to `name`: same name in another case first, then by edit distance. */
export function suggest(name: string, candidates: Iterable<string>, limit = 3): string[] {
  const lower = name.toLowerCase();
  const max = Math.max(2, Math.floor(name.length / 3));
  const scored: { c: string; d: number }[] = [];
  for (const c of candidates) {
    if (c === name) continue;
    const cl = c.toLowerCase();
    const d = cl === lower ? 0 : levenshtein(lower, cl, max) + 1;
    if (d <= max + 1) scored.push({ c, d });
  }
  scored.sort((x, y) => x.d - y.d || x.c.length - y.c.length || (x.c < y.c ? -1 : 1));
  return scored.slice(0, limit).map((s) => s.c);
}

/** " Did you mean 'a' or 'b'?" or ''. */
export function didYouMean(name: string, candidates: Iterable<string>): string {
  const s = suggest(name, candidates).map((c) => `'${c}'`);
  if (s.length === 0) return '';
  return ` Did you mean ${s.length === 1 ? s[0] : `${s.slice(0, -1).join(', ')} or ${s.at(-1)}`}?`;
}

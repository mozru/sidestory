// What a change is and the line maps (src/core/hunks.ts, docs/CHANGES-PLAN.md §5.2–5.3, tests of §16.1).
import { describe, expect, it } from 'vitest';
import { decodePair, DIFF_LIMITS, diffTexts, MAX_COMPARE_BYTES, newToOld, oldToNew, textLines, tooLargeChange, type FileDiff } from '../../src/core/hunks.ts';

const L = (...lines: string[]) => lines.map((l) => `${l}\n`).join('');
const range = (n: number, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`);
const text = (lines: string[]) => (lines.length ? `${lines.join('\n')}\n` : '');
const shape = (d: FileDiff) => d.changes.map((c) => ({ old: c.old, new: c.new, added: c.added, removed: c.removed }));

/** The new lines rebuilt from the old ones and the change regions: what a valid diff must give. */
function apply(a: string[], b: string[], d: FileDiff): { ok: boolean; why?: string } {
  let i = 1;
  let j = 1;
  for (const c of d.changes) {
    // Unchanged lines before the region are equal, one to one.
    while (i < c.oldAt) {
      if (a[i - 1] !== b[j - 1]) return { ok: false, why: `unchanged old ${i} != new ${j}` };
      i++, j++;
    }
    if (j !== c.newAt) return { ok: false, why: `region starts at new ${c.newAt}, expected ${j}` };
    const isRemoved = (n: number) => c.removedRuns.some((r) => n >= r.start && n <= r.end);
    const isAdded = (n: number) => c.addedRuns.some((r) => n >= r.start && n <= r.end);
    const keptOld = [];
    const keptNew = [];
    for (let k = c.oldAt; k < c.oldAt + c.oldLen; k++) if (!isRemoved(k)) keptOld.push(a[k - 1]);
    for (let k = c.newAt; k < c.newAt + c.newLen; k++) if (!isAdded(k)) keptNew.push(b[k - 1]);
    if (keptOld.join('\n') !== keptNew.join('\n')) return { ok: false, why: 'merged unchanged lines differ' };
    if (keptOld.length > DIFF_LIMITS.mergeGap * (c.removedRuns.length + c.addedRuns.length)) return { ok: false, why: 'too many unchanged lines in a change' };
    i = c.oldAt + c.oldLen;
    j = c.newAt + c.newLen;
  }
  while (i <= a.length || j <= b.length) {
    if (a[i - 1] !== b[j - 1]) return { ok: false, why: `tail old ${i} != new ${j}` };
    i++, j++;
  }
  return { ok: true };
}

function lcs(a: string[], b: string[]): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
  return dp[a.length]![b.length]!;
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

describe('changes', () => {
  it('finds additions, deletions and replacements', () => {
    expect(shape(diffTexts('f', L('a', 'b', 'c'), L('a', 'x', 'b', 'c')))).toEqual([{ old: null, new: { start: 2, end: 2 }, added: 1, removed: 0 }]);
    expect(shape(diffTexts('f', L('a', 'b', 'c'), L('a', 'c')))).toEqual([{ old: { start: 2, end: 2 }, new: null, added: 0, removed: 1 }]);
    expect(shape(diffTexts('f', L('a', 'b', 'c'), L('a', 'B', 'c')))).toEqual([{ old: { start: 2, end: 2 }, new: { start: 2, end: 2 }, added: 1, removed: 1 }]);
  });

  it('places pure deletions at the start, middle and end', () => {
    const at = (o: string[], n: string[]) => diffTexts('f', text(o), text(n)).changes.map((c) => ({ newAt: c.newAt, old: c.old }));
    expect(at(['a', 'b', 'c', 'd'], ['c', 'd'])).toEqual([{ newAt: 1, old: { start: 1, end: 2 } }]);
    expect(at(['a', 'b', 'c', 'd'], ['a', 'd'])).toEqual([{ newAt: 2, old: { start: 2, end: 3 } }]);
    expect(at(['a', 'b', 'c', 'd'], ['a', 'b'])).toEqual([{ newAt: 3, old: { start: 3, end: 4 } }]);
    // A pure addition says which old line it sits before.
    expect(diffTexts('f', L('a', 'b'), L('a', 'b', 'c')).changes[0]!.oldAt).toBe(3);
  });

  it('merges changes across one unchanged line, not two', () => {
    const one = diffTexts('f', L('a', 'b', '}', 'c', 'd'), L('a', 'B', '}', 'C', 'd'));
    expect(one.changes).toHaveLength(1);
    expect(one.changes[0]).toMatchObject({ old: { start: 2, end: 4 }, new: { start: 2, end: 4 }, added: 2, removed: 2, oldLen: 3, newLen: 3 });
    expect(one.changes[0]!.removedRuns).toEqual([{ start: 2, end: 2 }, { start: 4, end: 4 }]);
    const two = diffTexts('f', L('a', 'b', '}', '}', 'c', 'd'), L('a', 'B', '}', '}', 'C', 'd'));
    expect(two.changes).toHaveLength(2);
  });

  it('ignores line endings and a missing final newline', () => {
    const crlf = diffTexts('f', 'a\r\nb\r\n', 'a\nb\n');
    expect(crlf).toMatchObject({ changes: [], lineEndingsOnly: true });
    expect(diffTexts('f', 'a\nb', 'a\nb\n')).toMatchObject({ changes: [], lineEndingsOnly: true });
    // A lone CR becoming a newline is a real change (classic Mac text turned into lines), not a line-ending one.
    const cr = diffTexts('f', 'a\rb\r', 'a\nb\n');
    expect(cr.lineEndingsOnly).toBe(false);
    expect(shape(cr)).toEqual([{ old: { start: 1, end: 2 }, new: { start: 1, end: 2 }, added: 2, removed: 2 }]);
    expect(shape(diffTexts('f', 'x\na\rb\ny\n', 'x\na\nb\ny\n'))).toEqual([{ old: { start: 2, end: 2 }, new: { start: 2, end: 2 }, added: 1, removed: 1 }]);
    // CRLF and LF stay equal around a lone CR.
    expect(diffTexts('f', 'a\r\nb\rc\r\n', 'a\nb\rc\n')).toMatchObject({ changes: [], lineEndingsOnly: true });
    // Mixed endings with a real change: only the real change.
    expect(shape(diffTexts('f', 'a\r\nb\nc\r\n', 'a\nB\r\nc\n'))).toEqual([{ old: { start: 2, end: 2 }, new: { start: 2, end: 2 }, added: 1, removed: 1 }]);
    expect(diffTexts('f', 'same', 'same')).toMatchObject({ changes: [], lineEndingsOnly: false });
  });

  it('trims the common head and tail; one change among 1,000 identical lines', () => {
    const old = Array.from({ length: 1000 }, () => '}');
    const nu = [...old];
    nu.splice(500, 0, 'x');
    const d = diffTexts('f', text(old), text(nu));
    expect(d.changes).toHaveLength(1);
    expect(d.changes[0]!.added).toBe(1);
    expect(d.changes[0]!.removed).toBe(0);
    expect(apply(old, nu, d).ok).toBe(true);
  });

  it('slides an appended block down to where a reader sees it, as git does', () => {
    // A test block appended after `  });` / `});` lines: the minimal diff could start at the first `  });`.
    const old = ['describe(a, () => {', '  it(x, () => {', '  });', '});'];
    const added = ['', 'describe(b, () => {', '  it(y, () => {', '  });', '});'];
    const d = diffTexts('f', text(old), text([...old, ...added]));
    expect(shape(d)).toEqual([{ old: null, new: { start: 5, end: 9 }, added: 5, removed: 0 }]);
    // Deletions too: the last of the repeated blocks is the one removed.
    const del = diffTexts('f', text([...old, ...added]), text(old));
    expect(shape(del)).toEqual([{ old: { start: 5, end: 9 }, new: null, added: 0, removed: 5 }]);
    expect(apply([...old, ...added], old, del).ok).toBe(true);
  });

  it('added and deleted files', () => {
    expect(shape(diffTexts('f', '', L('a', 'b')))).toEqual([{ old: null, new: { start: 1, end: 2 }, added: 2, removed: 0 }]);
    expect(shape(diffTexts('f', L('a', 'b'), ''))).toEqual([{ old: { start: 1, end: 2 }, new: null, added: 0, removed: 2 }]);
  });

  it('property: the changes turn the old lines into the new ones, minimally', () => {
    const random = rng(42);
    const alphabet = ['a', 'b', 'c', '}', '', 'x'];
    for (let t = 0; t < 400; t++) {
      const a = Array.from({ length: Math.floor(random() * 30) }, () => alphabet[Math.floor(random() * alphabet.length)]!);
      const b = a.filter(() => random() > 0.2).flatMap((l) => (random() < 0.15 ? [l, alphabet[Math.floor(random() * alphabet.length)]!] : [l]));
      if (random() < 0.3) b.splice(Math.floor(random() * (b.length + 1)), 0, 'new');
      const d = diffTexts('f', text(a), text(b));
      const r = apply(a, b, d);
      expect(r, `${JSON.stringify(a)} → ${JSON.stringify(b)}: ${r.why}`).toEqual({ ok: true });
      const removed = d.changes.reduce((n, c) => n + c.removed, 0);
      const added = d.changes.reduce((n, c) => n + c.added, 0);
      expect(removed + added).toBe(a.length + b.length - 2 * lcs(a, b));
      expect(removed).toBe(d.changes.reduce((n, c) => n + c.removedRuns.reduce((m, x) => m + x.end - x.start + 1, 0), 0));
    }
  });

  it('the budget: a 50,000-line worst case falls back to one change, deterministically', () => {
    const a = range(50_000, 'old');
    const b = range(50_000, 'new');
    const t0 = Date.now();
    const d = diffTexts('f', text(a), text(b));
    expect(Date.now() - t0).toBeLessThan(10_000);
    // Nothing in common: 100,000 edits, far past the budget.
    expect(d.tooLarge).toBe('budget');
    expect(d.changes).toHaveLength(1);
    expect(d.changes[0]).toMatchObject({ old: { start: 1, end: 50_000 }, new: { start: 1, end: 50_000 } });
    expect(diffTexts('f', text(a), text(b))).toEqual(d);
  });

  it('the budget: interleaved edits just within and past the edit distance', () => {
    const a = range(20_000);
    const within = a.map((l, i) => (i % 10 === 0 && i < 24_990 && i / 10 < 2500 ? `${l}!` : l));
    // 2,000 replaced lines = 4,000 edits: computed line by line.
    const d1 = diffTexts('f', text(a), text(within));
    expect(d1.tooLarge).toBeUndefined();
    expect(d1.changes).toHaveLength(2000);
    const past = a.map((l, i) => (i % 6 === 0 ? `${l}!` : l));
    // 3,334 replaced lines = 6,668 edits: past the budget.
    const d2 = diffTexts('f', text(a), text(past));
    expect(d2.tooLarge).toBe('budget');
    expect(diffTexts('f', text(a), text(past))).toEqual(d2);
  });

  it('the size caps: more than 50,000 lines or 2 MB is one change', () => {
    const a = range(50_001);
    const b = [...a];
    b[3] = 'changed';
    expect(diffTexts('f', text(a), text(b)).tooLarge).toBe('size');
    const big = 'x'.repeat(DIFF_LIMITS.maxBytes + 1);
    expect(diffTexts('f', big, 'y\n')).toMatchObject({ tooLarge: 'size', changes: [{ old: { start: 1, end: 1 }, new: { start: 1, end: 1 } }] });
  });

  it('content keys survive edits elsewhere; identical changes get distinct ordinals', () => {
    const old = L('a', 'b', 'c', 'd', 'e', 'f');
    const k1 = diffTexts('src/x.ts', old, L('a', 'b', 'C', 'd', 'e', 'f')).changes[0]!.key;
    const k2 = diffTexts('src/x.ts', L('top', 'more', ...'abcdef'.split('')), L('top', 'more', 'a', 'b', 'C', 'd', 'e', 'f')).changes[0]!.key;
    expect(k1).toBe(k2);
    expect(diffTexts('src/y.ts', old, L('a', 'b', 'C', 'd', 'e', 'f')).changes[0]!.key).not.toBe(k1);
    const twice = diffTexts('f', L('a', '1', '2', '3', 'a', '4'), L('a', 'x', '1', '2', '3', 'a', 'x', '4')).changes;
    expect(twice).toHaveLength(2);
    expect(twice[0]!.key).not.toBe(twice[1]!.key);
    expect(twice[0]!.key.replace(/-\d+$/, '')).toBe(twice[1]!.key.replace(/-\d+$/, ''));
  });
});

describe('line maps', () => {
  const old = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const nu = ['a', 'X', 'Y', 'c', 'd', 'g'];
  // b → X Y (replacement), e f deleted (pure deletion before g).
  const d = diffTexts('f', text(old), text(nu));

  it('maps unchanged lines one to one, both ways', () => {
    expect(shape(d)).toEqual([
      { old: { start: 2, end: 2 }, new: { start: 2, end: 3 }, added: 2, removed: 1 },
      { old: { start: 5, end: 6 }, new: null, added: 0, removed: 2 },
    ]);
    expect([1, 3, 4, 7].map((l) => oldToNew(d, l))).toEqual([1, 4, 5, 6]);
    expect([1, 4, 5, 6].map((l) => newToOld(d, l))).toEqual([1, 3, 4, 7]);
  });

  it('maps lines inside a change to the other side', () => {
    expect(oldToNew(d, 2)).toBe(2);
    expect(newToOld(d, 3)).toBe(2);
    // Removed lines with nothing added: the line just after where they were.
    expect(oldToNew(d, 5)).toBe(6);
    expect(oldToNew(d, 6)).toBe(6);
  });

  it('maps unchanged lines merged into a change one to one', () => {
    // a → A, then b unchanged, then B added: one change (merged across b), and b keeps its place on both sides.
    const m = diffTexts('f', text(['x', 'a', 'b', 'y']), text(['x', 'A', 'b', 'B', 'y']));
    expect(m.changes).toHaveLength(1);
    expect(oldToNew(m, 3)).toBe(3);
    expect(newToOld(m, 3)).toBe(3);
    expect(oldToNew(m, 2)).toBe(2);
    expect(newToOld(m, 4)).toBe(2);
    expect(oldToNew(m, 4)).toBe(5);
    expect(newToOld(m, 5)).toBe(4);
  });

  it('clamps at the ends', () => {
    const del = diffTexts('f', text(['a', 'b', 'c']), text(['a']));
    expect(oldToNew(del, 3)).toBe(1);
    expect(oldToNew(del, 99)).toBe(1);
    const add = diffTexts('f', text(['a']), text(['a', 'b', 'c']));
    expect(newToOld(add, 3)).toBe(1);
  });
});

describe('decoding', () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  it('drops a BOM on one side', () => {
    const p = decodePair(new Uint8Array([0xef, 0xbb, 0xbf, ...enc('a\nb\n')]), enc('a\nb\n'));
    expect(p).toEqual({ old: 'a\nb\n', new: 'a\nb\n', latin1: false });
    expect(diffTexts('f', p.old, p.new).changes).toEqual([]);
  });

  it('decodes both sides as Latin-1 when either is not UTF-8', () => {
    const latin = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]); // "café\n" in Latin-1
    const p = decodePair(latin, enc('café\n'));
    expect(p.latin1).toBe(true);
    expect(p.old).toBe('café\n');
    expect(p.new).toBe('cafÃ©\n');
    const same = decodePair(latin, latin);
    expect(diffTexts('f', same.old, same.new).changes).toEqual([]);
  });

  it('drops a BOM before the Latin-1 fallback too', () => {
    const p = decodePair(new Uint8Array([0xef, 0xbb, 0xbf, ...enc('a\nb\n')]), new Uint8Array([...enc('a\nb\n'), 0xe9, 0x0a]));
    expect(p).toEqual({ old: 'a\nb\n', new: 'a\nb\né\n', latin1: true });
    expect(shape(diffTexts('f', p.old, p.new))).toEqual([{ old: null, new: { start: 3, end: 3 }, added: 1, removed: 0 }]);
  });

  it('decodes UTF-8, including astral characters, and refuses overlongs and surrogates', () => {
    expect(decodePair(enc('héllo 😀\n'), undefined)).toEqual({ old: 'héllo 😀\n', new: '', latin1: false });
    expect(decodePair(new Uint8Array([0xc0, 0x80]), undefined).latin1).toBe(true);
    expect(decodePair(new Uint8Array([0xed, 0xa0, 0x80]), undefined).latin1).toBe(true);
  });

  it('text lines', () => {
    expect(textLines('')).toEqual([]);
    expect(textLines('a')).toEqual(['a']);
    expect(textLines('a\n')).toEqual(['a']);
    expect(textLines('a\n\n')).toEqual(['a', '']);
  });
});

describe('too large to read', () => {
  it('one change keyed by the path alone, spanning the lines the caller knows', () => {
    expect(MAX_COMPARE_BYTES).toBe(10 * 1024 * 1024);
    const a = tooLargeChange('big.bin.txt', 0, 0);
    expect(a).toMatchObject({ old: null, new: null, added: 0, removed: 0, removedRuns: [], addedRuns: [] });
    expect(tooLargeChange('big.bin.txt', 3, 5).key).toBe(a.key);
    expect(tooLargeChange('other.txt', 0, 0).key).not.toBe(a.key);
    expect(tooLargeChange('big.bin.txt', 3, 5)).toMatchObject({ old: { start: 1, end: 3 }, new: { start: 1, end: 5 }, added: 5, removed: 3, oldLen: 3, newLen: 5 });
  });
});

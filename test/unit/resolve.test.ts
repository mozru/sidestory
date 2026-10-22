import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Anchor, LineRange } from '../../src/core/manifest.ts';
import { pinQuote } from '../../src/core/pin.ts';
import type { ResolveOptions } from '../../src/core/resolve.ts';
import { classify, resolveAnchor } from '../../src/core/resolve.ts';
import { PreparedText, splitLines } from '../../src/core/text.ts';

const resolve = (lines: readonly string[], a: Anchor, opts?: ResolveOptions) => resolveAnchor(new PreparedText(lines), a, opts);

const FILE = [
  'module bit_reader #(', //  1
  '  parameter int W = 64', //  2
  ') (', //  3
  '  input  logic clk,', //  4
  ');', //  5
  '  logic [W-1:0] buf_q;', //  6
  '  logic [6:0]   cnt_q;', //  7
  '', //  8
  '  always_ff @(posedge clk) begin', //  9
  '    if (in_valid && in_ready) begin', // 10
  '      b = b | (W\'(in_byte) << (W - 8 - c));', // 11
  "      c = c + 7'd8;", // 12
  '    end', // 13
  '    buf_q <= b;', // 14
  '  end', // 15
  'endmodule', // 16
];

function anchorFor(lines: readonly string[], range: LineRange, extra: Partial<Anchor> = {}): Anchor {
  return { id: 'a', file: 'x.sv', range, quote: pinQuote(lines, range) ?? undefined, highlight: [], ...extra };
}

const REFILL: LineRange = { start: 10, end: 13 };

describe('resolveAnchor with a quote', () => {
  it('is exact when the code has not moved', () => {
    const r = resolve(FILE, anchorFor(FILE, REFILL));
    expect(r).toMatchObject({ state: 'exact', range: REFILL, method: 'hint', location: 1, similarity: 1 });
  });

  it('ignores whitespace-only changes', () => {
    const edited = FILE.map((l, i) => (i === 10 ? l.replace('b | ', 'b  |  ') + '   ' : l));
    expect(resolve(edited, anchorFor(FILE, REFILL)).state).toBe('exact');
  });

  it('follows the code when lines are inserted above', () => {
    const edited = ['// header', '// more', ...FILE];
    const r = resolve(edited, anchorFor(FILE, REFILL));
    expect(r).toMatchObject({ state: 'moved', range: { start: 12, end: 15 }, method: 'exact' });
  });

  it('stays exact when the live-tracked hint already followed the move', () => {
    const edited = ['// header', ...FILE];
    const r = resolve(edited, anchorFor(FILE, REFILL), { hint: { start: 11, end: 14 } });
    expect(r).toMatchObject({ state: 'exact', range: { start: 11, end: 14 } });
  });

  it('uses context to choose between duplicates', () => {
    const block = ['  if (x) begin', '    y = 1;', '  end'];
    const lines = ['// first', ...block, '// gap', '// second', ...block, '// tail'];
    const anchor = anchorFor(lines, { start: 7, end: 9 });
    // Swap the order of the two regions; context should still pick the "second" copy.
    const swapped = ['// second', ...block, '// tail', '// first', ...block, '// gap'];
    const r = resolve(swapped, anchor);
    expect(r).toMatchObject({ state: 'moved', range: { start: 2, end: 4 }, ambiguous: false, location: 1 });
  });

  it('marks a tie that context cannot break as ambiguous and picks the nearest', () => {
    const block = ['  if (x) begin', '    y = 1;', '  end'];
    const lines = [...block, ...block];
    const anchor: Anchor = { id: 'a', file: 'x', range: { start: 5, end: 7 }, quote: { exact: block.join('\n'), prefix: '', suffix: '', norm: 'ws' }, highlight: [] };
    const r = resolve(lines, anchor);
    expect(r).toMatchObject({ range: { start: 4, end: 6 }, ambiguous: true, location: 0.9 });
  });

  it('reports a small edit as changed, at the right place', () => {
    const edited = [...FILE];
    edited[11] = "      c = c + 7'd16;";
    const r = resolve(edited, anchorFor(FILE, REFILL));
    expect(r.state).toBe('changed');
    expect(r.range).toEqual(REFILL);
    expect(r.similarity).toBeGreaterThan(0.7);
    expect(r.similarity).toBeLessThan(1);
  });

  it('finds an edited region that also moved', () => {
    const edited = ['// a', '// b', '// c', ...FILE];
    edited[3 + 11] = "      c = c + 7'd16;";
    const r = resolve(edited, anchorFor(FILE, REFILL));
    expect(r.state).toBe('changed');
    expect(r.range).toEqual({ start: 13, end: 16 });
  });

  it('reports a heavy rewrite in place as stale, not lost', () => {
    const edited = [...FILE];
    edited[9] = '    if (in_valid && in_ready && !stall) begin';
    edited[10] = '      b = merge(b, in_word, c);';
    edited[11] = '      c = c + WORD;';
    const r = resolve(edited, anchorFor(FILE, REFILL));
    expect(r.state).toBe('stale');
    expect(r.range?.start).toBe(10);
  });

  it('is lost when the code is gone', () => {
    const edited = [...FILE.slice(0, 9), ...FILE.slice(13)];
    const r = resolve(edited, anchorFor(FILE, REFILL));
    expect(r.state).toBe('lost');
    expect(r.range).toBeNull();
  });

  it('is lost in an empty file', () => {
    expect(resolve([''], anchorFor(FILE, REFILL)).state).toBe('lost');
  });

  it('ignores case only for ws-ci', () => {
    const upper = FILE.map((l) => l.toUpperCase());
    const anchor = anchorFor(FILE, REFILL);
    expect(resolve(upper, anchor).state).not.toBe('exact');
    expect(resolve(upper, { ...anchor, quote: { ...anchor.quote!, norm: 'ws-ci' } }).state).toBe('exact');
  });
});

describe('resolveAnchor without a quote', () => {
  it('v1 snippet: finds the snippet nearest the range and keeps the length', () => {
    const anchor: Anchor = { id: 'a', file: 'x', range: { start: 10, end: 13 }, snippet: 'if (in_valid && in_ready) begin', highlight: [] };
    const r = resolve(['// new', ...FILE], anchor);
    expect(r).toMatchObject({ state: 'moved', range: { start: 11, end: 14 }, method: 'head' });
  });

  it('v1 snippet that disappeared is stale at the old range', () => {
    const anchor: Anchor = { id: 'a', file: 'x', range: { start: 10, end: 13 }, snippet: 'no such text', highlight: [] };
    expect(resolve(FILE, anchor)).toMatchObject({ state: 'stale', range: { start: 10, end: 13 } });
  });

  it('range only: trusted while it fits, lost past the end of the file', () => {
    const anchor: Anchor = { id: 'a', file: 'x', range: { start: 14, end: 20 }, highlight: [] };
    expect(resolve(FILE, anchor)).toMatchObject({ state: 'exact', range: { start: 14, end: 16 }, method: 'range' });
    expect(resolve(FILE.slice(0, 5), anchor).state).toBe('lost');
  });
});

describe('classify', () => {
  it('uses the thresholds when there is no history', () => {
    expect(classify(0.85, 0.8)).toBe('changed');
    expect(classify(0.79, 0.8)).toBe('stale');
    expect(classify(0.85, 0.69)).toBe('stale');
    expect(classify(0.59, 0.9)).toBe('lost');
  });

  it('needs a margin to leave the previous state', () => {
    expect(classify(0.79, 0.8, 'changed')).toBe('changed');
    expect(classify(0.76, 0.8, 'changed')).toBe('stale');
    expect(classify(0.81, 0.8, 'stale')).toBe('stale');
    expect(classify(0.84, 0.8, 'stale')).toBe('changed');
    expect(classify(0.58, 0.8, 'stale')).toBe('stale');
    expect(classify(0.5, 0.8, 'changed')).toBe('lost');
  });
});

describe('resolveAnchor: review regressions', () => {
  const block = (name: string) => [`module ${name};`, '', '  always_ff @(posedge clk) begin', '    if (en) begin', '      q <= d;', '    end', '  end', 'endmodule', ''];

  it('an edit to one of two identical blocks stays on that block', () => {
    const lines = [...block('a'), ...block('b')];
    const anchor = anchorFor(lines, { start: 3, end: 7 });
    const edited = [...lines];
    edited[3] = '    if (en && ok) begin';
    const r = resolve(edited, anchor, { hint: { start: 3, end: 7 } });
    expect(r).toMatchObject({ state: 'changed', range: { start: 3, end: 7 } });
  });

  it('a comment inserted right above the anchored copy does not send it to the duplicate', () => {
    const lines = [...block('a'), ...block('b')];
    const anchor = anchorFor(lines, { start: 3, end: 7 });
    const edited = [...lines.slice(0, 2), '  // new comment', ...lines.slice(2)];
    const r = resolve(edited, anchor, { hint: { start: 4, end: 8 } });
    expect(r).toMatchObject({ state: 'exact', range: { start: 4, end: 8 } });
  });

  it.each([
    [100, 30],
    [100, 10],
    [200, 60],
  ])('a %i-line region shifted by %i lines with one edit gets the exact range back', (k, shift) => {
    const body = Array.from({ length: k }, (_, i) => `  assign w${i} = a${i} & b${i};`);
    const lines = [...Array.from({ length: 300 }, (_, i) => `// before ${i}`), ...body, ...Array.from({ length: 300 }, (_, i) => `// after ${i}`)];
    const anchor = anchorFor(lines, { start: 301, end: 300 + k });
    const edited = [...Array.from({ length: shift }, (_, i) => `// inserted ${i}`), ...lines];
    edited[shift + 300 + Math.floor(k / 2)] = '  assign changed = 1;';
    const r = resolve(edited, anchor);
    expect(r.state).toBe('changed');
    expect(r.range).toEqual({ start: 301 + shift, end: 300 + shift + k });
  });

  it('whitespace inside tokens is not a change', () => {
    const lines = ['x', 'a+b;', 'y'];
    const anchor = anchorFor(lines, { start: 2, end: 2 });
    expect(resolve(['x', 'a + b;', 'y'], anchor).state).toBe('exact');
  });

  it('can still cover the region when the file shrank below the quote length', () => {
    const lines = Array.from({ length: 12 }, (_, i) => `line ${i}`);
    const anchor = anchorFor(lines, { start: 1, end: 12 });
    const r = resolve(lines.slice(0, 9), anchor);
    expect(r.range).toEqual({ start: 1, end: 9 });
  });

  it('an orphaned region is lost unless an exact copy exists elsewhere', () => {
    const anchor = anchorFor(FILE, REFILL);
    const replaced = [...FILE.slice(0, 9), '    // rewritten', ...FILE.slice(13)];
    expect(resolve(replaced, anchor, { hint: { start: 10, end: 10 }, orphaned: true }).state).toBe('lost');
    const moved = [...replaced, ...FILE.slice(9, 13)];
    expect(resolve(moved, anchor, { hint: { start: 10, end: 10 }, orphaned: true }).state).toBe('moved');
  });

  it('stays within the per-document time budget', () => {
    const big = Array.from({ length: 10_000 }, (_, i) => `  assign w${i} = a${i} ^ b${i};`);
    const text = new PreparedText(big);
    const anchors = Array.from({ length: 50 }, (_, j) => anchorFor(big, { start: 100 + j * 150, end: 120 + j * 150 }));
    const t0 = performance.now();
    for (const a of anchors) resolveAnchor(text, a);
    expect(performance.now() - t0).toBeLessThan(50);

    const wide = Array.from({ length: 20 }, (_, i) => Array.from({ length: 60 }, (_, j) => `t${i}_${j}`).join(' + '));
    const file = [...big.slice(0, 500), ...wide, ...big.slice(500, 1000)];
    const anchor = anchorFor(file, { start: 501, end: 520 });
    const edited = [...file];
    edited[510] = 'changed';
    const t1 = performance.now();
    resolve(edited, anchor);
    expect(performance.now() - t1).toBeLessThan(100);
  });
});

describe('resolveAnchor: round 2 regressions', () => {
  const block = (name: string) => [`module ${name};`, '', '  always_ff @(posedge clk) begin', '    if (en) begin', '      q <= d;', '    end', '  end', 'endmodule', ''];

  it.each([5, 20])('a stale hint does not send an edited region to its untouched twin (%i lines inserted)', (shift) => {
    const lines = [...block('a'), ...block('b')];
    const anchor = anchorFor(lines, { start: 3, end: 6 });
    const edited = [...Array.from({ length: shift }, (_, i) => `// new ${i}`), ...lines];
    edited[shift + 3] = '    if (en && ok) begin';
    const r = resolve(edited, anchor);
    // The edited copy wins on context; with no trusted hint, its unchanged twin keeps it from being certain.
    expect(r.range).toEqual({ start: 3 + shift, end: 6 + shift });
    expect(['changed', 'stale']).toContain(r.state);
  });

  it('without a trusted hint, identical twins stay ambiguous', () => {
    const twin = ['  if (x) begin', '    y = 1;', '  end'];
    const lines = [...twin, '', ...twin];
    const anchor: Anchor = { id: 'a', file: 'x', range: { start: 3, end: 5 }, quote: { exact: twin.join('\n'), prefix: '', suffix: '', norm: 'ws' }, highlight: [] };
    expect(resolve(lines, anchor).ambiguous).toBe(true);
  });

  it('a whole-line replacement that only edits the line is changed, not lost', () => {
    const lines = ['a', '  c = c + 8;', 'b'];
    const anchor = anchorFor(lines, { start: 2, end: 2 });
    const r = resolve(['a', '  c = c + 16;', 'b'], anchor, { hint: { start: 2, end: 2 }, orphaned: true });
    expect(r.state).toBe('changed');
  });

  it('a small edit in a single very wide line is still a change, not a loss', () => {
    const wide = Array.from({ length: 800 }, (_, i) => `v${i}`).join(' + ');
    const anchor = anchorFor(['x', wide, 'y'], { start: 2, end: 2 });
    const r = resolve(['x', wide.replace('v400', 'w400'), 'y'], anchor, { hint: { start: 2, end: 2 } });
    expect(r.state).toBe('changed');
  });

  it('fuzzy resolution with a good live hint stays fast', () => {
    const body = Array.from({ length: 200 }, (_, i) => `  assign w${i} = a${i} & b${i};`);
    const lines = [...Array.from({ length: 5000 }, (_, i) => `// ${i}`), ...body, ...Array.from({ length: 5000 }, (_, i) => `// z${i}`)];
    const anchor = anchorFor(lines, { start: 5001, end: 5200 });
    const edited = [...lines];
    edited[5100] = '  assign changed = 1;';
    const text = new PreparedText(edited);
    resolveAnchor(text, anchor, { hint: { start: 5001, end: 5200 } });
    const t0 = performance.now();
    const r = resolveAnchor(text, anchor, { hint: { start: 5001, end: 5200 } });
    expect(performance.now() - t0).toBeLessThan(8);
    expect(r.range).toEqual({ start: 5001, end: 5200 });
  });
});

describe('resolveAnchor: round 3 regressions', () => {
  const fn = ['function twice(a) {', '  const b = a * 2;', '  log(b);', '  check(b);', '  return b;', '}'];

  it.each([50, 100, 300, 1000])('code moved %i lines into new surroundings, slightly edited, is not lost', (shift) => {
    const lines = ['// top', ...fn, '// bottom', ...Array.from({ length: 1200 }, (_, i) => `// filler ${i}`)];
    const anchor = anchorFor(lines, { start: 2, end: 7 });
    const moved = ['// top', '// bottom', ...Array.from({ length: shift }, (_, i) => `// filler ${i}`), ...fn.map((l) => l.replace('a * 2', 'a * 3')), ...Array.from({ length: 1200 - shift }, (_, i) => `// more ${i}`)];
    const r = resolve(moved, anchor);
    expect(r.state).not.toBe('lost');
    expect(r.range).toEqual({ start: 3 + shift, end: 8 + shift });
  });

  it('an edited block at a trusted hint is not silently replaced by a context-free copy elsewhere', () => {
    const block = ['  x = compute(a);', '  y = x + 1;'];
    const lines = ['// a', ...block, ...Array.from({ length: 50 }, (_, i) => `// ${i}`), ...block];
    const anchor: Anchor = { id: 'a', file: 'x', range: { start: 2, end: 3 }, quote: { exact: block.join('\n'), prefix: '', suffix: '', norm: 'ws' }, highlight: [] };
    const edited = [...lines];
    edited[2] = '  y = x + 2;';
    expect(resolve(edited, anchor, { hint: { start: 2, end: 3 } }).ambiguous).toBe(true);
  });

  it('finds exact copies in a huge file quickly, and treats very many copies as ambiguous', () => {
    const big = new PreparedText(Array.from({ length: 1_000_000 }, () => 'a'));
    const anchor: Anchor = { id: 'a', file: 'x', range: { start: 10, end: 12 }, quote: { exact: 'a\na\nb', prefix: 'z', suffix: 'z', norm: 'ws' }, highlight: [] };
    let t0 = performance.now();
    expect(resolveAnchor(big, anchor).state).not.toBe('exact');
    expect(performance.now() - t0).toBeLessThan(1500); // dominated by building the line index once
    t0 = performance.now();
    resolveAnchor(big, anchor);
    expect(performance.now() - t0).toBeLessThan(150);

    const braces: Anchor = { id: 'b', file: 'x', range: { start: 5, end: 5 }, quote: { exact: 'a', prefix: 'q', suffix: 'q', norm: 'ws' }, highlight: [] };
    t0 = performance.now();
    expect(resolveAnchor(big, braces).ambiguous).toBe(true);
    expect(performance.now() - t0).toBeLessThan(150);
  });
});

describe('resolveAnchor: round 4 regressions', () => {
  it('a file of millions of identical lines costs little per anchor once indexed', () => {
    const text = new PreparedText(Array.from({ length: 2_000_000 }, () => 'a'));
    const anchor: Anchor = { id: 'a', file: 'x', range: { start: 10, end: 11 }, quote: { exact: 'a\na', prefix: 'x', suffix: 'y', norm: 'ws' }, highlight: [] };
    resolveAnchor(text, anchor);
    const t0 = performance.now();
    for (let i = 0; i < 5; i++) expect(resolveAnchor(text, anchor).ambiguous).toBe(true);
    expect((performance.now() - t0) / 5).toBeLessThan(40);
  });
});

describe('resolveAnchor: round 5 regressions', () => {
  it('deleted code is lost, not attributed to a renamed sibling', () => {
    const handler = (n: string) => [`  always_ff @(posedge clk) if (${n}_valid) begin`, `    ${n}_count <= ${n}_count + 1;`, `    ${n}_last <= ${n}_data;`, '  end'];
    const lines = ['module m;', ...handler('rx'), ...handler('tx'), ...handler('cfg'), 'endmodule'];
    const anchor = anchorFor(lines, { start: 6, end: 9 });
    const deleted = ['module m;', ...handler('rx'), ...handler('cfg'), 'endmodule'];
    expect(resolve(deleted, anchor).state).toBe('lost');
    // With a trusted live hint (someone renaming in place) it stays findable, flagged out of date.
    expect(resolve(deleted, anchor, { hint: { start: 6, end: 9 } }).state).toBe('stale');
  });
});

describe('resolveAnchor: round 6 regressions', () => {
  it.each([
    ["7'd16", undefined],
    ["7'h10", undefined],
    ["7'd16", { start: 2, end: 2 }],
  ])('a one-literal edit to an HDL line is a change, not a loss (%s, hint %j)', (lit, hint) => {
    const lines = ['always_ff @(posedge clk) begin', "  cnt_q <= cnt_q + 7'd8;", 'end'];
    const anchor = anchorFor(lines, { start: 2, end: 2 });
    const edited = ['always_ff @(posedge clk) begin', `  cnt_q <= cnt_q + ${lit};`, 'end'];
    expect(resolve(edited, anchor, hint ? { hint } : {}).state).toBe('changed');
    expect(resolve(edited, anchor, { hint: { start: 2, end: 2 }, orphaned: true }).state).not.toBe('lost');
  });
});

describe('resolveAnchor: security audit regressions', () => {
  it('a v1 snippet anchor costs little even with a huge snippet and file', () => {
    const text = new PreparedText(Array.from({ length: 1_000_000 }, () => 'a'));
    const anchor: Anchor = { id: 'a', file: 'x', range: { start: 10, end: 500 }, snippet: Array.from({ length: 500 }, () => 'a').join('\n') + '\nb', highlight: [] };
    const t0 = performance.now();
    resolveAnchor(text, anchor);
    expect(performance.now() - t0).toBeLessThan(300);
  });

  it('long recorded context does not make resolution slow', () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `line ${i % 7}`);
    const anchor: Anchor = { id: 'a', file: 'x', range: { start: 1000, end: 1001 }, quote: { exact: 'unique one\nunique two', prefix: Array.from({ length: 900 }, () => 'p').join('\n'), suffix: Array.from({ length: 900 }, () => 's').join('\n'), norm: 'ws' }, highlight: [] };
    const t0 = performance.now();
    resolve(lines, anchor);
    expect(performance.now() - t0).toBeLessThan(100);
  });
});

describe('resolveAnchor: v1 snippets that occur more than once', () => {
  it('are ambiguous, so they are not pinned from a guess', () => {
    const lines = ['x', 'if (en) begin', '  a;', 'end', 'y', 'if (en) begin', '  b;', 'end'];
    const anchor: Anchor = { id: 'a', file: 'x', range: { start: 6, end: 8 }, snippet: 'if (en) begin', highlight: [] };
    expect(resolve(lines, anchor)).toMatchObject({ ambiguous: true, range: { start: 6, end: 8 } });
    expect(resolve(lines.slice(4), anchor)).toMatchObject({ ambiguous: false });
  });
});

describe('resolveAnchor: user test regressions (tinyroute, sync_fifo)', () => {
  const fixture = (name: string) => splitLines(readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8'));
  const trie = fixture('trie.v1.go.txt');
  const header = fixture('license-header.txt').slice(0, 16);
  const SPLIT: LineRange = { start: 87, end: 93 }; // func splitPath(p string) []string { … }
  const split = anchorFor(trie, SPLIT);
  const renamed = trie.map((l) => l.replaceAll('splitPath', 'segments'));

  it('a renamed short function that also moved is changed, and keeps its signature line', () => {
    expect(resolve(renamed, split)).toMatchObject({ state: 'changed', range: SPLIT });
    expect(resolve([...header, ...trie], split)).toMatchObject({ state: 'moved', range: { start: 103, end: 109 } });
    const both = [...header, ...renamed];
    expect(resolve(both, split)).toMatchObject({ state: 'changed', range: { start: 103, end: 109 } });
    // A live hint that lost the (replaced) first line still finds the whole function.
    expect(resolve(both, split, { hint: { start: 104, end: 109 } })).toMatchObject({ state: 'changed', range: { start: 103, end: 109 } });
  });

  it('after a whole-file replacement the state is what a fresh open gives, whatever came before', () => {
    const both = [...header, ...renamed];
    const fresh = resolve(both, split);
    for (const previous of ['exact', 'stale', 'lost'] as const) {
      const r = resolve(both, split, { hint: { start: 1, end: both.length }, orphaned: true, previous });
      expect(r).toEqual(fresh);
    }
    // Checking out an older version of the open file: what still resembles the pinned code isn't lost.
    const v0 = fixture('trie.v0.go.txt');
    const node = anchorFor(trie, { start: 10, end: 16 });
    expect(resolve(v0, node, { hint: { start: 1, end: v0.length }, orphaned: true, previous: 'exact' })).toEqual(resolve(v0, node));
    expect(resolve(v0, node).state).toBe('stale');
  });

  it('a wrong live hint (a broken edit, then the fix) is never worse than a fresh resolve', () => {
    const fn = (name: string, k: string) => [`function ${name}(a) {`, `  const b = a * ${k};`, '  log(b);', '  check(b);', '  return b;', '}'];
    const lines = ['// top', ...fn('twice', '2'), '', ...fn('thrice', '3'), '// end'];
    const anchor = anchorFor(lines, { start: 2, end: 7 });
    // twice was edited in place; tracking was left pointing at its look-alike sibling further down.
    const edited = ['// top', ...fn('twice', '2').map((l) => l.replace('log(b)', 'log(b, 1)')), '', ...Array.from({ length: 30 }, (_, i) => `// ${i}`), ...fn('thrice', '3'), '// end'];
    const fresh = resolve(edited, anchor);
    expect(fresh).toMatchObject({ state: 'changed', range: { start: 2, end: 7 } });
    const r = resolve(edited, anchor, { hint: { start: 39, end: 44 }, previous: 'stale' });
    expect(r.state).toBe('changed');
    expect(r.range).toEqual(fresh.range);
  });

  it('ranges and quotes never start or end on a blank line', () => {
    // An older pin took in the blank line after the function.
    const old: Anchor = { ...split, range: { start: 87, end: 94 }, quote: { ...split.quote!, exact: split.quote!.exact + '\n' } };
    expect(resolve(trie, old)).toMatchObject({ state: 'exact', range: SPLIT });
    expect(resolve(['// new', ...trie], old)).toMatchObject({ state: 'moved', range: { start: 88, end: 94 } });
    expect(resolve(renamed, old)).toMatchObject({ state: 'changed', range: SPLIT });
    // A recorded range that starts on a blank line the quote leaves out is still home.
    const spaced = [...trie.slice(0, 86), '', ...trie.slice(86)];
    expect(resolve(spaced, { ...split, range: { start: 87, end: 94 } })).toMatchObject({ state: 'exact', range: { start: 88, end: 94 } });
    // v1 snippets keep the recorded length, less trailing blank lines.
    const snip: Anchor = { id: 's', file: 'x', range: { start: 87, end: 94 }, snippet: 'func splitPath(p string) []string {', highlight: [] };
    expect(resolve(trie, snip).range).toEqual(SPLIT);
  });

  describe('unchanged code whose neighbours changed stays exact or moved', () => {
    const fifo = fixture('sync_fifo.sv.txt');
    const READ: LineRange = { start: 54, end: 65 }; // the read data path generate block
    const read = anchorFor(fifo, READ);

    it('when the block below it is deleted', () => {
      const deleted = [...fifo.slice(0, 66), ...fifo.slice(73)]; // lines 67-73
      for (const opts of [{}, { hint: READ }, { hint: READ, previous: 'exact' as const }]) {
        expect(resolve(deleted, read, opts)).toMatchObject({ state: 'exact', range: READ, similarity: 1 });
      }
    });

    it('when the block above it is moved below it', () => {
      const moved = [...fifo.slice(0, 46), ...fifo.slice(52, 65), ...fifo.slice(46, 52), ...fifo.slice(65)]; // lines 47-52
      const now = { start: 48, end: 59 };
      expect(resolve(moved, read)).toMatchObject({ state: 'moved', range: now, similarity: 1 });
      expect(resolve(moved, read, { hint: now, previous: 'exact' })).toMatchObject({ state: 'exact', range: now, similarity: 1 });
    });
  });
});

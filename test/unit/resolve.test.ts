import { describe, expect, it } from 'vitest';
import type { Anchor, LineRange } from '../../src/core/manifest.ts';
import { pinQuote } from '../../src/core/pin.ts';
import type { ResolveOptions } from '../../src/core/resolve.ts';
import { classify, resolveAnchor } from '../../src/core/resolve.ts';
import { PreparedText } from '../../src/core/text.ts';

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

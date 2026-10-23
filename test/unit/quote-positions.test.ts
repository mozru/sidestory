// Quote positions in manifest.json (docs/NAVIGATION-PLAN.md §7.2): UTF-8 byte offsets of each pinned anchor's
// quote object, so the index can read just those bytes later.
import { describe, expect, it } from 'vitest';
import { parseManifest, type Quote } from '../../src/core/manifest.ts';
import { quoteHash, quotePositions } from '../../src/core/quote-positions.ts';

/** The quote text found at the recorded bytes, parsed. */
function sliceQuote(file: Buffer, span: { offset: number; length: number }): unknown {
  return JSON.parse(file.subarray(span.offset, span.offset + span.length).toString('utf8'));
}

const q = (exact: string, extra: Partial<Quote> = {}) => ({ exact, prefix: '', suffix: '', norm: 'ws', ...extra });

describe('quotePositions', () => {
  it('finds each anchor’s quote, with byte offsets that slice back to the same JSON', () => {
    const doc = { version: 2, title: 'T', anchors: { a: { file: 'x.ts', range: [1, 2], quote: q('alpha') }, b: { file: 'y.ts', range: [3, 4] }, c: { quote: q('gamma', { prefix: 'p' }), file: 'z' } } };
    const text = JSON.stringify(doc, null, 2);
    const pos = quotePositions(text);
    expect([...pos.keys()].sort()).toEqual(['a', 'c']);
    const file = Buffer.from(text);
    expect(sliceQuote(file, pos.get('a')!)).toEqual(doc.anchors.a.quote);
    expect(sliceQuote(file, pos.get('c')!)).toEqual(doc.anchors.c.quote);
  });

  it('counts non-ASCII and astral characters as UTF-8 bytes', () => {
    const doc = { title: 'Ünïcödé 🚀 title — “quoted”', anchors: { 'a-1': { quote: q('const π = 3.14; // 🚀 émoji') }, b: { quote: q('ℵ') } } };
    const text = JSON.stringify(doc);
    const file = Buffer.from(text);
    const pos = quotePositions(text);
    expect(sliceQuote(file, pos.get('a-1')!)).toEqual(doc.anchors['a-1'].quote);
    expect(sliceQuote(file, pos.get('b')!)).toEqual(doc.anchors.b.quote);
    expect(pos.get('b')!.offset).toBe(Buffer.byteLength(text.slice(0, text.lastIndexOf('{"exact":"ℵ"'))));
  });

  it('adds the byte order mark’s 3 bytes', () => {
    const text = JSON.stringify({ anchors: { a: { quote: q('x') } } });
    const file = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]);
    const pos = quotePositions(text, 3);
    expect(sliceQuote(file, pos.get('a')!)).toEqual(q('x'));
  });

  it('keeps the last of duplicate keys, as JSON.parse does', () => {
    const text = '{"anchors":{"a":{"quote":{"exact":"first","prefix":"","suffix":"","norm":"ws"},"quote":{"exact":"second","prefix":"","suffix":"","norm":"ws"}},"b":{"quote":{"exact":"b1"}},"b":{"file":"no quote"}}}';
    const pos = quotePositions(text);
    expect(sliceQuote(Buffer.from(text), pos.get('a')!)).toMatchObject({ exact: 'second' });
    expect(pos.has('b')).toBe(false);
    const again = '{"anchors":{"a":{"quote":{"exact":"old"}}},"anchors":{"z":{"quote":{"exact":"new"}}}}';
    expect([...quotePositions(again).keys()]).toEqual(['z']);
  });

  it('skips nested values, escapes and deep nesting without recursion', () => {
    const deep = '['.repeat(20_000) + ']'.repeat(20_000);
    const text = `{"meta":{"x":[1,{"anchors":{"fake":{"quote":1}}}],"s":"a \\" } ] {"},"deep":${deep},"anchors":{"a\\u0062":{"range":[1,2],"quote":{"exact":"x\\n\\"y\\"","norm":"ws"}}}}`;
    expect(() => JSON.parse(text)).not.toThrow();
    const pos = quotePositions(text);
    expect([...pos.keys()]).toEqual(['ab']);
    expect(sliceQuote(Buffer.from(text), pos.get('ab')!)).toEqual({ exact: 'x\n"y"', norm: 'ws' });
  });

  it('returns nothing for input that isn’t a manifest object', () => {
    expect(quotePositions('[1,2,3]').size).toBe(0);
    expect(quotePositions('"str"').size).toBe(0);
    expect(quotePositions('{"anchors":[{"quote":{}}]}').size).toBe(0);
    expect(quotePositions('').size).toBe(0);
  });

  it('agrees with parseManifest on a real fixture', async () => {
    const { readFile } = await import('node:fs/promises');
    const text = await readFile('fixtures/sample-workspace/.sidestory/retry-backoff/manifest.json', 'utf8');
    const m = parseManifest(text);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    const pos = quotePositions(text);
    for (const a of m.manifest.anchors.values()) {
      if (!a.quote) continue;
      expect(quoteHash(sliceQuote(Buffer.from(text), pos.get(a.id)!) as Quote)).toBe(quoteHash(a.quote));
    }
  });
});

describe('quoteHash', () => {
  it('differs when any part differs, including the field boundaries', () => {
    const base = quoteHash(q('ab', { prefix: 'c' }) as Quote);
    expect(quoteHash(q('ab', { prefix: 'c' }) as Quote)).toBe(base);
    expect(quoteHash(q('a', { prefix: 'bc' }) as Quote)).not.toBe(base);
    expect(quoteHash(q('ab', { prefix: 'c', norm: 'ws-ci' }) as Quote)).not.toBe(base);
  });
});

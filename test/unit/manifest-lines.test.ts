// Line numbers of manifest keys for the checker's findings (src/cli/manifest-lines.ts), and the unused-anchor check's
// exemption for trivial marks (src/cli/checks/links.ts).
import { describe, expect, it } from 'vitest';
import { checkIds } from '../../src/cli/checks/links.ts';
import { manifestLines } from '../../src/cli/manifest-lines.ts';

const MANIFEST = `{
  "version": 3,
  "id": "01J0000000000000000000000A",
  "title": "Retry",
  "base": "main",
  "trivialFiles": ["package-lock.json"],
  "anchors": {
    "retry": {
      "file": "src/retry.ts",
      "range": [1, 4],
      "highlight": ["base", "jitter"],
      "quote": { "exact": "const x = { \\"jitter\\": {} };\\n\\"retry\\": 1", "norm": "ws" }
    },
    "jitter": { "file": "src/jitter.ts", "range": [2, 3] },
    "base": { "file": "src/base.ts", "range": [5, 5], "trivial": true, "why": "renamed" },
    "quote": { "file": "src/q.ts", "range": [1, 1] }
  }
}
`;

describe('manifestLines', () => {
  const lines = manifestLines(MANIFEST);

  it('finds top-level fields', () => {
    expect(lines.key('version')).toBe(2);
    expect(lines.key('id')).toBe(3);
    expect(lines.key('trivialFiles')).toBe(6);
    expect(lines.key('nope')).toBeUndefined();
  });

  it('finds an anchor by its own key, not a field, a highlight entry or text in a quote with the same name', () => {
    expect(lines.anchor('retry')).toBe(8);
    expect(lines.anchor('jitter')).toBe(14); // not the escaped "jitter" inside the quote on line 12
    expect(lines.anchor('base')).toBe(15); // not "base": "main" on line 5, nor the highlight on line 11
    expect(lines.key('base')).toBe(5);
    expect(lines.anchor('missing')).toBeUndefined();
  });

  it('never takes a field inside an anchor for an anchor of that name, or for a top-level field', () => {
    expect(lines.anchor('quote')).toBe(16); // not retry's "quote" on line 12
    expect(lines.key('file')).toBeUndefined();
    expect(lines.key('anchors')).toBe(7);
  });

  it('counts CRLF and lone CR line breaks as one line each', () => {
    const crlf = MANIFEST.replace(/\n/g, '\r\n');
    expect(manifestLines(crlf).anchor('jitter')).toBe(14);
    expect(manifestLines(MANIFEST.replace(/\n/g, '\r')).key('trivialFiles')).toBe(6);
  });

  it('is linear: 3,000 anchors in a 1 MB manifest', () => {
    const anchors = Array.from({ length: 3000 }, (_, i) => `    "a${i}": { "file": "src/f${i}.ts", "range": [1, 2], "quote": { "exact": "${'x'.repeat(280)}" } }`);
    const text = `{\n  "version": 3,\n  "anchors": {\n${anchors.join(',\n')}\n  }\n}\n`;
    expect(text.length).toBeGreaterThan(900_000);
    const t = performance.now();
    const l = manifestLines(text);
    for (let i = 0; i < 3000; i++) expect(l.anchor(`a${i}`)).toBe(4 + i);
    expect(performance.now() - t).toBeLessThan(500);
  });
});

describe('checkIds', () => {
  const page = { anchors: [{ id: 'retry', line: 3 }], refs: [], ons: [] };

  it('reports an unused anchor, but never one used anyway (a trivial mark), whatever the message says', () => {
    const ids = new Set(['retry', 'jitter', 'base']);
    const { manifest } = checkIds(page as never, ids, new Set(), (id) => ({ jitter: 14, base: 15 })[id], new Set(['base']));
    expect(manifest.map((p) => [p.code, p.line, p.message.slice(0, 18)])).toEqual([['unused-anchor', 14, 'Anchor "jitter" is']]);
  });
});

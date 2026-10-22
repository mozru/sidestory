import { describe, expect, it } from 'vitest';
import type { Quote } from '../../src/core/manifest.ts';
import type { AnchorPatch } from '../../src/extension/manifest-edit.ts';
import { minimalReplacement, patchManifest } from '../../src/extension/manifest-edit.ts';

const quote: Quote = { exact: 'int x = 1;', prefix: 'void f() {', suffix: '}', norm: 'ws' };
const patch = (p: Partial<AnchorPatch> = {}) => new Map<string, AnchorPatch>([['a', { range: { start: 4, end: 4 }, quote, ...p }]]);

describe('patchManifest', () => {
  it('keeps a compact v1 manifest compact: the quote takes the snippet\'s place', () => {
    const text = [
      '{"version": 1, "title": "T", "anchors": {',
      '  "a": {"file": "src/x.c", "range": [3, 3], "snippet": "int x", "color": "charts.blue"},',
      '  "b": {"file": "src/y.c", "range": [1, 2]}',
      '}}',
      '',
    ].join('\n');
    const out = patchManifest(text, patch());
    expect(out).toBe(
      [
        '{"version": 2, "title": "T", "anchors": {',
        `  "a": {"file": "src/x.c", "range": [4, 4], "quote": ${JSON.stringify(quote)}, "color": "charts.blue"},`,
        '  "b": {"file": "src/y.c", "range": [1, 2]}',
        '}}',
        '',
      ].join('\n'),
    );
  });

  it('adds a quote to an expanded anchor at its indentation, leaving other anchors alone', () => {
    const text = '{\n\t"version": 1,\n\t"title": "T",\n\t"anchors": {\n\t\t"a": {\n\t\t\t"file": "src/x.c",\n\t\t\t"range": [\n\t\t\t\t4,\n\t\t\t\t4\n\t\t\t]\n\t\t},\n\t\t"b": { "file": "y", "range": [1,2] }\n\t}\n}\n';
    const out = patchManifest(text, patch());
    expect(out).toContain('\t\t\t"range": [\n\t\t\t\t4,\n\t\t\t\t4\n\t\t\t],\n\t\t\t"quote": {\n\t\t\t\t"exact": "int x = 1;",');
    expect(out).toContain('\t\t\t\t"norm": "ws"\n\t\t\t}\n\t\t},\n\t\t"b": { "file": "y", "range": [1,2] }');
    expect(out.startsWith('{\n\t"version": 2,')).toBe(true);
    expect(JSON.parse(out).anchors.a.quote).toEqual(quote);
  });

  it('replaces an existing quote and removes a leftover snippet', () => {
    const text = JSON.stringify({ version: 2, title: 'T', anchors: { a: { snippet: 's', file: 'f', range: [1, 1], quote: { ...quote, exact: 'old' } } } }, null, 2) + '\n';
    const out = patchManifest(text, patch());
    const a = JSON.parse(out).anchors.a;
    expect(a).toEqual({ file: 'f', range: [4, 4], quote });
    expect(out).toContain('  "anchors": {\n    "a": {\n      "file": "f",');
  });

  it('changes the file when re-anchoring elsewhere, and keeps CRLF line ends', () => {
    const text = '{\r\n  "version": 2,\r\n  "title": "T",\r\n  "anchors": {\r\n    "a": {\r\n      "file": "f",\r\n      "range": [1, 1]\r\n    }\r\n  }\r\n}\r\n';
    const out = patchManifest(text, patch({ file: 'src/g.c' }));
    expect(JSON.parse(out).anchors.a).toEqual({ file: 'src/g.c', range: [4, 4], quote });
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('leaves the file byte for byte when nothing changes', () => {
    const text = JSON.stringify({ version: 2, title: 'T', extra: { keep: true }, anchors: { a: { file: 'f', range: [4, 4], quote } } }, null, 4) + '\n';
    expect(patchManifest(text, patch())).toBe(text);
  });

  it('turns a v2 column range into a line range', () => {
    const text = '{"version":2,"title":"T","anchors":{"a":{"file":"f","range":{"start":[1,0],"end":[2,3]}}}}';
    expect(JSON.parse(patchManifest(text, patch())).anchors.a.range).toEqual([4, 4]);
  });

  it('follows JSON.parse on duplicate keys (the last one wins)', () => {
    const text = '{"version":1,"title":"T","anchors":{"a":{"file":"old","range":[1,1]},"a":{"file":"f","range":[2,2]}}}';
    const out = JSON.parse(patchManifest(text, patch()));
    expect(out.anchors.a).toEqual({ file: 'f', range: [4, 4], quote });
  });

  it('refuses an anchor that isn\'t there', () => {
    expect(() => patchManifest('{"version":1,"title":"T","anchors":{}}', patch())).toThrow(/no anchor/);
  });
});

describe('minimalReplacement', () => {
  it('replaces only the part that differs', () => {
    expect(minimalReplacement('abcXdef', 'abcYYdef')).toEqual({ offset: 3, length: 1, content: 'YY' });
    expect(minimalReplacement('aaa', 'aaaa')).toEqual({ offset: 3, length: 0, content: 'a' });
    expect(minimalReplacement('same', 'same')).toEqual({ offset: 4, length: 0, content: '' });
  });
});

// A Windows checkout gives CRLF files (git's core.autocrlf); a manifest pinned on macOS or Linux must still
// resolve the same anchors to the same lines, and a manifest pinned on Windows must work everywhere.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseManifest } from '../../src/core/manifest.ts';
import { pinQuote } from '../../src/core/pin.ts';
import { resolveAnchor } from '../../src/core/resolve.ts';
import { PreparedText, splitLines } from '../../src/core/text.ts';

const WS = 'fixtures/sample-workspace';
const explainers = ['bit-reader', 'retry-backoff', 'overview'];
const crlf = (s: string) => s.replace(/\r?\n/g, '\r\n');

describe('line endings', () => {
  for (const name of explainers) {
    it(`${name}: every anchor resolves to the same lines with LF, CRLF and CR files and manifests`, () => {
      const raw = readFileSync(`${WS}/.explain/${name}/manifest.json`, 'utf8');
      for (const manifestText of [raw, crlf(raw)]) {
        const parsed = parseManifest(manifestText);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        for (const a of parsed.manifest.anchors.values()) {
          const lf = readFileSync(`${WS}/${a.file}`, 'utf8').replace(/\r\n/g, '\n');
          const results = [lf, crlf(lf), lf.replace(/\n/g, '\r')].map((t) => resolveAnchor(new PreparedText(splitLines(t)), a));
          for (const r of results) {
            expect(r.state, `${name}/${a.id}`).toBe(results[0]!.state);
            expect(r.range, `${name}/${a.id}`).toEqual(results[0]!.range);
          }
        }
      }
    });
  }

  it('a quote pinned from a CRLF file equals the one pinned from the LF file', () => {
    const lf = readFileSync(`${WS}/rtl/bit_reader.sv`, 'utf8').replace(/\r\n/g, '\n');
    const range = { start: 35, end: 38 };
    expect(pinQuote(splitLines(crlf(lf)), range)).toEqual(pinQuote(splitLines(lf), range));
  });
});

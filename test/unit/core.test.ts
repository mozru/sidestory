import { describe, expect, it } from 'vitest';
import { anchorParts, isValidBase, parseManifest, partKey, requiredVersion, type Anchor } from '../../src/core/manifest.ts';
import type { Resolution } from '../../src/core/resolve.ts';
import { anchorAtLine } from '../../src/core/sections.ts';
import { contentSimilarity, lcsRatio } from '../../src/core/similarity.ts';
import { trackRange } from '../../src/core/tracking.ts';
import { pinQuote, trimBlankLines } from '../../src/core/pin.ts';
import { PreparedText } from '../../src/core/text.ts';

describe('parseManifest', () => {
  it('accepts the v1 format from the design brief', () => {
    const r = parseManifest(
      JSON.stringify({
        version: 1,
        title: 'Bit reader',
        commit: 'a1b2c3d',
        anchors: { refill: { file: 'rtl/bit_reader.sv', symbol: 'bit_reader', range: [35, 40], snippet: 'if (in_valid && in_ready) begin', highlight: ['in_byte'], color: 'charts.purple' } },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.anchors.get('refill')).toMatchObject({ range: { start: 35, end: 40 }, color: 'charts.purple', highlight: ['in_byte'] });
  });

  it('accepts v2 positions and quotes', () => {
    const r = parseManifest(JSON.stringify({ version: 2, title: 't', anchors: { a: { file: 'f.ts', range: { start: [3, 0], end: [5, 4] }, quote: { exact: 'x' } } } }));
    expect(r.ok && r.manifest.anchors.get('a')).toMatchObject({ range: { start: 3, end: 5 }, quote: { exact: 'x', prefix: '', suffix: '', norm: 'ws' } });
  });

  const one = (anchor: unknown) => parseManifest(JSON.stringify({ version: 1, title: 't', anchors: { a: anchor, ok: { file: 'f.ts', range: [1, 1] } } }));

  it.each([
    ['path escaping the repo', '../etc/passwd'],
    ['absolute path', '/etc/passwd'],
    ['Windows drive', 'C:\\x'],
    ['UNC path', '\\\\server\\share\\x'],
    ['backslash separators', 'src\\x.ts'],
    ['URL', 'file:///etc/passwd'],
    ['remote URL', 'https://evil/x'],
    ['NUL byte', 'a\u0000b'],
    ['newline', 'a\nb'],
    ['dot segment', './x'],
    ['empty segment', 'a//b'],
    ['trailing space segment', 'a/.. /b'],
    ['trailing dot segment', 'a/b.'],
    ['Windows device name', 'src/CON'],
    ['.git internals', '.git/config'],
    ['very long path', 'a/'.repeat(600) + 'x'],
  ])('drops an anchor whose file is a %s, keeps the others', (_, file) => {
    const r = one({ file, range: [1, 1] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.anchors.has('a')).toBe(false);
    expect(r.manifest.anchors.has('ok')).toBe(true);
    expect(r.diagnostics).toEqual([expect.objectContaining({ anchor: 'a' })]);
  });

  it.each([
    ['inverted range', { file: 'f', range: [5, 2] }],
    ['hex color', { file: 'f', range: [1, 1], color: '#ff0000' }],
    ['CSS injection in color', { file: 'f', range: [1, 1], color: 'red;background:url(x)' }],
    ['non-identifier highlight', { file: 'f', range: [1, 1], highlight: ['a|b'] }],
    ['empty quote', { file: 'f', range: [1, 1], quote: { exact: '' } }],
  ])('drops an anchor with %s', (_, anchor) => {
    const r = one(anchor);
    expect(r.ok && r.manifest.anchors.has('a')).toBe(false);
    expect(r.ok && r.diagnostics.length).toBe(1);
  });

  it.each(['a"b', '1a', '_x', '__proto__', 'x'.repeat(65)])('drops anchor id %j', (id) => {
    const r = parseManifest(JSON.stringify({ version: 1, title: 't', anchors: { [id]: { file: 'f', range: [1, 1] } } }));
    expect(r.ok && r.manifest.anchors.size).toBe(0);
  });

  it('fails the whole manifest only for a broken top level', () => {
    expect(parseManifest('{')).toMatchObject({ ok: false, code: 'invalid' });
    expect(parseManifest(JSON.stringify({ version: 1, anchors: {} }))).toMatchObject({ ok: false, code: 'invalid' });
    expect(parseManifest(JSON.stringify({ version: 1, title: 't', commit: '--output=/tmp/x', anchors: {} }))).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('reports a future version distinctly', () => {
    expect(parseManifest(JSON.stringify({ version: 4, title: 't', anchors: {} }))).toMatchObject({ ok: false, code: 'unsupported-version' });
  });

  it('refuses oversized manifests', () => {
    expect(parseManifest(' '.repeat(1_000_001))).toMatchObject({ ok: false, code: 'too-large' });
  });

  it('accepts a byte order mark', () => {
    expect(parseManifest('\uFEFF' + JSON.stringify({ version: 1, title: 't', anchors: {} })).ok).toBe(true);
  });

  it('keeps fields it does not model, for lossless rewrites', () => {
    const doc = { version: 2, title: 't', order: ['a'], anchors: { a: { file: 'f', range: { start: [1, 2], end: [3, 4] }, symbol: 'm', pin: { commit: 'abc1234' } } } };
    const r = parseManifest(JSON.stringify(doc));
    expect(r.ok && r.manifest.raw).toEqual(doc);
  });
});

describe('trackRange', () => {
  const r = { start: 10, end: 13 };
  const at = (line: number, col = 0) => ({ line, col });

  it('shifts when lines are inserted above', () => {
    expect(trackRange(r, { start: at(2, 5), end: at(2, 5), text: '\n\n' })).toEqual({ range: { start: 12, end: 15 }, orphaned: false });
  });

  it('shifts when a line is inserted at column 0 of the first line', () => {
    expect(trackRange(r, { start: at(10), end: at(10), text: 'x\n' }).range).toEqual({ start: 11, end: 14 });
  });

  it('shifts up when lines above are deleted', () => {
    expect(trackRange(r, { start: at(3), end: at(5), text: '' }).range).toEqual({ start: 8, end: 11 });
  });

  it('does nothing for edits below', () => {
    expect(trackRange(r, { start: at(14), end: at(20), text: '' }).range).toEqual(r);
  });

  it('grows and shrinks with edits inside', () => {
    expect(trackRange(r, { start: at(11, 4), end: at(11, 4), text: '\n' }).range).toEqual({ start: 10, end: 14 });
    expect(trackRange(r, { start: at(11, 0), end: at(12, 0), text: '' }).range).toEqual({ start: 10, end: 12 });
  });

  it('typing within a line changes nothing', () => {
    expect(trackRange(r, { start: at(11, 3), end: at(11, 3), text: 'abc' }).range).toEqual(r);
  });

  it('is orphaned when the whole range is replaced', () => {
    expect(trackRange(r, { start: at(9), end: at(14), text: 'new' }).orphaned).toBe(true);
  });

  it('extends to an edit that overlaps the start', () => {
    expect(trackRange(r, { start: at(8, 2), end: at(11, 0), text: '' })).toEqual({ range: { start: 8, end: 10 }, orphaned: false });
  });
});

describe('similarity', () => {
  it('lcsRatio', () => {
    expect(lcsRatio([], [])).toBe(1);
    expect(lcsRatio(['a', 'b', 'c'], ['a', 'c'])).toBeCloseTo(0.8);
  });

  it('contentSimilarity is 1 for equal text and drops with edits', () => {
    expect(contentSimilarity(['a = b + c;'], ['a = b + c;'])).toBe(1);
    expect(contentSimilarity(['a = b + c;'], ['a = b - c;'])).toBeCloseTo(5 / 6);
  });
});

describe('anchorAtLine', () => {
  const res = (start: number, end: number, state: Resolution['state'] = 'exact'): Resolution => ({
    state,
    range: state === 'lost' ? null : { start, end },
    location: 1,
    similarity: 1,
    ambiguous: false,
    method: 'hint',
  });

  it('picks the tightest range containing the line', () => {
    const m = new Map([
      ['outer', res(1, 20)],
      ['inner', res(5, 8)],
    ]);
    expect(anchorAtLine(m, 6)).toBe('inner');
    expect(anchorAtLine(m, 10)).toBe('outer');
    expect(anchorAtLine(m, 30)).toBeUndefined();
  });

  it('prefers a trustworthy anchor over a stale one and ignores lost ones', () => {
    const m = new Map([
      ['stale', res(5, 6, 'stale')],
      ['fine', res(1, 20)],
      ['gone', res(5, 6, 'lost')],
    ]);
    expect(anchorAtLine(m, 5)).toBe('fine');
  });
});

describe('trackRange: review regressions', () => {
  const r = { start: 10, end: 13 };
  const at = (line: number, col = 0) => ({ line, col });

  it('an edit crossing the range end only removes the lines it took from the range', () => {
    expect(trackRange(r, { start: at(12, 2), end: at(16, 0), text: '' }).range).toEqual({ start: 10, end: 12 });
  });

  it('joining the next line onto the last line keeps the range', () => {
    expect(trackRange(r, { start: at(13, 6), end: at(14, 0), text: '' }).range).toEqual({ start: 10, end: 13 });
  });

  it('replacing the whole range up to the end of its last line orphans it', () => {
    expect(trackRange(r, { start: at(10, 0), end: at(13, 6), text: 'x', endTail: 0 }).orphaned).toBe(true);
    expect(trackRange(r, { start: at(9, 5), end: at(13, 6), text: '', endTail: 0 }).orphaned).toBe(true);
  });

  it('replacing most of the range (text left on the last line) does not orphan it', () => {
    expect(trackRange(r, { start: at(10, 0), end: at(13, 2), text: 'x', endTail: 4 }).orphaned).toBe(false);
  });

  it('a paste over the top of the range keeps the surviving lines', () => {
    const text = 'x\n'.repeat(100);
    expect(trackRange(r, { start: at(5, 0), end: at(11, 0), text }).range).toEqual({ start: 105, end: 107 });
  });

  it('Enter at the end of the last line adds the new line below the range', () => {
    expect(trackRange(r, { start: at(13, 6), end: at(13, 6), text: '\n    ', endTail: 0 }).range).toEqual(r);
  });
});

describe('pinQuote', () => {
  const lines = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

  it('records the region and up to three lines of context', () => {
    expect(pinQuote(lines, { start: 4, end: 5 })).toEqual({ exact: 'd\ne', prefix: 'a\nb\nc', suffix: 'f\ng', norm: 'ws' });
  });

  it('refuses blank-only and out-of-range regions', () => {
    expect(pinQuote(['', '  ', 'x'], { start: 1, end: 2 })).toBeNull();
    expect(pinQuote(lines, { start: 9, end: 9 })).toBeNull();
    expect(pinQuote(lines, { start: 0, end: 1 })).toBeNull();
  });

  it('leaves blank lines at the edges of the range out of the quote (they become context)', () => {
    const code = ['x', '', 'a', 'b', '', '', 'y'];
    expect(pinQuote(code, { start: 2, end: 6 })).toEqual({ exact: 'a\nb', prefix: 'x\n', suffix: '\n\ny', norm: 'ws' });
    expect(trimBlankLines(code, { start: 2, end: 6 })).toEqual({ start: 3, end: 4 });
    expect(trimBlankLines(code, { start: 5, end: 6 })).toBeNull();
    expect(trimBlankLines(code, { start: 7, end: 99 })).toEqual({ start: 7, end: 7 });
  });

  it('keeps whole context lines, nearest first, within about 160 characters', () => {
    const long = ['x'.repeat(100), 'y'.repeat(100), 'z'.repeat(100), 'HERE', 'p'.repeat(200)];
    const q = pinQuote(long, { start: 4, end: 4 })!;
    expect(q.prefix).toBe('z'.repeat(100));
    expect(q.suffix).toBe('p'.repeat(200));
  });
});

describe('PreparedText', () => {
  it('splits CRLF, CR and LF, and normalizes once per mode', () => {
    const t = PreparedText.from('a\r\n  B  c\rd\n');
    expect(t.lines).toEqual(['a', '  B  c', 'd', '']);
    expect(t.normalized('ws')).toEqual(['a', 'B c', 'd', '']);
    expect(t.normalized('ws-ci')).toEqual(['a', 'b c', 'd', '']);
    expect(t.normalized('ws')).toBe(t.normalized('ws'));
  });
});

describe('trackRange: round 2 regressions', () => {
  const at = (line: number, col = 0) => ({ line, col });

  it('a replacement ending in a newline at column 0 does not swallow the next line', () => {
    expect(trackRange({ start: 3, end: 3 }, { start: at(3), end: at(4), text: 'x\n' })).toEqual({ range: { start: 3, end: 3 }, orphaned: true });
    expect(trackRange({ start: 10, end: 13 }, { start: at(12), end: at(16), text: 'x\n' }).range).toEqual({ start: 10, end: 12 });
    expect(trackRange({ start: 10, end: 13 }, { start: at(12), end: at(16), text: '' }).range).toEqual({ start: 10, end: 11 });
  });

  it('Enter that replaces trailing whitespace on the last line adds the line below', () => {
    expect(trackRange({ start: 10, end: 13 }, { start: at(13, 6), end: at(13, 8), text: '\n  ', endTail: 0 }).range).toEqual({ start: 10, end: 13 });
  });
});

describe('group and top', () => {
  const base = { version: 2, title: 'T', anchors: {} };
  it('reads a valid group, trimmed, and top', () => {
    const r = parseManifest(JSON.stringify({ ...base, group: '  Storage ', top: true }));
    expect(r.ok && r.manifest.group).toBe('Storage');
    expect(r.ok && r.manifest.top).toBe(true);
    expect(r.ok && r.diagnostics).toEqual([]);
  });
  it.each([
    [42, 'must be a string'],
    ['   ', 'is empty'],
    ['x'.repeat(61), 'longer than 60'],
    ['a\u0007b', 'control'],
  ])('ignores a bad group (%j) with a diagnostic, and still loads', (group, msg) => {
    const r = parseManifest(JSON.stringify({ ...base, group }));
    expect(r.ok).toBe(true);
    expect(r.ok && r.manifest.group).toBeUndefined();
    expect(r.ok && r.diagnostics.map((d) => d.message).join()).toMatch(new RegExp(`^group: .*${msg}.*; ignored$`));
  });
  it('tolerates unknown top-level fields (a future "change": {"base": "main"}) and keeps them in raw', () => {
    const r = parseManifest(JSON.stringify({ ...base, change: { base: 'main' } }));
    expect(r.ok && r.diagnostics).toEqual([]);
    expect(r.ok && r.manifest.raw.change).toEqual({ base: 'main' });
  });
  it('ignores a non-boolean top with a diagnostic', () => {
    const r = parseManifest(JSON.stringify({ ...base, top: 'yes' }));
    expect(r.ok && r.manifest.top).toBeUndefined();
    expect(r.ok && r.diagnostics[0]?.message).toBe('top: must be true or false; ignored');
  });
});

describe('Anchor.parts (docs/AUTHORING-PLAN.md §1.1, release 1: the type only)', () => {
  it('every parsed anchor is normalized to one part equal to its own code fields', () => {
    const r = parseManifest(JSON.stringify({ version: 2, title: 't', anchors: { a: { file: 'x.sv', range: [3, 5], highlight: ['q'], color: 'charts.red' } } }));
    if (!r.ok) throw new Error(r.error);
    const a = r.manifest.anchors.get('a')!;
    expect(a.parts).toEqual([{ file: 'x.sv', range: { start: 3, end: 5 }, quote: undefined, snippet: undefined, highlight: ['q'] }]);
    expect(anchorParts(a)).toBe(a.parts);
  });
  it('an anchor built without parts reads as its own single part', () => {
    const a: Anchor = { id: 'b', file: 'y.ts', range: { start: 1, end: 2 }, highlight: [] };
    expect(anchorParts(a)).toEqual([{ file: 'y.ts', range: { start: 1, end: 2 }, quote: undefined, snippet: undefined, highlight: [] }]);
  });
  it('partKey: part 1 is the id itself, later parts can never collide with an id', () => {
    expect(partKey('done')).toBe('done');
    expect(partKey('done', 0)).toBe('done');
    expect(partKey('done', 1)).toBe('done:2');
    const r = parseManifest(JSON.stringify({ version: 2, title: 't', anchors: { 'done:2': { file: 'x', range: [1, 1] } } }));
    expect(r.ok && r.manifest.anchors.has('done:2')).toBe(false);
  });
});

describe('branch fields (docs/CHANGES-PLAN.md §3, §16.1)', () => {
  const parse = (extra: Record<string, unknown>, anchors: Record<string, unknown> = {}) => {
    const r = parseManifest(JSON.stringify({ version: 2, title: 'T', anchors, ...extra }));
    if (!r.ok) throw new Error(r.error);
    return r;
  };
  const SHA = '0123456789abcdef0123456789abcdef01234567';

  it('base grammar: names and full ids, never short ids or git syntax', () => {
    for (const ok of ['main', 'release/2.1', 'v1.4.0', 'origin/main', SHA, 'a'.repeat(64)]) expect(isValidBase(ok), ok).toBe(true);
    for (const bad of ['-x', 'a..b', 'a@{1}', 'x.lock', 'HEAD', 'FETCH_HEAD', 'ORIG_HEAD', 'MERGE_HEAD', 'x/', '/x', 'a//b', 'a b', '', 'x'.repeat(201), 'a/.b']) expect(isValidBase(bad), bad).toBe(false);
    // A short hex id is a ref name, never an abbreviated commit.
    expect(parse({ base: 'abc1234' }).manifest.base).toBe('abc1234');
  });

  it('a bad base is a diagnostic and the sidestory is a plain file story', () => {
    const r = parse({ base: 'a..b', head: SHA, trivialFiles: ['x'] });
    expect(r.manifest.base).toBeUndefined();
    expect(r.manifest.head).toBeUndefined();
    expect(r.manifest.trivialFiles).toBeUndefined();
    expect(r.diagnostics.map((d) => d.message.split(':')[0])).toEqual(['base', 'head', 'trivialFiles']);
  });

  it('head needs base and a full id', () => {
    expect(parse({ head: SHA }).diagnostics[0]!.message).toMatch(/head: needs a valid "base"/);
    expect(parse({ base: 'main', head: 'abc1234' }).diagnostics[0]!.message).toMatch(/full commit id/);
    expect(parse({ base: 'main', head: SHA }).manifest.head).toBe(SHA);
  });

  it('trivialFiles: limits, no "..", no leading "/"', () => {
    const r = parse({ base: 'main', trivialFiles: ['package-lock.json', '**/__snapshots__/**', '../x', '/abs', 'a/{b,c}', 'x'.repeat(201), 3] });
    expect(r.manifest.trivialFiles).toEqual(['package-lock.json', '**/__snapshots__/**']);
    expect(r.diagnostics).toHaveLength(5);
    const many = parse({ base: 'main', trivialFiles: Array.from({ length: 101 }, (_, i) => `f${i}`) });
    expect(many.manifest.trivialFiles).toHaveLength(100);
  });

  it('side, trivial and why', () => {
    const r = parse({ version: 3, base: 'main' }, {
      old: { file: 'a.ts', range: [1, 2], side: 'base' },
      t: { file: 'a.ts', range: [1, 2], trivial: true, why: ' import order ' },
      noWhy: { file: 'a.ts', range: [1, 2], trivial: true },
      bad: { file: 'a.ts', range: [1, 2], side: 'left' },
    });
    expect(r.manifest.anchors.get('old')!.side).toBe('base');
    expect(r.manifest.anchors.get('t')).toMatchObject({ trivial: true, why: 'import order' });
    expect(r.manifest.anchors.get('noWhy')).toMatchObject({ trivial: true });
    expect(r.manifest.anchors.get('noWhy')!.why).toBeUndefined();
    expect(r.manifest.anchors.has('bad')).toBe(false);
    expect(r.diagnostics.map((d) => d.anchor)).toEqual(['noWhy', 'bad']);
  });

  it('side "base" without a base skips the anchor', () => {
    const r = parse({}, { old: { file: 'a.ts', range: [1, 2], side: 'base' } });
    expect(r.manifest.anchors.has('old')).toBe(false);
    expect(r.diagnostics[0]!.message).toMatch(/needs a valid top-level "base"/);
  });

  it('the version rule: side "base" needs 3, the rest leaves it unchanged', () => {
    expect(requiredVersion({ anchors: { a: { side: 'base' } } })).toBe(3);
    expect(requiredVersion({ anchors: { a: { trivial: true, why: 'x' }, b: { side: 'head' } } })).toBe(2);
    const old = parse({ base: 'main' }, { old: { file: 'a.ts', range: [1, 2], side: 'base' } });
    expect(old.manifest.anchors.has('old')).toBe(true);
    expect(old.diagnostics.at(-1)!.message).toMatch(/need "version": 3/);
    expect(parse({ version: 3, base: 'main' }, { old: { file: 'a.ts', range: [1, 2], side: 'base' } }).diagnostics).toEqual([]);
  });

  it('id: a ULID, or a diagnostic', () => {
    expect(parse({ id: '01JB0000000000000000000000' }).manifest.id).toBe('01JB0000000000000000000000');
    expect(parse({ id: 'nope' }).diagnostics[0]!.message).toMatch(/^id: must be a ULID/);
  });
});

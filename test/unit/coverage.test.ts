// Coverage (src/core/coverage.ts): every row of docs/CHANGES-PLAN.md §6.3, and which anchors a page uses (§6.2).
import { describe, expect, it } from 'vitest';
import { coverage, COVERAGE_LIMITS, normLine, usedAnchorIds, type FileInput, type Target } from '../../src/core/coverage.ts';
import { diffTexts, moveCarriers, movedPrefix, moveFiles, moveGroups, moveLabel, textLines } from '../../src/core/hunks.ts';
import { globMatcher } from '../../src/core/glob.ts';

const text = (lines: string[]) => (lines.length ? `${lines.join('\n')}\n` : '');
const range = (n: number, p = 'line') => Array.from({ length: n }, (_, i) => `${p} ${i + 1}`);

function file(path: string, oldLines: string[], newLines: string[], extra: Partial<FileInput> = {}): FileInput {
  const d = diffTexts(path, text(oldLines), text(newLines));
  return { path, changes: d.changes, newLine: (l) => newLines[l - 1] ?? '', trivialFile: false, newLines: newLines.length, ...extra };
}

const T = (anchor: string, side: 'head' | 'base', start: number, end: number, extra: Partial<Target> = {}): Target => ({
  sidestory: '.sidestory/demo',
  anchor,
  path: 'src/a.ts',
  side,
  range: { start, end },
  state: 'exact',
  ...extra,
});

const old10 = range(10);
/** Lines 4–6 replaced by 4 new lines (new 4–7). */
const replaced = [...old10.slice(0, 3), 'n1', 'n2', 'n3', 'n4', ...old10.slice(6)];
/** Lines 4–5 added after line 3. */
const addedOnly = [...old10.slice(0, 3), 'a1', 'a2', ...old10.slice(3)];

const one = (f: FileInput, targets: Target[]) => coverage([f], targets).files[0]!.changes[0]!;

describe('§6.3: added lines', () => {
  it('explained when every added line is in a head-side target', () => {
    expect(one(file('src/a.ts', old10, addedOnly), [T('s', 'head', 3, 6)])).toMatchObject({ state: 'explained', coveredLines: 2, changedLines: 2, by: [{ anchor: 's' }] });
  });
  it('unexplained without a target, and a base-side target never covers added lines', () => {
    const c = one(file('src/a.ts', old10, addedOnly), [T('b', 'base', 1, 10)]);
    expect(c).toMatchObject({ state: 'unexplained', coveredLines: 0, uncovered: [{ side: 'head', range: { start: 4, end: 5 } }] });
  });
  it('partly explained counts as not explained', () => {
    const r = coverage([file('src/a.ts', old10, addedOnly)], [T('s', 'head', 1, 4)]);
    expect(r.files[0]!.changes[0]).toMatchObject({ state: 'partly', coveredLines: 1, changedLines: 2, uncovered: [{ side: 'head', range: { start: 5, end: 5 } }] });
    expect(r.totals).toMatchObject({ changes: 1, explained: 0, left: 1 });
  });
  it('targets in another file or lost cover nothing', () => {
    expect(one(file('src/a.ts', old10, addedOnly), [T('s', 'head', 1, 10, { path: 'src/b.ts' })]).state).toBe('unexplained');
    expect(one(file('src/a.ts', old10, addedOnly), [T('s', 'head', 1, 10, { state: 'lost' })]).state).toBe('unexplained');
    expect(one(file('src/a.ts', old10, addedOnly), [T('s', 'head', 1, 10, { range: null })]).state).toBe('unexplained');
  });
});

describe('§6.3: removed lines', () => {
  it('a replacement is explained by one head-side target over its whole new range', () => {
    expect(one(file('src/a.ts', old10, replaced), [T('s', 'head', 4, 7)]).state).toBe('explained');
    // Not over the whole new range: the removed lines stay uncovered.
    const c = one(file('src/a.ts', old10, replaced), [T('s', 'head', 4, 6)]);
    expect(c.state).toBe('partly');
    expect(c.uncovered).toEqual([{ side: 'head', range: { start: 7, end: 7 } }, { side: 'base', range: { start: 4, end: 6 } }]);
  });
  it('a replacement: head target for the new lines, base target for the old', () => {
    const c = one(file('src/a.ts', old10, replaced), [T('n', 'head', 5, 7), T('n0', 'head', 4, 4), T('o', 'base', 4, 6)]);
    expect(c.state).toBe('explained');
  });
  it('a pure deletion is explained by a base-side target', () => {
    const del = [...old10.slice(0, 3), ...old10.slice(6)];
    expect(one(file('src/a.ts', old10, del), [T('o', 'base', 4, 6)]).state).toBe('explained');
    expect(one(file('src/a.ts', old10, del), [T('o', 'base', 4, 5)])).toMatchObject({ state: 'partly', uncovered: [{ side: 'base', range: { start: 6, end: 6 } }] });
  });
  it('a pure deletion: a head-side target over both lines around it, not one side only', () => {
    const del = [...old10.slice(0, 3), ...old10.slice(6)]; // deleted between new 3 and new 4
    expect(one(file('src/a.ts', old10, del), [T('s', 'head', 3, 4)]).state).toBe('explained');
    expect(one(file('src/a.ts', old10, del), [T('s', 'head', 1, 3)]).state).toBe('unexplained');
    expect(one(file('src/a.ts', old10, del), [T('s', 'head', 4, 6)]).state).toBe('unexplained');
  });
  it('two deletions merged into one change: the lines around each must be covered', () => {
    // line 3 and line 5 deleted, line 4 kept between them: one change, at new 3 and new 4.
    const del = [old10[0]!, old10[1]!, old10[3]!, ...old10.slice(5)];
    const f = file('src/a.ts', old10, del);
    expect(f.changes).toHaveLength(1);
    expect(one(f, [T('s', 'head', 2, 3)]).state).toBe('unexplained');
    expect(one(f, [T('s', 'head', 2, 4)]).state).toBe('explained');
  });
  it('a pure deletion at the end of the file: the line before it is enough', () => {
    expect(one(file('src/a.ts', old10, old10.slice(0, 7)), [T('s', 'head', 6, 7)]).state).toBe('explained');
    // At the start: the line after it.
    expect(one(file('src/a.ts', old10, old10.slice(3)), [T('s', 'head', 1, 1)]).state).toBe('explained');
  });
  it('a pure deletion of 20 lines is covered by a head-side target around it, of 21 is not', () => {
    const big = range(60);
    const del20 = [...big.slice(0, 10), ...big.slice(30)];
    const del21 = [...big.slice(0, 10), ...big.slice(31)];
    expect(COVERAGE_LIMITS.pureDeletionContext).toBe(20);
    expect(one(file('src/a.ts', big, del20), [T('s', 'head', 10, 11)]).state).toBe('explained');
    expect(one(file('src/a.ts', big, del21), [T('s', 'head', 10, 11)]).state).toBe('unexplained');
    expect(one(file('src/a.ts', big, del21), [T('o', 'base', 11, 31)]).state).toBe('explained');
  });
  it('base-side targets resolve against the old path of a renamed file', () => {
    const del = [...old10.slice(0, 3), ...old10.slice(6)];
    const f = file('src/new.ts', old10, del, { oldPath: 'src/old.ts' });
    expect(one(f, [T('o', 'base', 4, 6, { path: 'src/old.ts' })]).state).toBe('explained');
    expect(one(f, [T('o', 'base', 4, 6, { path: 'src/new.ts' })]).state).toBe('unexplained');
  });
});

describe('blank lines', () => {
  it('a blank line at the edge of an added block needs no cover (pinning trims it from the anchor)', () => {
    const nu = [...old10.slice(0, 3), '', 'function f() {', '}', ...old10.slice(3)];
    const c = one(file('src/a.ts', old10, nu), [T('s', 'head', 5, 6)]);
    expect(c).toMatchObject({ state: 'explained', coveredLines: 2, changedLines: 2 });
    expect(one(file('src/a.ts', old10, nu), [T('s', 'head', 5, 5)])).toMatchObject({ state: 'partly', uncovered: [{ side: 'head', range: { start: 6, end: 6 } }] });
  });
  it('removed blank lines need no cover when the old text is given', () => {
    const old = [...old10.slice(0, 3), '', 'gone();', ...old10.slice(3)];
    const f = { ...file('src/a.ts', old, old10), oldLine: (l: number) => old[l - 1] ?? '' };
    expect(one(f, [T('o', 'base', 5, 5)]).state).toBe('explained');
  });
  it('a change of nothing but blank lines still needs cover', () => {
    const nu = [...old10.slice(0, 3), '', '', ...old10.slice(3)];
    expect(one(file('src/a.ts', old10, nu), [])).toMatchObject({ state: 'unexplained', changedLines: 2 });
  });
});

describe('§6.3: trivial', () => {
  it('a trivialFiles file is trivial, counted apart from explained', () => {
    const match = globMatcher(['package-lock.json', '**/__snapshots__/**']);
    const files = ['package-lock.json', 'src/__snapshots__/x.snap', 'src/a.ts'].map((p) => file(p, old10, addedOnly, { trivialFile: match(p) }));
    const r = coverage(files, []);
    expect(r.files.map((f) => f.changes[0]!.state)).toEqual(['trivial', 'trivial', 'unexplained']);
    expect(r.totals).toEqual({ changes: 3, explained: 0, trivial: 2, left: 1, needsLook: 0, files: 3 });
  });
  it('files with no change (line endings only, or none) are not in totals.files', () => {
    const crlf = diffTexts('src/b.ts', 'a\nb\n', 'a\r\nb');
    expect(crlf.lineEndingsOnly).toBe(true);
    const r = coverage([file('src/a.ts', old10, addedOnly), { path: 'src/b.ts', changes: crlf.changes, newLine: () => '', trivialFile: false }, file('src/c.ts', old10, old10)], []);
    expect(r.totals).toMatchObject({ changes: 1, files: 1 });
  });
  it('a change inside trivial anchors is trivial, with their why', () => {
    const c = one(file('src/a.ts', old10, addedOnly), [T('trivial-1', 'head', 4, 5, { trivial: true, why: 'import order' })]);
    expect(c).toMatchObject({ state: 'trivial', why: ['import order'] });
  });
  it('half trivial and half a step is trivial; a step over all of it is explained', () => {
    const f = file('src/a.ts', old10, addedOnly);
    expect(one(f, [T('trivial-1', 'head', 4, 4, { trivial: true, why: 'format' }), T('s', 'head', 5, 5)]).state).toBe('trivial');
    expect(one(f, [T('trivial-1', 'head', 4, 4, { trivial: true, why: 'format' }), T('s', 'head', 4, 5)]).state).toBe('explained');
  });
});

describe('§6.3: changed since pinned, stale, broad', () => {
  it('an added line inside a pinned target that is not in its quote needs a look; re-pinning clears it', () => {
    const f = file('src/a.ts', old10, addedOnly);
    const before = new Set(['line 3', 'a1', 'line 4'].map(normLine));
    const c = one(f, [T('s', 'head', 3, 6, { pinned: before })]);
    expect(c).toMatchObject({ state: 'needsLook', needsLook: [{ anchor: 's', lines: [5] }] });
    const r = coverage([f], [T('s', 'head', 3, 6, { pinned: before })]);
    expect(r.totals).toMatchObject({ left: 1, needsLook: 1, explained: 0 });
    const after = new Set(['line 3', 'a1', 'a2', 'line 4'].map(normLine));
    expect(one(f, [T('s', 'head', 3, 6, { pinned: after })]).state).toBe('explained');
    // Unpinned targets can't be checked this way.
    expect(one(f, [T('s', 'head', 3, 6)]).state).toBe('explained');
  });
  it('quote lines compare with whitespace collapsed; a blank added line needs no look', () => {
    const f = file('src/a.ts', old10, [...old10.slice(0, 3), '  a1   x', '', ...old10.slice(3)]);
    expect(one(f, [T('s', 'head', 3, 6, { pinned: new Set([normLine('a1 x')]) })]).state).toBe('explained');
  });
  it('stale targets cover but flag', () => {
    expect(one(file('src/a.ts', old10, addedOnly), [T('s', 'head', 4, 5, { state: 'stale' })])).toMatchObject({ state: 'explained', stale: true });
  });
  it('anchor-broad: more than 40 lines and more than 5 times what it explains', () => {
    const big = range(100);
    const f = file('src/a.ts', big, [...big.slice(0, 50), 'x', ...big.slice(50)]);
    const r = coverage([f], [T('s', 'head', 1, 101)]);
    expect(r.files[0]!.changes[0]).toMatchObject({ state: 'explained', broad: true });
    expect(r.targets[0]).toMatchObject({ lines: 101, explains: 1, broad: true });
    // 40 lines is not broad, whatever it explains.
    expect(coverage([f], [T('s', 'head', 31, 70)]).targets[0]!.broad).toBe(false);
    // 41 lines explaining 9: 41 ≤ 45, not broad.
    const nine = file('src/a.ts', big, [...big.slice(0, 50), ...range(9, 'x'), ...big.slice(50)]);
    expect(coverage([nine], [T('s', 'head', 30, 70)]).targets[0]).toMatchObject({ lines: 41, explains: 9, broad: false });
    expect(coverage([nine], [T('s', 'head', 10, 70)]).targets[0]).toMatchObject({ lines: 61, explains: 9, broad: true });
  });
});

describe('monorepos and scale', () => {
  it('targets carry repo-relative paths, so package roots match the diff paths', () => {
    const f = file('services/auth/src/a.ts', old10, addedOnly);
    expect(one(f, [T('s', 'head', 4, 5, { path: 'services/auth/src/a.ts', sidestory: 'services/auth/.sidestory/x' })])).toMatchObject({ state: 'explained', by: [{ sidestory: 'services/auth/.sidestory/x' }] });
  });
  it('5,000 files × 20 changes × 500 targets in well under a second', () => {
    const base = range(200);
    const nu = base.flatMap((l, i) => (i % 10 === 0 ? [l, `new ${i}`] : [l]));
    const d = diffTexts('x', text(base), text(nu));
    expect(d.changes).toHaveLength(20);
    const files: FileInput[] = Array.from({ length: 5000 }, (_, i) => ({ path: `f${i}.ts`, changes: d.changes, newLine: (l) => nu[l - 1]!, trivialFile: false }));
    const targets: Target[] = Array.from({ length: 500 }, (_, i) => T(`a${i}`, 'head', 1, 220, { path: `f${i * 10}.ts` }));
    const t0 = performance.now();
    const r = coverage(files, targets);
    const ms = performance.now() - t0;
    expect(r.totals.changes).toBe(100_000);
    expect(r.totals.explained).toBe(500 * 20);
    expect(ms).toBeLessThan(1000); // §16.1's target is 100 ms; CI machines vary
  });
});

describe('usedAnchorIds (§6.2)', () => {
  it('sections, refs and data-explain-on, not code links or dropped elements', () => {
    const html = `<section data-explain-anchor="a"><p><span data-explain-ref="b">x</span></p>
      <svg data-explain-diagram><g data-explain-on="c d"></g></svg><a data-explain-code="src/x.ts#L1">x</a>
      <template><section data-explain-anchor="hidden"></section></template><script>data-explain-anchor="no"</script></section>`;
    const r = usedAnchorIds(html);
    expect(r.incomplete).toBe(false);
    expect([...r.ids].sort()).toEqual(['a', 'b', 'c', 'd']);
  });
  it('stops at a deterministic token limit and says so', () => {
    const html = '<b></b>'.repeat(1_000_001) + '<section data-explain-anchor="late"></section>';
    const r = usedAnchorIds(html);
    expect(r.incomplete).toBe(true);
    expect(r.ids.has('late')).toBe(false);
  });
});

describe('moves (§5.1): one change per moved prefix', () => {
  const same = text(range(5));
  const edited = text([...range(4), 'changed']);
  const entries = [
    { status: 'R', oldPath: 'src/a/one.js', path: 'src/b/one.js' },
    { status: 'R', oldPath: 'src/a/two.js', path: 'src/b/two.js' },
    { status: 'R', oldPath: 'src/a/deep/three.js', path: 'src/b/deep/three.js' },
    { status: 'R', oldPath: 'src/auth.js', path: 'src/disabled/auth.js' },
    { status: 'R', oldPath: 'lib/old-name.js', path: 'lib/new-name.js' },
    { status: 'M', path: 'src/x.js' },
    { status: 'R', oldPath: 'same.js', path: 'same.js' },
  ];
  const input = (path: string, newText: string, extra: Partial<FileInput> = {}): FileInput => {
    const d = diffTexts(path, same, newText);
    return { path, changes: d.changes, newLine: (l) => textLines(newText)[l - 1] ?? '', trivialFile: false, newLines: d.newLines, ...extra };
  };
  const build = (trivial: (p: string) => boolean = () => false) => {
    const files = [input('src/b/deep/three.js', edited), input('src/b/one.js', same), input('src/b/two.js', same), input('src/disabled/auth.js', same), input('lib/new-name.js', same)].map((f) => ({ ...f, trivialFile: trivial(f.path) }));
    const carried = moveCarriers(moveGroups(entries), (p) => files.some((f) => f.path === p));
    for (const f of files) if (carried.has(f.path)) f.changes = [carried.get(f.path)!, ...f.changes];
    return files;
  };
  const moveOf = (files: FileInput[], targets: Target[] = []) => coverage(files, targets).files.find((f) => f.path === 'src/b/deep/three.js')!.changes[0]!;
  it('groups by the moved prefix (subfolders included); a rename within a folder is its own change', () => {
    expect(movedPrefix('src/a/x/y.ts', 'src/b/x/y.ts')).toEqual({ from: 'src/a', to: 'src/b' });
    expect(movedPrefix('src/a/x.ts', 'lib/y.ts')).toEqual({ from: 'src/a/x.ts', to: 'lib/y.ts' });
    expect(movedPrefix('README.md', 'lib/README.md')).toEqual({ from: '', to: 'lib' });
    const groups = moveGroups(entries);
    expect(groups.map((g) => [g.from, g.to, g.files.length, moveLabel(g)])).toEqual([
      ['lib/old-name.js', 'lib/new-name.js', 1, 'renamed lib/old-name.js → lib/new-name.js'],
      ['src/a', 'src/b', 3, '3 files moved src/a → src/b'],
      ['src', 'src/disabled', 1, 'moved src/auth.js → src/disabled/auth.js'],
    ]);
    expect(moveFiles(groups[1]!, 2)).toBe('src/a/deep/three.js → src/b/deep/three.js, src/a/one.js → src/b/one.js, and 1 more');
  });
  it('is one change per group on its first file; the edited file keeps its line change too', () => {
    const r = coverage(build(), []);
    const st = Object.fromEntries(r.files.map((f) => [f.path, f.changes.map((c) => c.state)]));
    expect(st).toEqual({ 'src/b/deep/three.js': ['unexplained', 'unexplained'], 'src/b/one.js': [], 'src/b/two.js': [], 'src/disabled/auth.js': ['unexplained'], 'lib/new-name.js': ['unexplained'] });
  });
  it('a step that resolves in ANY file of the group explains it; a lost or base-side one does not', () => {
    const head = (path: string, extra: Partial<Target> = {}) => T('a', 'head', 2, 2, { path, ...extra });
    expect(moveOf(build(), [head('src/b/two.js')]).state).toBe('explained');
    expect(moveOf(build(), [head('src/b/two.js', { state: 'lost', range: null })]).state).toBe('unexplained');
    expect(moveOf(build(), [T('b', 'base', 1, 1, { path: 'src/a/two.js' })]).state).toBe('unexplained');
  });
  it('a trivial mark or trivialFiles match covers only its own file: trivial only when every file has one', () => {
    const mark = (path: string) => T(`t-${path}`, 'head', 1, 1, { path, trivial: true, why: 'moved with its package' });
    // One mark: the other files lack cover, and are named.
    expect(moveOf(build(), [mark('src/b/two.js')])).toMatchObject({ state: 'unexplained', uncoveredFiles: ['src/b/deep/three.js', 'src/b/one.js'] });
    // Marks and globs together on every file: trivial.
    expect(moveOf(build((p) => p === 'src/b/one.js'), [mark('src/b/two.js'), mark('src/b/deep/three.js')])).toMatchObject({ state: 'trivial', why: ['moved with its package'] });
    expect(moveOf(build((p) => p.startsWith('src/b/')), []).state).toBe('trivial');
    // A mark on one file never covers another group's move (a README mark can't hide auth.js).
    const auth = coverage(build(), [mark('lib/new-name.js')]).files.find((f) => f.path === 'src/disabled/auth.js')!.changes[0]!;
    expect(auth.state).toBe('unexplained');
  });
});

describe('trivialFiles globs for unsupported paths', async () => {
  const { isValidTrivialGlob, trivialGlobFor } = await import('../../src/core/manifest.ts');
  it('`?` matches a control character and a backslash, so each path gets a valid glob that matches it', () => {
    for (const p of ['weird\u0001name.txt', 'a\\b.js', 'x/[id].tsx', 'docs/{a}.md', 'a/../b', 'x/./y', 'bang!.js']) {
      const g = trivialGlobFor(p);
      expect(g, p).toBeDefined();
      expect(isValidTrivialGlob(g!), p).toBe(true);
      expect(globMatcher([g!])(p), p).toBe(true);
    }
    expect(trivialGlobFor('weird\u0001name.txt')).toBe('weird?name.txt');
    expect(trivialGlobFor('a/../b')).toBe('a/??/b');
  });
  it('none for a path no valid glob can match', () => {
    expect(trivialGlobFor('a//b')).toBeUndefined();
    expect(trivialGlobFor('/abs')).toBeUndefined();
    expect(trivialGlobFor('x'.repeat(300))).toBeUndefined();
  });
});

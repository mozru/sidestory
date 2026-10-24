// The Changes view's model (docs/CHANGES-PLAN.md §9.2–§9.5, §16.1 changes-nav): compact folders and counts, the
// sorts, the filter, Next/Previous order and wrapping, labels, and the cost on 20,000 files.
import { describe, expect, it } from 'vitest';
import type { ChangeEntry } from '../../src/extension/changes/model.ts';
import {
  buildTree,
  commitsLabel,
  countsLabel,
  filterEntries,
  folderLabel,
  GitStatus,
  parseFilter,
  sortEntries,
  statusLetter,
  step,
  treeOrder,
} from '../../src/extension/changes/model.ts';

const fixture: ChangeEntry[] = [
  { path: 'src/retry/retry.ts', status: 'M', added: 4, removed: 1 },
  { path: 'src/retry/jitter.ts', status: 'A', added: 19, removed: 0 },
  { path: 'src/retry/backoff.ts', oldPath: 'old/backoff.ts', status: 'R', added: 2, removed: 2 },
  { path: 'legacy/sleep.ts', status: 'D', added: 0, removed: 24 },
  { path: 'test/retry.test.ts', status: 'M', added: 30, removed: 0 },
  { path: 'README.md', status: 'M', added: 1, removed: 1 },
];

describe('the folder tree', () => {
  it('joins single-child folder chains, puts folders before files, sorts by name, and sums counts', () => {
    const root = buildTree(fixture);
    expect(root.folders.map((f) => f.label)).toEqual(['legacy', 'src/retry', 'test']);
    expect(root.files.map((f) => f.path)).toEqual(['README.md']);
    const retry = root.folders[1]!;
    expect(retry.path).toBe('src/retry');
    expect(retry.files.map((f) => f.path)).toEqual(['src/retry/backoff.ts', 'src/retry/jitter.ts', 'src/retry/retry.ts']);
    expect(folderLabel(retry)).toBe('3 files · +25 −3');
    expect(folderLabel(root.folders[0]!)).toBe('1 file · −24');
    expect(root.fileCount).toBe(6);
  });

  it("doesn't join a folder that has files of its own, or the top level", () => {
    const root = buildTree([
      { path: 'a/b/c/x.ts', status: 'M' },
      { path: 'a/y.ts', status: 'M' },
    ]);
    expect(root.folders.map((f) => f.label)).toEqual(['a']);
    expect(root.folders[0]!.folders.map((f) => f.label)).toEqual(['b/c']);
    expect(root.folders[0]!.folders[0]!.depth).toBe(1);
  });

  it('says "3 files" until counts arrive, and natural-sorts names', () => {
    const root = buildTree([
      { path: 'f/file10.ts', status: 'A' },
      { path: 'f/file2.ts', status: 'A' },
      { path: 'f/File1.ts', status: 'A' },
    ]);
    expect(folderLabel(root.folders[0]!)).toBe('3 files');
    expect(root.folders[0]!.files.map((f) => f.path)).toEqual(['f/File1.ts', 'f/file2.ts', 'f/file10.ts']);
  });

  it('walks in tree order: depth first, folders before files', () => {
    expect(treeOrder(buildTree(fixture)).map((e) => e.path)).toEqual([
      'legacy/sleep.ts',
      'src/retry/backoff.ts',
      'src/retry/jitter.ts',
      'src/retry/retry.ts',
      'test/retry.test.ts',
      'README.md',
    ]);
  });

  it('sorts files inside folders by the chosen key', () => {
    const root = buildTree(fixture, 'size');
    expect(root.folders[1]!.files.map((f) => f.path)).toEqual(['src/retry/jitter.ts', 'src/retry/retry.ts', 'src/retry/backoff.ts']);
  });
});

describe('sorting the list', () => {
  it('by path, status and size, with ties broken by path and unknown sizes last', () => {
    expect(sortEntries(fixture, 'path').map((e) => e.path)[0]).toBe('legacy/sleep.ts');
    expect(sortEntries(fixture, 'status').map((e) => e.status)).toEqual(['A', 'M', 'M', 'M', 'R', 'D']);
    const sized = sortEntries([...fixture, { path: 'zzz.bin', status: 'M' }, { path: 'aaa.bin', status: 'M' }], 'size').map((e) => e.path);
    expect(sized.slice(0, 2)).toEqual(['test/retry.test.ts', 'legacy/sleep.ts']);
    expect(sized.slice(-2)).toEqual(['aaa.bin', 'zzz.bin']);
    // Stable whatever the input order.
    expect(sortEntries([...fixture].reverse(), 'status')).toEqual(sortEntries(fixture, 'status'));
  });
});

describe('the filter', () => {
  const paths = (text: string) => filterEntries(fixture, parseFilter(text)).map((e) => e.path);
  it('matches substrings case-insensitively', () => {
    expect(paths('RETRY')).toEqual(['src/retry/retry.ts', 'src/retry/jitter.ts', 'src/retry/backoff.ts', 'test/retry.test.ts']);
  });
  it('accepts globs, at any depth without a slash', () => {
    expect(paths('*.md')).toEqual(['README.md']);
    expect(paths('src/**/*.ts')).toEqual(['src/retry/retry.ts', 'src/retry/jitter.ts', 'src/retry/backoff.ts']);
  });
  it('excludes with !, and combines terms', () => {
    expect(paths('!test/')).not.toContain('test/retry.test.ts');
    expect(paths('retry !test/ !jitter')).toEqual(['src/retry/retry.ts', 'src/retry/backoff.ts']);
  });
  it('matches a rename on its old path', () => {
    expect(paths('old/')).toEqual(['src/retry/backoff.ts']);
  });
  it('an empty filter keeps everything', () => {
    expect(parseFilter('   ')).toBeUndefined();
    expect(paths('')).toHaveLength(fixture.length);
  });
});

describe('next and previous', () => {
  it('starts at the ends, steps, and wraps', () => {
    expect(step(3, -1, 1)).toEqual({ index: 0, wrapped: false });
    expect(step(3, -1, -1)).toEqual({ index: 2, wrapped: false });
    expect(step(3, 1, 1)).toEqual({ index: 2, wrapped: false });
    expect(step(3, 2, 1)).toEqual({ index: 0, wrapped: true });
    expect(step(3, 0, -1)).toEqual({ index: 2, wrapped: true });
    expect(step(0, -1, 1)).toBeUndefined();
  });
});

describe('labels and statuses', () => {
  it('maps the git API statuses to the letters the view shows', () => {
    expect(statusLetter(GitStatus.INDEX_ADDED)).toBe('A');
    expect(statusLetter(GitStatus.UNTRACKED)).toBe('A');
    expect(statusLetter(GitStatus.MODIFIED)).toBe('M');
    expect(statusLetter(GitStatus.DELETED)).toBe('D');
    expect(statusLetter(GitStatus.INDEX_RENAMED)).toBe('R');
    expect(statusLetter(GitStatus.INDEX_COPIED)).toBe('C');
    expect(statusLetter(GitStatus.IGNORED)).toBeUndefined();
  });
  it('counts and commits', () => {
    expect(countsLabel({ added: 23, removed: 11 })).toBe('+23 −11');
    expect(countsLabel({ added: 19, removed: 0 })).toBe('+19');
    expect(countsLabel({ added: 0, removed: 24 })).toBe('−24');
    expect(countsLabel({})).toBe('');
    expect(countsLabel({ added: 0, removed: 0, noText: true })).toBe('no line changes');
    expect(commitsLabel(1, false)).toBe('1 commit');
    expect(commitsLabel(4, false)).toBe('4 commits');
    expect(commitsLabel(1000, true)).toBe('1,000+ commits');
  });
});

describe('20,000 files', () => {
  const big: ChangeEntry[] = Array.from({ length: 20_000 }, (_, i) => ({ path: `pkg${i % 40}/src/mod${i % 300}/file${i}.ts`, status: 'M', added: i % 17, removed: i % 5 }));
  it('builds the tree and the order quickly, and filters in a few milliseconds', () => {
    const t0 = performance.now();
    const root = buildTree(big);
    const order = treeOrder(root);
    const built = performance.now() - t0;
    expect(order).toHaveLength(20_000);
    expect(root.fileCount).toBe(20_000);
    const f = parseFilter('mod7/')!;
    const t1 = performance.now();
    const kept = filterEntries(big, f);
    const filtered = performance.now() - t1;
    expect(kept.length).toBeGreaterThan(0);
    const t2 = performance.now();
    sortEntries(big, 'size');
    const sorted = performance.now() - t2;
    console.log(`20,000 files: tree ${built.toFixed(1)} ms, filter ${filtered.toFixed(1)} ms, size sort ${sorted.toFixed(1)} ms`);
    expect(built).toBeLessThan(500);
    expect(filtered).toBeLessThan(30);
  });
});

// Which sidestories count toward a comparison (src/core/membership.ts, docs/CHANGES-PLAN.md §6.1).
import { describe, expect, it } from 'vitest';
import { archiveMoveCandidates, belongs, countedChange, isArchivedManifest, countedPath, isArchivePath, isCompleteSidestory, ownedBySidestory, sidestoryFolderOf } from '../../src/core/membership.ts';
import { isSafeFsPath, isSafeRepoPath, pathProblem } from '../../src/core/repo-path.ts';

describe('isSafeRepoPath and isSafeFsPath (src/core/repo-path.ts)', () => {
  const always = ['', ':x', ':(literal)a', 'a\\b', 'a/../b', './a', 'a//b', '.git/config', 'x/.GIT/y', 'a\u0001b', 'x'.repeat(4097)];
  const windowsOnly = ['con', 'src/nul.txt', 'COM1/x', 'docs/a.', 'a /b', 'src/a.ts:stream', 'a:b/c', 'c:/x'];

  it('refuses paths git would read as magic, or that escape or confuse a reader, for any read', () => {
    for (const bad of always) {
      expect(isSafeRepoPath(bad), JSON.stringify(bad)).toBe(false);
      expect(isSafeFsPath(bad), JSON.stringify(bad)).toBe(false);
    }
    for (const ok of ['src/a.ts', 'console/x.ts', '.github/x.yml', 'a.b/c', '.sidestory/x/manifest.json']) {
      expect(isSafeRepoPath(ok), ok).toBe(true);
      expect(isSafeFsPath(ok), ok).toBe(true);
    }
  });

  it('Windows device names, trailing dots and spaces, and ":" anywhere (NTFS streams) are refused for file system reads only', () => {
    for (const p of windowsOnly) {
      expect(isSafeRepoPath(p), p).toBe(true); // a blob read by id: harmless
      expect(isSafeFsPath(p), p).toBe(false);
    }
  });

  it('says which rule a path breaks, device names included', () => {
    expect(pathProblem('con', true)).toMatch(/Windows device name/);
    expect(pathProblem('a.ts:x', true)).toMatch(/alternate data stream/);
    expect(pathProblem('docs/a.', true)).toMatch(/ending in a dot or a space/);
    expect(pathProblem('a\u0007b')).toMatch(/control character/);
    expect(pathProblem('con')).toBeUndefined();
  });
});

const M = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const HEAD = 'c'.repeat(40);

describe('belongs', () => {
  it('a sidestory added on the branch (committed, uncommitted or untracked) belongs', () => {
    expect(belongs({ presentAtMergeBase: false, presentAtHead: true, ownMergeBase: M, comparisonMergeBase: M })).toBe(true);
  });
  it('a landed sidestory (present at the merge-base) never counts for a later branch, even when edited there', () => {
    expect(belongs({ presentAtMergeBase: true, presentAtHead: true, ownMergeBase: M, comparisonMergeBase: M })).toBe(false);
  });
  it('a new sidestory on a branch whose HEAD still equals main belongs (absent at the merge-base)', () => {
    expect(belongs({ presentAtMergeBase: false, presentAtHead: true, ownMergeBase: M, comparisonMergeBase: M, comparisonHead: undefined })).toBe(true);
  });
  it('a sidestory deleted on the branch, or with another base, does not belong', () => {
    expect(belongs({ presentAtMergeBase: false, presentAtHead: false, ownMergeBase: M, comparisonMergeBase: M })).toBe(false);
    expect(belongs({ presentAtMergeBase: false, presentAtHead: true, ownMergeBase: OTHER, comparisonMergeBase: M })).toBe(false);
    expect(belongs({ presentAtMergeBase: false, presentAtHead: true, ownMergeBase: undefined, comparisonMergeBase: M })).toBe(false);
  });
  it('head-pinned sidestories: never in a live comparison; the review rule with a fixed head', () => {
    expect(belongs({ presentAtMergeBase: false, presentAtHead: true, ownMergeBase: M, comparisonMergeBase: M, manifestHead: HEAD })).toBe(false);
    expect(belongs({ presentAtMergeBase: false, presentAtHead: false, ownMergeBase: M, comparisonMergeBase: M, manifestHead: HEAD, comparisonHead: HEAD })).toBe(true);
    expect(belongs({ presentAtMergeBase: false, presentAtHead: true, ownMergeBase: M, comparisonMergeBase: M, manifestHead: HEAD, comparisonHead: OTHER })).toBe(false);
    expect(belongs({ presentAtMergeBase: false, presentAtHead: true, ownMergeBase: OTHER, comparisonMergeBase: M, manifestHead: HEAD, comparisonHead: HEAD })).toBe(false);
  });
});

describe('archiveMoveCandidates (shared by the checker and the extension)', () => {
  it('pairs a file moved under a dated archive folder with the rename or the deletion it came from', () => {
    const del = { status: 'D', path: 'pkg/.sidestory/retry/manifest.json' };
    const add = { status: 'A', path: 'pkg/.sidestory/archive/2026-01-02-retry/manifest.json' };
    const ren = { status: 'R', oldPath: '.sidestory/retry/sidestory.html', path: '.sidestory/archive/2026-01-02-retry/sidestory.html' };
    const stray = { status: 'A', path: '.sidestory/archive/2026-01-02-retry/extra.js' }; // nothing deleted at its live path
    const wrongDate = { status: 'A', path: '.sidestory/archive/latest-retry/a.js' };
    const elsewhere = { status: 'R', oldPath: 'src/a.ts', path: '.sidestory/archive/2026-01-02-retry/a.ts' };
    const got = archiveMoveCandidates([del, add, ren, stray, wrongDate, elsewhere], () => true);
    expect(got.map((m) => [m.entry.path, m.from.path, m.folder, m.file])).toEqual([
      [add.path, del.path, 'pkg/.sidestory/retry', 'manifest.json'],
      [ren.path, ren.path, '.sidestory/retry', 'sidestory.html'],
    ]);
    expect(archiveMoveCandidates([del, add], () => false)).toEqual([]);
  });
});

describe('isArchivedManifest', () => {
  const enc = (v: unknown) => new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  const m = { version: 3, title: 'Retry', base: 'main', anchors: { a: { file: 'a.ts', range: { start: 1, end: 2 } } } };
  const sha = 'a'.repeat(40);
  it('accepts the archive job\'s rewrite: base, head and landed added or changed, layout and key order free', () => {
    expect(isArchivedManifest(enc(m), enc({ ...m, base: sha, head: sha, landed: { branch: 'feat', at: '2026-01-02' } }))).toBe(true);
    expect(isArchivedManifest(enc(m), enc(JSON.stringify({ anchors: m.anchors, title: 'Retry', version: 3, base: sha })))).toBe(true);
  });
  it('refuses anything else: a payload field, other anchors, not JSON, not a manifest, too large', () => {
    expect(isArchivedManifest(enc(m), enc({ ...m, payload: 'x' }))).toBe(false);
    expect(isArchivedManifest(enc(m), enc({ ...m, anchors: {} }))).toBe(false);
    expect(isArchivedManifest(enc(m), enc('not json'))).toBe(false);
    expect(isArchivedManifest(enc(m), enc([1, 2]))).toBe(false);
    expect(isArchivedManifest(enc(m), new Uint8Array(1_000_001).fill(0x20))).toBe(false);
  });
});

describe('isArchivePath', () => {
  it('archive folders at any package root, nothing else', () => {
    expect(isArchivePath('.sidestory/archive/2026-10-30-x/manifest.json')).toBe(true);
    expect(isArchivePath('services/auth/.sidestory/archive/x/sidestory.html')).toBe(true);
    expect(isArchivePath('.sidestory/archived/manifest.json')).toBe(false);
    expect(isArchivePath('src/archive/x.ts')).toBe(false);
    expect(isArchivePath('.sidestory/x/archive/y')).toBe(false);
  });
});

describe('countedPath and sidestoryFolderOf', () => {
  it('only a complete sidestory\'s manifest.json and sidestory.html are left out; everything else counts', () => {
    expect(sidestoryFolderOf('.sidestory/retry/manifest.json')).toBe('.sidestory/retry');
    expect(sidestoryFolderOf('pkg/a/.sidestory/x.y/assets/d.svg')).toBe('pkg/a/.sidestory/x.y');
    expect(sidestoryFolderOf('.sidestory/README.md')).toBeUndefined();
    expect(sidestoryFolderOf('.sidestory/archive/x/manifest.json')).toBeUndefined();
    expect(sidestoryFolderOf('.sidestory/-bad/manifest.json')).toBeUndefined();
    expect(sidestoryFolderOf('src/sidestory/x/a.ts')).toBeUndefined();
    expect(countedPath('.sidestory/retry/sidestory.html')).toBe(false);
    expect(countedPath('pkg/.sidestory/retry/manifest.json')).toBe(false);
    // Archives count (as one change: the checker's kind 'archive'); so does any other file in a sidestory folder.
    expect(countedPath('.sidestory/archive/2026-x/manifest.json')).toBe(true);
    expect(countedPath('.sidestory/helper/run.js')).toBe(true);
    expect(countedPath('.sidestory/retry/widgets/w.tsx')).toBe(true);
    expect(countedPath('.sidestory/retry/assets/a.png')).toBe(true);
    // Only in a folder that is a complete sidestory.
    expect(countedPath('.sidestory/half/manifest.json', (f) => f !== '.sidestory/half')).toBe(true);
    expect(ownedBySidestory('.sidestory/retry/manifest.json', () => true)).toBe(true);
    expect(countedPath('.sidestory/README.md')).toBe(true);
    expect(countedPath('.sidestory/-bad/manifest.json')).toBe(true);
    expect(countedPath('src/a.ts')).toBe(true);
  });
  it('a rename or copy counts when either path counts; into a sidestory\'s own file, the old side is a deletion', () => {
    expect(countedChange({ status: 'R', oldPath: 'src/auth.js', path: '.sidestory/notes/manifest.json' })).toEqual({ counted: true, as: 'deletion' });
    expect(countedChange({ status: 'R', oldPath: '.sidestory/notes/sidestory.html', path: 'src/page.js' })).toEqual({ counted: true, as: 'addition' });
    expect(countedChange({ status: 'C', oldPath: '.sidestory/notes/sidestory.html', path: 'src/page.js' })).toEqual({ counted: true, as: 'addition' });
    expect(countedChange({ status: 'C', oldPath: 'src/auth.js', path: '.sidestory/notes/manifest.json' })).toEqual({ counted: false });
    expect(countedChange({ status: 'R', oldPath: 'src/auth.js', path: '.sidestory/notes/auth.js' })).toEqual({ counted: true });
    expect(countedChange({ status: 'R', oldPath: '.sidestory/a/manifest.json', path: '.sidestory/b/manifest.json' })).toEqual({ counted: false });
    expect(countedChange({ status: 'M', path: '.sidestory/a/sidestory.html' })).toEqual({ counted: false });
  });

  it('a sidestory is complete with both its manifest and its page', () => {
    expect(isCompleteSidestory(['manifest.json', 'sidestory.html', 'assets/x.png'])).toBe(true);
    expect(isCompleteSidestory(['manifest.json'])).toBe(false);
    expect(isCompleteSidestory(['sidestory.html'])).toBe(false);
  });
});

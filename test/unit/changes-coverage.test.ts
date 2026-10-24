// The coverage service's core (docs/CHANGES-PLAN.md §6.1–§6.3, §16.1) on the git fixture's `--explained` branch,
// through a stubbed source that reads with git: which sidestories belong, targets on both sides (a base-side anchor
// on a deleted file), trivial marks, the totals the view shows, counts from the blocks, and the cache.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChangeEntry } from '../../src/extension/changes/model.ts';

vi.mock('vscode', () => import('./vscode-stub.ts'));
const { computeCoverage, belongingSidestories, CoverageService, ByteLru, COVERAGE_WORK } = await import('../../src/extension/changes/coverage-service.ts');
type Source = import('../../src/extension/changes/coverage-service.ts').CoverageSource;
const vscode = await import('./vscode-stub.ts');

let dir = '';
const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
const gitBytes = (...args: string[]) => new Uint8Array(execFileSync('git', args, { cwd: dir }));

function source(reads: string[] = []): Source {
  const mb = git('merge-base', 'main', 'feature').trim();
  const entries: ChangeEntry[] = git('diff', '--name-status', '-M', mb, 'HEAD')
    .trim()
    .split('\n')
    .map((l) => l.split('\t'))
    .map(([s, a, b]) => (s!.startsWith('R') ? { status: 'R', oldPath: a!, path: b! } : { status: s as 'A' | 'M' | 'D', path: a! }));
  const tryBytes = (rev: string, p: string) => {
    reads.push(`${rev.slice(0, 4)}:${p}`);
    try {
      return gitBytes('show', `${rev}:${p}`);
    } catch {
      return undefined;
    }
  };
  return {
    mergeBase: mb,
    entries,
    candidates: async () => [
      { folder: '.sidestory/retry-jitter', prefix: '', dir: vscode.Uri.file(join(dir, '.sidestory/retry-jitter')) as never, manifestText: git('show', 'HEAD:.sidestory/retry-jitter/manifest.json'), html: git('show', 'HEAD:.sidestory/retry-jitter/sidestory.html') },
      // A sidestory that landed on main earlier never belongs (§6.1 rule 1).
      { folder: '.sidestory/landed', prefix: '', dir: vscode.Uri.file(join(dir, '.sidestory/landed')) as never, manifestText: JSON.stringify({ version: 3, title: 'Landed', base: 'main', anchors: {} }), html: '' },
    ],
    presentAtMergeBase: async (p) => p.startsWith('.sidestory/landed/'),
    ownMergeBase: async (spec) => (spec === 'main' ? mb : undefined),
    oldBytes: async (p) => tryBytes(mb, p),
    newBytes: async (p) => tryBytes('HEAD', p),
    diffKey: (e) => `HEAD\0${e.path}`,
  };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cx-cov-'));
  execFileSync(process.execPath, [resolve(import.meta.dirname, '../fixtures/git-repo.mjs'), dir, '--explained']);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('coverage in the extension (computeCoverage)', () => {
  it('counts only the sidestory added on the branch whose base gives the merge-base', async () => {
    const { found, incomplete } = await belongingSidestories(source());
    expect(found.map((f) => f.folder)).toEqual(['.sidestory/retry-jitter']);
    expect(incomplete).toBe(false);
  });

  it('never takes a git error for "absent at the merge-base": not counted, and incomplete', async () => {
    const s = { ...source(), presentAtMergeBase: async () => undefined };
    const { found, incomplete } = await belongingSidestories(s);
    expect(found).toEqual([]);
    expect(incomplete).toBe(true);
    const r = (await computeCoverage(s))!;
    expect(r.belonging).toEqual([]);
    expect(r.incomplete).toBe(true);
  });

  it('counts a side past MAX_COMPARE_BYTES as one change and an unreadable file as incomplete, like the checker', async () => {
    const base = source();
    const s: Source = {
      ...base,
      diffKey: undefined,
      newBytes: async (p) => (p === 'test/retry.test.ts' ? 'tooLarge' : p === 'src/retry/jitter.ts' ? undefined : base.newBytes(p)),
    };
    const r = (await computeCoverage(s))!;
    expect(r.files.get('test/retry.test.ts')!.coverage!.changes).toHaveLength(1);
    expect(r.files.get('test/retry.test.ts')!.diff.tooLarge).toBe('size');
    expect(r.files.has('src/retry/jitter.ts')).toBe(false);
    expect(r.incomplete).toBe(true);
  });

  it('gives the same per-path maps whatever order reads finish in', async () => {
    const slow = source();
    const s: Source = { ...slow, diffKey: undefined, oldBytes: async (p) => (await new Promise((r) => setTimeout(r, p.length % 3 ? 15 : 0)), slow.oldBytes(p)) };
    const a = (await computeCoverage(s))!;
    const b = (await computeCoverage(slow))!;
    expect([...a.files.keys()]).toEqual([...b.files.keys()]);
    expect([...a.files.keys()]).toEqual([...a.files.keys()].sort());
  });

  it('explains by head-side, base-side and trivial anchors and leaves the test file unexplained', async () => {
    const r = (await computeCoverage(source()))!;
    expect(r.belonging.map((b) => [b.folder, b.manifest.title, b.steps.length])).toEqual([['.sidestory/retry-jitter', 'Retry with jitter', 3]]);
    // backoff.ts moved from old/ as well as changed: its move is one more change, which its trivial mark covers.
    expect(r.totals).toMatchObject({ explained: 3, trivial: 2, left: 1, needsLook: 0, files: 5 });
    const state = (p: string) => r.files.get(p)?.coverage?.changes.map((c) => c.state);
    expect(state('src/retry/retry.ts')).toEqual(['explained']);
    expect(state('src/retry/jitter.ts')).toEqual(['explained']);
    expect(state('legacy/sleep.ts')).toEqual(['explained']);
    expect(state('src/retry/backoff.ts')).toEqual(['trivial', 'trivial']);
    expect(state('test/retry.test.ts')).toEqual(['unexplained']);
    // The base-side target is on the merge-base path of the deleted file.
    expect(r.targets.find((t) => t.anchor === 'old-sleep')).toMatchObject({ side: 'base', path: 'legacy/sleep.ts', range: { start: 1, end: 24 } });
    // Sidestory files are never counted.
    expect([...r.files.keys()].some((p) => p.startsWith('.sidestory/'))).toBe(false);
    // The sidestory's own totals: what it explains or marks.
    expect(r.belonging[0]!.totals).toMatchObject({ explained: 3, trivial: 2, files: 4 });
    expect(r.belonging[0]!.stepOf.get('retry-loop')).toBe('retry-loop');
  });

  it('reads anchored files first and reuses diffs by content key', async () => {
    const reads: string[] = [];
    const cache = new Map();
    await computeCoverage(source(reads), { cache, order: ['test/retry.test.ts'] });
    // Anchored files (jitter, retry, sleep, backoff) before the unanchored test file, whatever the view's order.
    expect(reads.findIndex((r) => r.endsWith('test/retry.test.ts'))).toBeGreaterThan(reads.findIndex((r) => r.endsWith('legacy/sleep.ts')));
    reads.length = 0;
    await computeCoverage(source(reads), { cache });
    expect(reads).toEqual([]);
  });

  it('stops when the comparison moved on', async () => {
    expect(await computeCoverage(source(), { isCurrent: () => false })).toBeUndefined();
  });

  it('without a belonging sidestory there is no layer and no diff work', async () => {
    const reads: string[] = [];
    const s = { ...source(reads), candidates: async () => [] };
    const r = (await computeCoverage(s))!;
    expect(r.belonging).toEqual([]);
    expect(r.files.size).toBe(0);
    expect(reads).toEqual([]);
  });
});

describe('the checker\'s rules in the extension', () => {
  const enc = (t: string) => new TextEncoder().encode(t);

  it('binary, Git LFS, link, submodule and unsupported sides are one change each', async () => {
    const base = source();
    const s: Source = {
      ...base,
      diffKey: undefined,
      entries: [...base.entries, { status: 'A', path: 'logo.png' }, { status: 'A', path: 'link' }, { status: 'M', path: 'vendor/lib' }, { status: 'A', path: 'con' }, { status: 'A', path: 'video.mp4' }],
      unsupported: [{ path: 'weird\u0001name' }],
      newBytes: async (p) =>
        p === 'logo.png' ? new Uint8Array([0x89, 0, 1]) : p === 'link' ? 'link' : p === 'vendor/lib' ? 'submodule' : p === 'con' ? 'unsupported' : p === 'video.mp4' ? enc(`version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 1\n`) : base.newBytes(p),
      oldBytes: async (p) => (p === 'vendor/lib' ? 'submodule' : base.oldBytes(p)),
    };
    const r = (await computeCoverage(s))!;
    for (const [p, whole] of [['logo.png', 'binary'], ['video.mp4', 'lfs'], ['link', 'link'], ['vendor/lib', 'submodule'], ['con', 'unsupported']] as const) {
      expect(r.files.get(p)!.whole, p).toBe(whole);
      expect(r.files.get(p)!.coverage!.changes.map((c) => c.state), p).toEqual(['unexplained']);
    }
    expect(r.unsupported).toEqual(['weird\u0001name']);
    expect(r.unsupportedLeft).toEqual(['weird\u0001name']);
    expect(r.files.has('weird\u0001name')).toBe(false);
    // The fixture's 1 left, plus 6.
    expect(r.totals).toMatchObject({ explained: 3, trivial: 2, left: 7 });
  });

  it('trivialFiles covers a file counted as one change, an unsupported path included', async () => {
    const base = source();
    const [manifestCandidate, landed] = await base.candidates();
    const m = JSON.parse(manifestCandidate!.manifestText);
    m.trivialFiles = ['**/*.png', 'weird*'];
    const s: Source = {
      ...base,
      diffKey: undefined,
      entries: [...base.entries, { status: 'A', path: 'img/logo.png' }],
      unsupported: [{ path: 'weird\u0001name' }],
      candidates: async () => [{ ...manifestCandidate!, manifestText: JSON.stringify(m) }, landed!],
      newBytes: async (p) => (p === 'img/logo.png' ? new Uint8Array([0, 1]) : base.newBytes(p)),
    };
    const r = (await computeCoverage(s))!;
    expect(r.files.get('img/logo.png')!.coverage!.changes[0]!.state).toBe('trivial');
    expect(r.unsupportedLeft).toEqual([]); // covered by `weird*`
    expect(r.totals).toMatchObject({ trivial: 4, left: 1 });
  });

  it('pairs an unstaged rename as the checker does: the untracked file becomes the rename, the deletion goes', async () => {
    const base = source();
    const text = enc(Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') + '\n');
    const s: Source = {
      ...base,
      diffKey: undefined,
      entries: [...base.entries, { status: 'D', path: 'docs/old.md' }, { status: 'A', path: 'docs/new.md', untracked: true }],
      oldBytes: async (p) => (p === 'docs/old.md' ? text : base.oldBytes(p)),
      newBytes: async (p) => (p === 'docs/new.md' ? text : base.newBytes(p)),
    };
    const r = (await computeCoverage(s))!;
    expect(r.files.get('docs/new.md')!.entry).toMatchObject({ status: 'R', oldPath: 'docs/old.md', untracked: true });
    expect(r.files.has('docs/old.md')).toBe(false);
    // The pair is exposed, so the extension maps the deleted and the untracked entry to this one.
    expect([...r.paired]).toEqual([['docs/old.md', 'docs/new.md']]);
    // A move (§5.1): its folder's move group's one change, carried by this file, not in its line diff.
    expect(r.files.get('docs/new.md')!.diff.changes).toEqual([]);
    expect(r.files.get('docs/new.md')!.move).toMatchObject({ inPlace: true, files: [{ path: 'docs/new.md', oldPath: 'docs/old.md' }] });
    expect(r.files.get('docs/new.md')!.coverage!.changes.map((c) => c.state)).toEqual(['unexplained']);
  });

  it('a base-side anchor never resolves against an added file at its old path; the rename from it does', async () => {
    const base = source();
    // legacy/sleep.ts moved to a/sleep.ts (sorting before it), and a new file was added at legacy/sleep.ts.
    const s: Source = {
      ...base,
      diffKey: undefined,
      entries: [...base.entries.filter((e) => e.path !== 'legacy/sleep.ts'), { status: 'R', oldPath: 'legacy/sleep.ts', path: 'a/sleep.ts' }, { status: 'A', path: 'legacy/sleep.ts' }],
      newBytes: async (p) => (p === 'legacy/sleep.ts' ? enc('something new\n') : p === 'a/sleep.ts' ? enc('moved\n') : base.newBytes(p)),
    };
    const r = (await computeCoverage(s))!;
    expect(r.targets.find((t) => t.anchor === 'old-sleep')).toMatchObject({ side: 'base', path: 'legacy/sleep.ts', range: { start: 1, end: 24 } });
    // Its removed lines are covered by the base-side step (the added "moved" line isn't): partly, not unexplained. Its
    // move (legacy → a) is one more change, which no head-side anchor in a/sleep.ts covers.
    expect(r.files.get('a/sleep.ts')!.coverage!.changes.map((c) => c.state)).toEqual(['unexplained', 'partly']);
  });

  it('a page over the read cap still makes the sidestory belong, with the result incomplete', async () => {
    const base = source();
    const [c, landed] = await base.candidates();
    const s: Source = { ...base, candidates: async () => [{ ...c!, html: '', htmlTooLarge: true }, landed!] };
    const r = (await computeCoverage(s))!;
    expect(r.belonging.map((b) => b.folder)).toEqual(['.sidestory/retry-jitter']);
    expect(r.incomplete).toBe(true);
    // Its anchors can't be read: only the trivial mark (used by definition) still covers.
    expect(r.totals).toMatchObject({ explained: 0, trivial: 2 });
  });

  it('working tree mode keeps one cached diff per path, replaced when the content changes', async () => {
    const base = source();
    const cache = new Map();
    let v = 'one';
    const s: Source = { ...base, diffKey: undefined, newBytes: async (p) => (p === 'test/retry.test.ts' ? enc(`${v}\n`) : base.newBytes(p)) };
    await computeCoverage(s, { cache });
    const size = cache.size;
    v = 'two';
    await computeCoverage(s, { cache });
    expect(cache.size).toBe(size);
    expect([...cache.keys()].filter((k: string) => k.endsWith('test/retry.test.ts'))).toHaveLength(1);
  });
});

describe('ByteLru', () => {
  it('is bounded by bytes, evicting the least recently used; a value over the budget is not kept', () => {
    const lru = new ByteLru<Uint8Array>(100, (b) => b.length);
    lru.set('a', new Uint8Array(40));
    lru.set('b', new Uint8Array(40));
    lru.get('a');
    lru.set('c', new Uint8Array(40));
    expect([lru.get('a') !== undefined, lru.get('b') !== undefined, lru.get('c') !== undefined]).toEqual([true, false, true]);
    expect(lru.bytes).toBe(80);
    lru.set('a', new Uint8Array(10)); // replacing re-weighs
    expect(lru.bytes).toBe(50);
    lru.set('huge', new Uint8Array(101));
    expect(lru.get('huge')).toBeUndefined();
    expect(lru.bytes).toBe(50);
  });

  it('the service budgets diffs and merge-base blobs by bytes', () => {
    expect(COVERAGE_WORK.diffCacheBytes).toBe(64 * 1024 * 1024);
    expect(COVERAGE_WORK.oldBlobBytes).toBe(64 * 1024 * 1024);
  });
});

describe('the coverage service', () => {
  it('a run that throws still gives waiting commands a result for the snapshot, marked incomplete', async () => {
    const snap = { repo: { rootUri: vscode.Uri.file('/nowhere') }, mergeBase: 'a'.repeat(40), head: { sha: 'b'.repeat(40) }, mode: 'committed', entries: [] };
    const svc = new CoverageService({
      snapshot: () => snap as never,
      order: () => [],
      sidestoryDirs: () => {
        throw new Error('index gone');
      },
    });
    const fired = new Promise<void>((resolve) => svc.onDidChange(() => resolve()));
    svc.want('command', true);
    await fired;
    expect(svc.resultFor).toBe(snap);
    expect(svc.result).toMatchObject({ incomplete: true, belonging: [] });
    // Never an earlier result (it may be another merge-base's): an empty one for this snapshot.
    svc.result = { ...svc.result!, mergeBase: 'c'.repeat(40), incomplete: false, total: 7 };
    const again = new Promise<void>((resolve) => svc.onDidChange(() => resolve()));
    svc.schedule(0);
    await again;
    expect(svc.result).toMatchObject({ mergeBase: snap.mergeBase, incomplete: true, total: 0 });
    svc.dispose();
  });

  it.skipIf(process.platform === 'win32')('reads links, folders and refused paths in the working tree as the checker does, and pages with its cap and decoding', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cx-src-')));
    try {
      writeFileSync(join(root, 'a.txt'), 'a\n');
      execFileSync('ln', ['-s', 'a.txt', join(root, 'link')]);
      mkdirSync(join(root, 'sub'));
      writeFileSync(join(root, 'con'), 'x\n');
      const sd = join(root, '.sidestory/s');
      mkdirSync(sd, { recursive: true });
      writeFileSync(join(sd, 'manifest.json'), JSON.stringify({ version: 3, title: 'S', base: 'main', anchors: {} }));
      writeFileSync(join(sd, 'sidestory.html'), Buffer.from('<p data-explain-ref="x">caf\xe9</p>', 'latin1'));
      const repo = { rootUri: vscode.Uri.file(root), getObjectDetails: async () => ({ mode: '120000', object: 'x', size: 1 }), buffer: async () => new Uint8Array() };
      const snap = { repo, mergeBase: 'a'.repeat(40), head: { sha: 'b'.repeat(40) }, mode: 'workingTree', entries: [] };
      const svc = new CoverageService({ snapshot: () => snap as never, order: () => [], sidestoryDirs: () => [vscode.Uri.file(sd) as never] });
      const src = (svc as unknown as { source(s: unknown): Source }).source(snap);
      expect(await src.newBytes('link')).toBe('link');
      expect(await src.newBytes('sub')).toBe('submodule');
      expect(await src.newBytes('con')).toBe('unsupported');
      expect(await src.newBytes('a.txt:zone')).toBe('unsupported');
      expect(await src.newBytes('a.txt')).toEqual(new TextEncoder().encode('a\n'));
      // Blob modes: a link at the merge-base is a link.
      expect(await src.oldBytes('a.txt')).toBe('link');
      let [c] = await src.candidates();
      expect(c!.html).toBe('<p data-explain-ref="x">caf\u00e9</p>');
      writeFileSync(join(sd, 'sidestory.html'), Buffer.alloc(COVERAGE_WORK.htmlBytes + 1, 0x20));
      [c] = await src.candidates();
      expect(c).toMatchObject({ folder: '.sidestory/s', html: '', htmlTooLarge: true });
      // A page that is a link is never read, as the checker refuses it: even to a file inside the repository, and
      // even while its document is open with unsaved text.
      writeFileSync(join(root, 'page.html'), '<p>elsewhere</p>');
      rmSync(join(sd, 'sidestory.html'));
      execFileSync('ln', ['-s', '../../page.html', join(sd, 'sidestory.html')]);
      expect(await src.candidates()).toEqual([]);
      const pageUri = vscode.Uri.file(join(sd, 'sidestory.html'));
      vscode.workspace.textDocuments.push({ uri: pageUri, isDirty: true, getText: () => '<p>unsaved</p>' } as never);
      try {
        expect(await src.candidates()).toEqual([]);
      } finally {
        vscode.workspace.textDocuments.pop();
      }
      svc.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });


  it('drops its result, and says so, when the last one wanting it goes', () => {
    const svc = new CoverageService({ snapshot: () => undefined, order: () => [], sidestoryDirs: () => [] });
    let fired = 0;
    svc.onDidChange(() => fired++);
    svc.want('workspace', true);
    svc.result = { mergeBase: 'x' } as never;
    svc.want('session:a', true);
    svc.want('workspace', false);
    expect(svc.result).toBeDefined();
    svc.want('session:a', false);
    expect(svc.result).toBeUndefined();
    expect(fired).toBe(1);
    svc.dispose();
  });
});

// The coverage service's core (docs/CHANGES-PLAN.md §6.1–§6.3, §16.1) on the git fixture's `--explained` branch,
// through a stubbed source that reads with git: which sidestories belong, targets on both sides (a base-side anchor
// on a deleted file), trivial marks, the totals the view shows, counts from the blocks, and the cache.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChangeEntry } from '../../src/extension/changes/model.ts';

vi.mock('vscode', () => import('./vscode-stub.ts'));
const { computeCoverage, belongingSidestories } = await import('../../src/extension/changes/coverage-service.ts');
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
    expect(r.totals).toMatchObject({ explained: 3, trivial: 1, left: 1, needsLook: 0, files: 5 });
    const state = (p: string) => r.files.get(p)?.coverage?.changes.map((c) => c.state);
    expect(state('src/retry/retry.ts')).toEqual(['explained']);
    expect(state('src/retry/jitter.ts')).toEqual(['explained']);
    expect(state('legacy/sleep.ts')).toEqual(['explained']);
    expect(state('src/retry/backoff.ts')).toEqual(['trivial']);
    expect(state('test/retry.test.ts')).toEqual(['unexplained']);
    // The base-side target is on the merge-base path of the deleted file.
    expect(r.targets.find((t) => t.anchor === 'old-sleep')).toMatchObject({ side: 'base', path: 'legacy/sleep.ts', range: { start: 1, end: 24 } });
    // Sidestory files are never counted.
    expect([...r.files.keys()].some((p) => p.startsWith('.sidestory/'))).toBe(false);
    // Counts from the blocks, renames included.
    expect(r.files.get('src/retry/backoff.ts')!.entry).toMatchObject({ added: 2, removed: 2 });
    expect(r.files.get('src/retry/retry.ts')!.entry).toMatchObject({ added: 4, removed: 1 });
    // The sidestory's own totals: what it explains or marks.
    expect(r.belonging[0]!.totals).toMatchObject({ explained: 3, trivial: 1, files: 4 });
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

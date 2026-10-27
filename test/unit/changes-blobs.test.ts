// One blob cache for the diff editors, coverage and the comparison (src/extension/changes/git-blobs.ts), and one
// PreparedText per text for coverage targets (src/core/coverage-inputs.ts).
import { describe, expect, it, vi } from 'vitest';
import { PreparedTexts } from '../../src/core/coverage-inputs.ts';
import { PreparedText } from '../../src/core/text.ts';

vi.mock('vscode', () => import('./vscode-stub.ts'));
const vscode = await import('./vscode-stub.ts');
const { GitBlobs, MAX_BLOB_BYTES } = await import('../../src/extension/changes/git-blobs.ts');
const { GitFileSystem, RepoIds, gitUri } = await import('../../src/extension/changes/git-fs.ts');
const { CoverageService } = await import('../../src/extension/changes/coverage-service.ts');

const SHA = 'a'.repeat(40);
const OBJ = 'b'.repeat(40);

function counting(files: Record<string, string | { mode: string }>, opts: { failOnce?: boolean } = {}) {
  const calls = { details: 0, buffer: 0 };
  let fail = opts.failOnce;
  const rel = (abs: string) => abs.slice('/repo/'.length);
  return {
    calls,
    repo: {
      rootUri: vscode.Uri.file('/repo'),
      getObjectDetails: async (_sha: string, path: string) => {
        calls.details++;
        if (fail) {
          fail = false;
          throw new Error('git is busy');
        }
        const f = files[rel(path)];
        if (f === undefined) throw Object.assign(new Error('Path not known by git'), { gitErrorCode: 'UnknownPath' });
        return typeof f === 'string' ? { mode: '100644', object: OBJ, size: f.length } : { mode: f.mode, object: OBJ, size: 1 };
      },
      buffer: async (_sha: string, path: string) => {
        calls.buffer++;
        return Buffer.from(files[rel(path)] as string);
      },
    },
  };
}

const memento = () => ({ get: () => undefined, update: async () => {} });

describe('GitBlobs', () => {
  it('reads a blob once for the diff editor and coverage', async () => {
    const { repo, calls } = counting({ 'src/a.ts': 'one\ntwo\n' });
    const blobs = new GitBlobs();
    const ids = new RepoIds(memento() as never);
    const fs = new GitFileSystem(ids, blobs);
    const svc = new CoverageService({ snapshot: () => undefined, order: () => [], sidestoryDirs: () => [] }, blobs);
    const snap = { repo, mergeBase: SHA, head: { sha: 'c'.repeat(40) }, mode: 'committed', entries: [] };
    const src = (svc as unknown as { source(s: unknown): { oldBytes(p: string): Promise<unknown>; presentAtMergeBase(p: string): Promise<boolean | undefined> } }).source(snap);
    const fromEditor = await fs.readFile(gitUri(ids, repo as never, SHA, 'src/a.ts') as never);
    const fromCoverage = await src.oldBytes('src/a.ts');
    expect(new TextDecoder().decode(fromEditor)).toBe('one\ntwo\n');
    expect(fromCoverage).toBe(fromEditor);
    expect(await src.presentAtMergeBase('src/a.ts')).toBe(true);
    expect(calls).toEqual({ details: 1, buffer: 1 });
    svc.dispose();
  });

  it('keeps "not at this commit", never a failure; links and submodules are classified from the cached details', async () => {
    const { repo, calls } = counting({ link: { mode: '120000' }, sub: { mode: '160000' } }, { failOnce: true });
    const blobs = new GitBlobs();
    expect(await blobs.stat(repo as never, SHA, 'gone.ts')).toBeUndefined(); // git was busy: asked again next time
    expect(await blobs.stat(repo as never, SHA, 'gone.ts')).toBe('missing');
    expect(await blobs.stat(repo as never, SHA, 'gone.ts')).toBe('missing');
    expect(calls.details).toBe(2);
    const svc = new CoverageService({ snapshot: () => undefined, order: () => [], sidestoryDirs: () => [] }, blobs);
    const src = (svc as unknown as { source(s: unknown): { oldBytes(p: string): Promise<unknown>; presentAtMergeBase(p: string): Promise<boolean | undefined> } }).source({ repo, mergeBase: SHA, head: { sha: SHA }, mode: 'committed', entries: [] });
    expect(await src.presentAtMergeBase('gone.ts')).toBe(false);
    expect(await src.oldBytes('gone.ts')).toBeUndefined();
    expect(await src.oldBytes('link')).toBe('link');
    expect(await src.oldBytes('sub')).toBe('submodule');
    expect(await src.oldBytes('link')).toBe('link');
    expect(calls).toEqual({ details: 4, buffer: 0 });
    svc.dispose();
  });

  it('a details answer of null is "git couldn’t say" (asked again), never a rejected promise kept', async () => {
    let calls = 0;
    const repo = { rootUri: vscode.Uri.file('/repo'), getObjectDetails: async () => (calls++, null), buffer: async () => new Uint8Array() };
    const blobs = new GitBlobs();
    expect(await blobs.stat(repo as never, SHA, 'a.ts')).toBeUndefined();
    expect(await blobs.stat(repo as never, SHA, 'a.ts')).toBeUndefined();
    expect(calls).toBe(2);
  });

  it('textconv output over 10 MB is returned but not kept', async () => {
    let calls = 0;
    const repo = { rootUri: vscode.Uri.file('/repo'), getObjectDetails: async () => ({ mode: '100644', object: OBJ, size: 10 }), buffer: async () => (calls++, new Uint8Array(MAX_BLOB_BYTES + 1)) };
    const blobs = new GitBlobs(64 * 1024 * 1024);
    expect((await blobs.read(repo as never, SHA, 'a.pdf')).byteLength).toBe(MAX_BLOB_BYTES + 1);
    await blobs.read(repo as never, SHA, 'a.pdf');
    expect(calls).toBe(2);
  });

  it('shares a read in flight and bounds the bytes it keeps', async () => {
    const { repo, calls } = counting({ a: 'x'.repeat(60), b: 'y'.repeat(60) });
    const blobs = new GitBlobs(100);
    const [one, two] = await Promise.all([blobs.read(repo as never, SHA, 'a'), blobs.read(repo as never, SHA, 'a')]);
    expect(one).toBe(two);
    expect(calls.buffer).toBe(1);
    await blobs.read(repo as never, SHA, 'b'); // over the budget: a goes
    await blobs.read(repo as never, SHA, 'a');
    expect(calls.buffer).toBe(3);
  });
});

describe('PreparedTexts', () => {
  it('prepares a text once per run, and takes over the last run’s', () => {
    const from = vi.spyOn(PreparedText, 'from');
    try {
      const a = 'a\nb\n'.repeat(10);
      const first = new PreparedTexts();
      const p = first.get(a);
      expect(first.get(a)).toBe(p);
      const second = new PreparedTexts(first);
      expect(second.get(a)).toBe(p);
      second.get('other\n');
      expect(from).toHaveBeenCalledTimes(2);
      // Only the run before is kept: a text the last run didn't use is prepared again.
      const third = new PreparedTexts(new PreparedTexts(second));
      third.get(a);
      expect(from).toHaveBeenCalledTimes(3);
    } finally {
      from.mockRestore();
    }
  });
});

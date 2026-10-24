// The Changes view's git side (docs/CHANGES-PLAN.md §4.3–§4.5, §16.1 base-resolve, changes-comparison, git-fs): the
// base grammar and resolution, the merge diff against a real git fixture (read through a stand-in for the vscode.git
// API that runs the same git commands the git extension does), the recompute rules, and the read-only provider.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RefReader } from '../../src/extension/changes/base.ts';
import { defaultBaseCandidates, isValidBase, remoteDefault, resolveBase } from '../../src/extension/changes/base.ts';
import { EventEmitter, Uri } from './vscode-stub.ts';

vi.mock('vscode', () => import('./vscode-stub.ts'));
const { Comparison, countCommits, headSideReadable, isSafeRepoPath, toEntries } = await import('../../src/extension/changes/comparison.ts');
const { GitFileSystem, RepoIds, gitUri, parseGitUri } = await import('../../src/extension/changes/git-fs.ts');
type GitRepo = import('../../src/extension/changes/git-api.ts').GitRepo;

// ---- base resolution, with a stub reader ----

function reader(refs: Record<string, string>, opts: { upstream?: Record<string, string>; mergeBase?: (a: string, b: string) => string | undefined; remotes?: string[] } = {}): RefReader & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    commit: async (ref) => {
      asked.push(ref);
      return refs[ref] ?? (/^[0-9a-f]{40}$/.test(ref) && Object.values(refs).includes(ref) ? ref : undefined);
    },
    upstream: async (b) => {
      const u = opts.upstream?.[b];
      return u ? { remote: u.split('/')[0]!, name: u.split('/').slice(1).join('/') } : undefined;
    },
    mergeBase: async (a, b) => opts.mergeBase?.(a, b),
    remotes: () => opts.remotes ?? ['origin'],
  };
}
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

describe('the base grammar (§3.1)', () => {
  it('accepts branch, tag and remote names and full ids', () => {
    for (const ok of ['main', 'release/2.1', 'v1.4.0', 'origin/main', 'feature/x_y-z', A, 'f'.repeat(64)]) expect(isValidBase(ok), ok).toBe(true);
  });
  it('refuses options, ranges, reflog syntax, .lock, pseudo-refs and short ids', () => {
    for (const bad of ['-x', '--output=x', 'a..b', 'a@{1}', 'x.lock', 'x/', '/x', 'a//b', 'HEAD', 'FETCH_HEAD', 'ORIG_HEAD', 'a b', 'a;b', '$(x)', 'x/.hidden', '', 'x'.repeat(201)]) {
      expect(isValidBase(bad), bad).toBe(false);
    }
    expect(isValidBase('abc1234')).toBe(true); // a ref name that looks like a short id is a name, resolved as one
  });
});

describe('resolving a base (§4.3)', () => {
  it('a local branch with no upstream', async () => {
    expect(await resolveBase(reader({ 'refs/heads/main': A }), 'main')).toMatchObject({ sha: A, label: 'main', via: 'refs/heads/main', branch: 'main' });
  });
  it('only the remote-tracking branch (a CI checkout)', async () => {
    expect(await resolveBase(reader({ 'refs/remotes/origin/main': B }), 'main')).toMatchObject({ sha: B, label: 'origin/main', via: 'refs/remotes/origin/main' });
  });
  it('local behind its upstream, or diverged: the upstream; local ahead: local', async () => {
    const refs = { 'refs/heads/main': A, 'refs/remotes/origin/main': B };
    const up = { upstream: { main: 'origin/main' } };
    expect(await resolveBase(reader(refs, { ...up, mergeBase: () => A }), 'main')).toMatchObject({ sha: B, label: 'main (origin/main)' });
    expect(await resolveBase(reader(refs, { ...up, mergeBase: () => C }), 'main')).toMatchObject({ sha: B });
    expect(await resolveBase(reader(refs, { ...up, mergeBase: () => B }), 'main')).toMatchObject({ sha: A, label: 'main' });
  });
  it('origin/main names the remote branch; tags come after branches; never a short name', async () => {
    const r = reader({ 'refs/remotes/origin/main': B, 'refs/tags/v1^{commit}': C, 'refs/heads/v1': A });
    expect(await resolveBase(r, 'origin/main')).toMatchObject({ sha: B, via: 'refs/remotes/origin/main' });
    expect(await resolveBase(r, 'v1')).toMatchObject({ sha: A, via: 'refs/heads/v1' });
    expect(await resolveBase(reader({ 'refs/tags/v2^{commit}': C }), 'v2')).toMatchObject({ sha: C, via: 'refs/tags/v2' });
    expect(r.asked.every((x) => x.startsWith('refs/'))).toBe(true);
  });
  it('a full commit id only if it exists; nothing for an unknown or invalid name', async () => {
    expect(await resolveBase(reader({ x: A }), A)).toMatchObject({ sha: A, via: 'commit' });
    expect(await resolveBase(reader({}), B)).toBeUndefined();
    expect(await resolveBase(reader({}), 'develop')).toBeUndefined();
    const r = reader({});
    expect(await resolveBase(r, '--upload-pack=x')).toBeUndefined();
    expect(r.asked).toEqual([]);
  });
  it('the default base order: pick, git config, setting, the remote default, main, master', () => {
    expect(defaultBaseCandidates({ pick: 'p', gitConfig: 'origin/dev', setting: 's', remoteDefault: 'origin/trunk' }).map((c) => c.spec)).toEqual(['p', 'origin/dev', 's', 'origin/trunk', 'main', 'master']);
    expect(defaultBaseCandidates({ gitConfig: '-bad', setting: 'main' }).map((c) => c.source)).toEqual(['setting', 'fallback']);
  });
  it("the remote default branch: origin/HEAD's commit, preferring main", async () => {
    expect(await remoteDefault(reader({ 'refs/remotes/origin/HEAD': A, 'refs/remotes/origin/main': A }), 'origin', async () => [])).toBe('origin/main');
    expect(await remoteDefault(reader({ 'refs/remotes/origin/HEAD': B }), 'origin', async () => [{ name: 'trunk', commit: B }])).toBe('origin/trunk');
    expect(await remoteDefault(reader({}), 'origin', async () => [])).toBeUndefined();
  });
});

// ---- the merge diff, against a real repository ----

let dir = '';
const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
const tryGit = (...args: string[]) => {
  try {
    return git(...args);
  } catch {
    return undefined;
  }
};

/** A stand-in for the git extension's API repository: the same git commands its implementation runs. */
type CliRepo = GitRepo & { changed: EventEmitter<void>; state: { untrackedChanges: unknown[]; rebaseCommit: unknown } };
function cliRepo(calls: string[] = []): CliRepo {
  const root = Uri.file(dir);
  const uri = (rel: string) => Uri.file(join(dir, rel));
  const rel = (abs: string) => relative(dir, abs).split('\\').join('/');
  const nameStatus = (out: string) => {
    const t = out.split('\0').filter(Boolean);
    const res: { uri: Uri; originalUri: Uri; renameUri: Uri | undefined; status: number }[] = [];
    for (let i = 0; i < t.length; ) {
      const s = t[i++]!;
      const a = t[i++]!;
      if (s[0] === 'R') {
        const b = t[i++]!;
        res.push({ status: 3, originalUri: uri(a), uri: uri(b), renameUri: uri(b) });
      } else res.push({ status: s[0] === 'A' ? 1 : s[0] === 'D' ? 6 : 5, originalUri: uri(a), uri: uri(a), renameUri: uri(a) });
    }
    return res;
  };
  const withStats = (range: string[]) => {
    const list = nameStatus(git('diff', '--name-status', '-z', '--diff-filter=ADMR', '--find-renames=50%', ...range, '--'));
    const t = git('diff', '--numstat', '-z', '--diff-filter=ADMR', '--find-renames=50%', ...range, '--').split('\0');
    const stats = new Map<string, [number, number]>();
    for (let i = 0; i < t.length; i++) {
      const [ins, del, p] = t[i]!.split('\t');
      if (ins === undefined || del === undefined) continue;
      const path = p === '' ? t[(i += 2)]! : p!;
      stats.set(path, [ins === '-' ? 0 : Number(ins), del === '-' ? 0 : Number(del)]);
    }
    return list.map((c) => ({ ...c, insertions: stats.get(rel(c.uri.fsPath))?.[0] ?? 0, deletions: stats.get(rel(c.uri.fsPath))?.[1] ?? 0 }));
  };
  const changed = new EventEmitter<void>();
  const state = {
    get HEAD() {
      return { type: 0, name: tryGit('symbolic-ref', '--short', '-q', 'HEAD')?.trim() || undefined, commit: git('rev-parse', 'HEAD').trim() };
    },
    refs: [],
    remotes: [] as { name: string }[],
    rebaseCommit: undefined as unknown,
    mergeChanges: [],
    indexChanges: [],
    workingTreeChanges: [],
    untrackedChanges: [] as unknown[],
    onDidChange: changed.event,
  };
  const repo = {
    changed,
    rootUri: root,
    state,
    getConfig: async (k: string) => git('config', '--local', k).trim(),
    getObjectDetails: async (treeish: string, path: string) => {
      const [meta] = git('ls-tree', '-l', treeish, '--', rel(path)).split('\t');
      if (!meta) throw new Error('unknown path');
      const [mode, , object, size] = meta.trim().split(/\s+/);
      return { mode: mode!, object: object!, size: Number(size) };
    },
    buffer: async (ref: string, path: string) => execFileSync('git', ['show', `${ref}:${rel(path)}`], { cwd: dir }),
    getCommit: async (ref: string) => {
      calls.push(`getCommit ${ref}`);
      return { hash: git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`).trim(), message: '', parents: [] };
    },
    getBranch: async () => ({ type: 0 }),
    getMergeBase: async (a: string, b: string) => tryGit('merge-base', a, b)?.trim(),
    diffWith: async (ref: string) => nameStatus(git('diff', '--name-status', '-z', '--diff-filter=ADMR', ref, '--')),
    diffBetween: async (a: string, b: string) => {
      calls.push(`diffBetween ${a} ${b}`);
      return nameStatus(git('diff', '--name-status', '-z', '--diff-filter=ADMR', `${a}...${b}`, '--'));
    },
    diffBetweenWithStats: async (a: string, b: string) => {
      calls.push(`diffBetweenWithStats ${a} ${b}`);
      return withStats([`${a}...${b}`]);
    },
    diffBetweenWithStats2: async (ref: string) => withStats([ref]),
    log: async (o: { maxEntries?: number; range?: string }) => {
      const out = git('log', '--format=%H', ...(o.range ? [o.range] : [`-n${o.maxEntries ?? 32}`]), '--');
      return out.split('\n').filter(Boolean).map((hash) => ({ hash, message: '', parents: [] }));
    },
  };
  return repo as unknown as CliRepo;
}

const opts = (over: Partial<ConstructorParameters<typeof Comparison>[1]> = {}) => ({ pick: () => undefined, mode: () => 'committed' as const, setting: () => undefined, ...over });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cx-changes-'));
  execFileSync(process.execPath, ['test/fixtures/git-repo.mjs', dir]);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('the merge diff of the fixture branch', () => {
  it("is merge-base → feature (three-dot): main's commits after the fork aren't in it", async () => {
    const calls: string[] = [];
    const c = new Comparison(cliRepo(calls), opts());
    await c.refresh();
    const s = c.snapshot!;
    const mb = git('merge-base', 'main', 'feature').trim();
    expect(s.mergeBase).toBe(mb);
    expect(mb).not.toBe(git('rev-parse', 'main').trim()); // main moved after the fork
    expect(s.base).toMatchObject({ spec: 'main', label: 'main', source: 'fallback' });
    expect(s.entries.map((e) => `${e.status} ${e.path}${e.oldPath ? ` ← ${e.oldPath}` : ''} +${e.added} -${e.removed}`)).toEqual([
      'D legacy/sleep.ts +0 -24',
      'R src/retry/backoff.ts ← old/backoff.ts +2 -2',
      'A src/retry/jitter.ts +19 -0',
      'M src/retry/retry.ts +4 -1',
      'M test/retry.test.ts +30 -0',
    ]);
    expect(s.entries.some((e) => e.path === 'main-only.ts' || e.path === 'docs/notes.md')).toBe(false);
    expect(s.commits).toEqual({ count: 3, capped: false });
    // The list is asked for from the merge-base itself, so two-dot and three-dot agree.
    expect(calls.filter((x) => x.startsWith('diffBetween'))).toEqual([`diffBetweenWithStats ${mb} ${s.head.sha}`]);
    c.dispose();
  });

  it('working tree mode adds uncommitted edits and untracked files', async () => {
    writeFileSync(join(dir, 'README.md'), '# Fixture\n\nEdited.\n');
    writeFileSync(join(dir, 'notes.txt'), 'new\n');
    const repo = cliRepo();
    const notes = Uri.file(join(dir, 'notes.txt'));
    (repo.state as { untrackedChanges: unknown[] }).untrackedChanges = [{ uri: notes, originalUri: notes, renameUri: undefined, status: 7 }];
    const c = new Comparison(repo, opts({ mode: () => 'workingTree' }));
    await c.refresh();
    const s = c.snapshot!;
    expect(s.entries.find((e) => e.path === 'README.md')).toMatchObject({ status: 'M', added: 2, removed: 0 });
    expect(s.entries.find((e) => e.path === 'notes.txt')).toMatchObject({ status: 'A', untracked: true });
    git('checkout', '--', 'README.md');
    rmSync(join(dir, 'notes.txt'));
    c.dispose();
  });

  it('without numstat in the API (VS Code 1.95), names only: counts are unknown', async () => {
    const repo = cliRepo();
    delete (repo as Partial<GitRepo>).diffBetweenWithStats;
    const c = new Comparison(repo, opts());
    await c.refresh();
    expect(c.snapshot!.countsKnown).toBe(false);
    expect(c.snapshot!.entries.every((e) => e.added === undefined)).toBe(true);
    c.dispose();
  });

  it('a picked base that no longer resolves is said, not replaced', async () => {
    const c = new Comparison(cliRepo(), opts({ pick: () => 'develop' }));
    await c.refresh();
    expect(c.state).toEqual({ kind: 'baseNotFound', spec: 'develop' });
    c.dispose();
  });

  it('on the base branch with nothing changed: onBase', async () => {
    git('checkout', '-q', 'main');
    const c = new Comparison(cliRepo(), opts());
    await c.refresh();
    expect(c.snapshot).toMatchObject({ onBase: true, entries: [] });
    git('checkout', '-q', 'feature');
    c.dispose();
  });

  it('a burst of status refreshes is one recompute; a rebase in progress keeps the last result', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const repo = cliRepo(calls);
    const c = new Comparison(repo, opts());
    c.active = true;
    await vi.advanceTimersByTimeAsync(50);
    await c.settled();
    const before = calls.length;
    const epoch = c.epoch;
    for (let i = 0; i < 10; i++) {
      repo.changed.fire();
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(400);
    await c.settled();
    // One recompute for the burst; in committed mode the list isn't even re-read (merge-base and HEAD didn't move).
    expect(c.epoch).toBe(epoch + 1);
    expect(calls.slice(before).filter((x) => x.startsWith('diffBetween'))).toHaveLength(0);
    const last = c.snapshot;
    repo.state.rebaseCommit = { hash: 'x' };
    repo.changed.fire();
    await vi.advanceTimersByTimeAsync(400);
    await c.settled();
    expect(c.busy).toBe(true);
    expect(c.snapshot).toBe(last);
    vi.useRealTimers();
    c.dispose();
  });
});

describe('documents and counts', () => {
  it('committed mode ignores typing; working tree mode recomputes only when a document turns dirty or clean', async () => {
    const stub = await import('./vscode-stub.ts');
    vi.useFakeTimers();
    const calls: string[] = [];
    let mode: 'committed' | 'workingTree' = 'committed';
    const repo = cliRepo(calls);
    const c = new Comparison(repo, opts({ mode: () => mode }));
    c.active = true;
    await vi.advanceTimersByTimeAsync(50);
    await c.settled();
    const epoch = c.epoch;
    const doc = { uri: Uri.file(join(dir, 'README.md')), isDirty: true };
    for (let i = 0; i < 5; i++) stub.events.documentChanged.fire({ document: doc, contentChanges: [] } as never);
    await vi.advanceTimersByTimeAsync(2500);
    expect(c.epoch).toBe(epoch);
    mode = 'workingTree';
    for (let i = 0; i < 5; i++) stub.events.documentChanged.fire({ document: doc, contentChanges: [] } as never);
    await vi.advanceTimersByTimeAsync(2500);
    await c.settled();
    expect(c.epoch).toBe(epoch + 1); // dirty once: one recompute, however many keystrokes
    vi.useRealTimers();
    c.dispose();
  });
});

describe('the base a sidestory on the branch gives (§11.4)', () => {
  it('comes after an explicit pick and before the default chain; one that does not resolve falls back', async () => {
    const story = new Comparison(cliRepo(), opts({ sidestoryBase: () => 'main', setting: () => 'nope' }));
    await story.refresh();
    expect(story.snapshot!.base).toMatchObject({ spec: 'main', source: 'sidestory' });
    story.dispose();
    const missing = new Comparison(cliRepo(), opts({ sidestoryBase: () => 'not-fetched' }));
    await missing.refresh();
    expect(missing.snapshot!.base.source).not.toBe('sidestory');
    missing.dispose();
    const picked = new Comparison(cliRepo(), opts({ pick: () => 'main', sidestoryBase: () => 'other' }));
    await picked.refresh();
    expect(picked.snapshot!.base.source).toBe('pick');
    picked.dispose();
  });
  it('never a commit id, and never HEAD itself (`base: "feature"` on feature): the default chain then', async () => {
    const self = new Comparison(cliRepo(), opts({ sidestoryBase: () => 'feature' }));
    await self.refresh();
    expect(self.snapshot!.base).toMatchObject({ spec: 'main', source: 'fallback' });
    self.dispose();
    const sha = git('rev-parse', 'main').trim();
    const byId = new Comparison(cliRepo(), opts({ sidestoryBase: () => sha }));
    await byId.refresh();
    expect(byId.snapshot!.base.source).toBe('fallback');
    byId.dispose();
  });
});

describe('paths Sidestory refuses (§4.5, §5.1)', () => {
  const root = '/r';
  const repo = { rootUri: Uri.file(root) } as unknown as GitRepo;
  const ch = (status: number, path: string, old?: string) => ({ status, uri: Uri.file(`${root}/${path}`), originalUri: Uri.file(`${root}/${old ?? path}`), renameUri: Uri.file(`${root}/${path}`) }) as never;
  it('are not dropped: listed as unsupported, each one change for coverage', () => {
    const r = toEntries(repo, [ch(5, 'src/a.ts'), ch(1, 'x/.git/hooks/post'), ch(5, 'bad\u0007name.ts'), ch(3, 'ok.ts', 'a/../b.ts'), ch(5, 'con')]);
    expect(r.entries.map((e) => e.path)).toEqual(['src/a.ts', 'con']); // `con` is an ordinary blob
    expect(r.unsupported).toEqual([{ path: 'x/.git/hooks/post' }, { path: 'bad\u0007name.ts' }, { path: 'ok.ts', oldPath: 'a/../b.ts' }]);
    expect(r.unsafe).toBe(0);
  });
  it('the working tree side is read from disk only for a path the file system rule passes', () => {
    for (const p of ['con', 'src/nul.txt', 'docs/a.', 'a /b', 'a.ts:stream']) {
      expect(headSideReadable('workingTree', { path: p, status: 'M' }), p).toBe(false);
      expect(headSideReadable('committed', { path: p, status: 'M' }), p).toBe(true); // a blob, read by id
      expect(headSideReadable('workingTree', { path: p, status: 'D' }), p).toBe(true); // the empty side
    }
    expect(headSideReadable('workingTree', { path: 'src/a.ts', status: 'M' })).toBe(true);
  });
});

describe('the same comparison keeps its snapshot', () => {
  it('a recompute that changes nothing keeps the Snapshot object and fires no change; a real change does', async () => {
    const repo = cliRepo();
    const c = new Comparison(repo, opts());
    let changes = 0;
    let rechecks = 0;
    c.onDidChange(() => changes++);
    c.onDidRecheck(() => rechecks++);
    await c.refresh();
    const first = c.snapshot!;
    expect(changes).toBe(1);
    await c.refresh();
    await c.refresh(true);
    expect(c.snapshot).toBe(first);
    expect(changes).toBe(1);
    expect(rechecks).toBe(2);
    expect(first.unsupported).toEqual([]);
    // Counts coverage writes onto the entries aren't a change of the comparison.
    for (const e of first.entries) Object.assign(e, { added: 999, removed: 1, counting: false, noText: true });
    await c.refresh();
    expect(c.snapshot).toBe(first);
    expect(changes).toBe(1);
    // Another base: another snapshot.
    const other = new Comparison(repo, opts({ setting: () => 'main' }));
    await other.refresh();
    expect(other.snapshot).not.toBe(first);
    other.dispose();
    c.dispose();
  });
  it('the same files with other details (uncommitted now): the same object, updated, and a change', async () => {
    const repo = cliRepo();
    const c = new Comparison(repo, opts({ mode: () => 'workingTree' }));
    let changes = 0;
    c.onDidChange(() => changes++);
    await c.refresh();
    const first = c.snapshot!;
    const touched = first.entries.find((e) => e.status === 'M')!;
    (repo.state as { workingTreeChanges: unknown[] }).workingTreeChanges = [{ uri: Uri.file(join(dir, touched.path)), originalUri: Uri.file(join(dir, touched.path)), renameUri: undefined, status: 5 }];
    await c.refresh();
    expect(c.snapshot).toBe(first);
    expect(first.uncommitted).toBe(true);
    expect(changes).toBe(2);
    (repo.state as { workingTreeChanges: unknown[] }).workingTreeChanges = [];
    c.dispose();
  });
  it('an unchanged problem (a base not found) is said once', async () => {
    const c = new Comparison(cliRepo(), opts({ pick: () => 'devlop' }));
    let changes = 0;
    c.onDidChange(() => changes++);
    await c.refresh();
    await c.refresh(true);
    expect(c.state).toEqual({ kind: 'baseNotFound', spec: 'devlop' });
    expect(changes).toBe(1);
    c.dispose();
  });
});

describe('counting commits', () => {
  // n commits on the branch: HEAD's log lists them, then the merge-base; `mb..h` lists only them.
  const fakeLog = (n: number) =>
    ({
      log: async (o: { maxEntries?: number; range?: string }) =>
        o.range ? Array.from({ length: n }, (_, i) => ({ hash: `c${i}`, message: '', parents: [] })) : Array.from({ length: Math.min(n + 1, o.maxEntries ?? 32) }, (_, i) => ({ hash: i === n ? 'mb' : `c${i}`, message: '', parents: [] })),
    }) as unknown as GitRepo;
  it('exact below the cap; 1000+ when the merge-base is further back (the range would be unbounded)', async () => {
    expect(await countCommits(fakeLog(5), 'mb', 'h')).toEqual({ count: 5, capped: false });
    expect(await countCommits(fakeLog(5000), 'mb', 'h')).toEqual({ count: 1000, capped: true });
    expect(await countCommits(fakeLog(5), 'h', 'h')).toEqual({ count: 0, capped: false });
  });
});

describe('the sidestory-git: provider (§4.5)', () => {
  const memento = () => {
    const m = new Map<string, unknown>();
    return { get: (k: string) => m.get(k), update: async (k: string, v: unknown) => void m.set(k, v), keys: () => [...m.keys()] };
  };
  it('builds and parses only full ids, known repositories and safe paths', () => {
    const ids = new RepoIds(memento() as never);
    const repo = cliRepo();
    const sha = git('rev-parse', 'HEAD').trim();
    const u = gitUri(ids, repo, sha, 'src/retry/retry.ts');
    expect(u.authority).toMatch(/^[0-9a-f]{16}$/);
    expect(u.authority).not.toContain(dir);
    expect(parseGitUri(ids, u)).toMatchObject({ repo, sha, path: 'src/retry/retry.ts' });
    expect(() => gitUri(ids, repo, 'main', 'a.ts')).toThrow();
    expect(() => gitUri(ids, repo, sha.slice(0, 7), 'a.ts')).toThrow();
    expect(() => gitUri(ids, repo, sha, '../x')).toThrow();
    expect(() => gitUri(ids, repo, sha, '.git/config')).toThrow();
    expect(parseGitUri(ids, Uri.from({ scheme: 'sidestory-git', authority: 'f'.repeat(16), path: '/a.ts', query: sha }) as never)).toBeUndefined();
    expect(parseGitUri(ids, Uri.from({ scheme: 'sidestory-git', authority: u.authority, path: '/a.ts', query: 'HEAD' }) as never)).toBeUndefined();
    expect(isSafeRepoPath('pages/[id].tsx')).toBe(true);
    expect(isSafeRepoPath('a/\u0007b')).toBe(false);
    expect(isSafeRepoPath(':(literal)x')).toBe(false);
    // Blobs are read by id: Windows device names and trailing dots are refused only for file system reads.
    for (const p of ['con', 'src/nul.txt', 'COM1/x', 'docs/a.', 'a /b']) expect(isSafeRepoPath(p), p).toBe(true);
    expect(isSafeRepoPath('console/x.ts')).toBe(true);
  });
  it('one id per root, however many wrapper objects the git API hands out', () => {
    const ids = new RepoIds(memento() as never);
    const a = cliRepo();
    const b = cliRepo(); // the same repository, another wrapper
    const id = ids.idOf(a);
    expect(ids.idOf(b)).toBe(id);
    for (let i = 0; i < 5; i++) ids.idOf(cliRepo());
    expect(ids.size).toBe(1);
    expect(ids.repo(ids.idOf(a))).toBe(a);
    ids.forget(b);
    expect(ids.repo(ids.idOf(a))).toBe(a); // asked again after closing: known again
    expect(ids.size).toBe(1);
  });
  it('the same repository gets the same id across reloads (the salt is kept)', () => {
    const m = memento();
    const a = new RepoIds(m as never).idOf(cliRepo());
    expect(new RepoIds(m as never).idOf(cliRepo())).toBe(a);
    expect(new RepoIds(memento() as never).idOf(cliRepo())).not.toBe(a);
  });
  it('serves regular files and refuses symlinks, missing paths and writes', async () => {
    symlinkSync('../README.md', join(dir, 'src/link.md'));
    git('add', 'src/link.md');
    git('-c', 'user.name=x', '-c', 'user.email=x@example.com', 'commit', '-qm', 'link');
    const sha = git('rev-parse', 'HEAD').trim();
    const ids = new RepoIds(memento() as never);
    const repo = cliRepo();
    const fs = new GitFileSystem(ids);
    const text = new TextDecoder().decode(await fs.readFile(gitUri(ids, repo, sha, 'src/retry/jitter.ts') as never));
    expect(text).toContain('export const jitter line 1;');
    expect((await fs.stat(gitUri(ids, repo, sha, 'src/retry/jitter.ts') as never)).size).toBe(Buffer.byteLength(text));
    await expect(fs.readFile(gitUri(ids, repo, sha, 'src/link.md') as never)).rejects.toThrow();
    await expect(fs.stat(gitUri(ids, repo, sha, 'nope.ts') as never)).rejects.toThrow();
    await expect(fs.stat(gitUri(ids, repo, sha, 'src') as never)).rejects.toThrow(); // a tree
    expect(() => fs.writeFile(gitUri(ids, repo, sha, 'a.ts') as never)).toThrow();
    git('reset', '-q', '--hard', 'HEAD~1');
  });
});

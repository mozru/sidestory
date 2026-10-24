// The branch probe (docs/CHANGES-PLAN.md §9.1): the base it asks about (the pick, the recorded branch base, the setting,
// then the defaults), uncommitted work on a branch that isn't its base, and repositories told apart by root.
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter, Uri } from './vscode-stub.ts';

vi.mock('vscode', () => import('./vscode-stub.ts'));
const { branchDiffersFromBase, onBaseBranch, refsFor, repoIdFor, watchBranches } = await import('../../src/extension/changes/probe.ts');
type ProbeApi = import('../../src/extension/changes/probe.ts').ProbeApi;
type ProbeRepo = import('../../src/extension/changes/probe.ts').ProbeRepo;

const HEAD = 'h'.repeat(40);
const change = { uri: Uri.file('/r/a.ts') as never };

/** A repository whose merge-bases are given per base ref (HEAD itself: no commits of its own). */
function repo(over: { name?: string; bases?: Record<string, string>; config?: Record<string, string>; dirty?: boolean; asked?: string[]; root?: string; changed?: EventEmitter<void> } = {}): ProbeRepo {
  const state = { HEAD: { name: over.name ?? 'feat', commit: HEAD }, workingTreeChanges: over.dirty ? [change] : [], indexChanges: [], untrackedChanges: [], onDidChange: over.changed?.event as never };
  return {
    rootUri: Uri.file(over.root ?? '/r') as never,
    state,
    getMergeBase: async (a: string) => {
      over.asked?.push(a);
      return over.bases?.[a];
    },
    getConfig: async (k: string) => {
      const v = over.config?.[k];
      if (v === undefined) throw new Error('unset');
      return v;
    },
  };
}
const api = (...repos: ProbeRepo[]): ProbeApi => ({ state: 'initialized', repositories: repos, onDidChangeState: new EventEmitter<string>().event, onDidOpenRepository: new EventEmitter<ProbeRepo>().event });

describe('the branch probe', () => {
  it('asks the refs a base name may mean; a full id as itself; nothing for bad names', () => {
    expect(refsFor('develop')).toEqual(['refs/heads/develop', 'refs/remotes/origin/develop', 'refs/remotes/develop', 'refs/tags/develop']);
    expect(refsFor('a'.repeat(40))).toEqual(['a'.repeat(40)]);
    for (const bad of ['-x', 'a..b', 'HEAD', 'x@{1}', '', undefined]) expect(refsFor(bad), String(bad)).toEqual([]);
  });

  it('a branch with commits of its own against the defaults', async () => {
    expect(await branchDiffersFromBase(10, { api: api(repo({ bases: { 'refs/heads/main': 'm'.repeat(40) } })) })).toBe(true);
    expect(await branchDiffersFromBase(10, { api: api(repo({ bases: { 'refs/heads/main': HEAD } })) })).toBe(false);
  });

  it('the pick is the base, alone: a pick at HEAD means no changes; one that resolves nowhere is worth showing', async () => {
    const asked: string[] = [];
    const r = repo({ bases: { 'refs/heads/main': 'm'.repeat(40), 'refs/heads/feat-base': HEAD }, asked });
    expect(await branchDiffersFromBase(10, { api: api(r), pick: (_root, branch) => (branch === 'feat' ? 'feat-base' : undefined) })).toBe(false);
    expect(asked).not.toContain('refs/heads/main');
    expect(await branchDiffersFromBase(10, { api: api(repo()), pick: () => 'devlop' })).toBe(true);
  });

  it('the branch base Git recorded comes before the setting and the defaults', async () => {
    const r = repo({ bases: { 'refs/remotes/origin/develop': HEAD, 'refs/heads/main': 'm'.repeat(40) }, config: { 'branch.feat.vscode-merge-base': 'origin/develop' } });
    expect(await branchDiffersFromBase(10, { api: api(r) })).toBe(false);
  });

  it('uncommitted work counts on a branch that is not its base, never on the base itself', async () => {
    expect(await branchDiffersFromBase(10, { api: api(repo({ dirty: true, bases: { 'refs/heads/main': HEAD } })) })).toBe(true);
    expect(await branchDiffersFromBase(10, { api: api(repo({ name: 'main', dirty: true, bases: { 'refs/heads/main': HEAD } })) })).toBe(false);
    expect(onBaseBranch('main', 'refs/remotes/origin/main')).toBe(true);
    expect(onBaseBranch('master', 'refs/remotes/origin/HEAD')).toBe(true);
    expect(onBaseBranch('feat', 'refs/remotes/origin/HEAD')).toBe(false);
    expect(onBaseBranch(undefined, 'refs/heads/main')).toBe(false);
  });

  it('repository ids are stable for a root and salt, and reveal no path', () => {
    const a = repoIdFor('0'.repeat(32), '/no/such/repo');
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(repoIdFor('0'.repeat(32), '/no/such/repo')).toBe(a);
    expect(repoIdFor('1'.repeat(32), '/no/such/repo')).not.toBe(a);
  });

  it('watching: once per root, and only when HEAD or the uncommitted state changes', async () => {
    vi.useFakeTimers();
    const stub = await import('./vscode-stub.ts');
    const changed = new EventEmitter<void>();
    const r1 = repo({ changed });
    const r2 = repo({ changed }); // the same repository, another wrapper
    const saved = stub.extensions.git;
    stub.extensions.git = api(r1, r2);
    const getExtension = stub.extensions.getExtension;
    // The stub's extension has no `enabled`: one that does, for this test.
    (stub.extensions as { getExtension: unknown }).getExtension = (id: string) => (id === 'vscode.git' ? { isActive: true, exports: { enabled: true, getAPI: () => stub.extensions.git } } : undefined);
    let calls = 0;
    const d = await watchBranches(() => calls++, 100);
    changed.fire(); // nothing moved
    await vi.advanceTimersByTimeAsync(200);
    expect(calls).toBe(0);
    (r1.state as { workingTreeChanges: unknown[] }).workingTreeChanges = [change];
    changed.fire();
    await vi.advanceTimersByTimeAsync(200);
    expect(calls).toBe(1); // one subscription per root: one call
    d.dispose();
    (stub.extensions as { getExtension: unknown }).getExtension = getExtension;
    stub.extensions.git = saved;
    vi.useRealTimers();
  });

  it('no git extension yet (Restricted Mode, trust just granted): it attaches when the extension appears, and says so', async () => {
    vi.useFakeTimers();
    const stub = await import('./vscode-stub.ts');
    const changed = new EventEmitter<void>();
    const r1 = repo({ changed });
    const saved = stub.extensions.git;
    const getExtension = stub.extensions.getExtension;
    let present = false;
    (stub.extensions as { getExtension: unknown }).getExtension = (id: string) => (id === 'vscode.git' && present ? { isActive: true, exports: { enabled: true, getAPI: () => api(r1) } } : undefined);
    let calls = 0;
    const d = await watchBranches(() => calls++, 100);
    stub.events.trustGranted.fire(); // the trust event first: the extension isn't there yet
    await vi.advanceTimersByTimeAsync(200);
    expect(calls).toBe(0);
    present = true;
    stub.events.extensionsChanged.fire();
    await vi.advanceTimersByTimeAsync(200);
    expect(calls).toBe(1); // the caller probes again, now that git can answer
    (r1.state as { workingTreeChanges: unknown[] }).workingTreeChanges = [change];
    changed.fire();
    await vi.advanceTimersByTimeAsync(200);
    expect(calls).toBe(2);
    stub.events.extensionsChanged.fire(); // attached once
    await vi.advanceTimersByTimeAsync(200);
    expect(calls).toBe(2);
    d.dispose();
    (stub.extensions as { getExtension: unknown }).getExtension = getExtension;
    stub.extensions.git = saved;
    vi.useRealTimers();
  });
});

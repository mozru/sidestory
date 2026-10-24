// The bootstrap's one git question (docs/CHANGES-PLAN.md §9.1): does this branch have work its base doesn't? Commits
// its base doesn't have, or (with `sidestory.changes.includeUncommitted` on) uncommitted changes. Then the Sidestory
// container is worth showing even with no sidestory yet, since its "This branch" group offers to explain the branch.
// One getMergeBase call per candidate base through the vscode.git API (never git itself), no file list. The base is
// the one the comparison would use where that is cheap to know: the Set Base pick, the branch's recorded base
// (`branch.<name>.vscode-merge-base`), the setting, then the usual defaults. And `watchBranches`, which asks again when
// a repository's HEAD or its uncommitted state changes (a `git checkout -b` after startup). Bundled into the bootstrap:
// it imports nothing but `vscode` and two Node built-ins.
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import * as vscode from 'vscode';

/** Where Set Base keeps its picks (workspace state), keyed by `<repo id>\n<branch>`. */
export const PICKS_KEY = 'sidestory.changes.picks';
/** The salt of repository ids (global state). */
export const SALT_KEY = 'sidestory.changes.repoSalt';

/** A repository's id: a salted hash of its root's real path, stable across reloads, revealing no path. */
export function repoIdFor(salt: string, rootFsPath: string): string {
  let real = rootFsPath;
  try {
    real = realpathSync.native(real);
  } catch {
    // keep the path as given
  }
  return createHash('sha256').update(`${salt}\n${real}`).digest('hex').slice(0, 16);
}

interface ProbeChange {
  readonly uri: vscode.Uri;
}
export interface ProbeRepo {
  readonly rootUri: vscode.Uri;
  readonly state: {
    readonly HEAD?: { readonly commit?: string; readonly name?: string };
    readonly workingTreeChanges?: readonly ProbeChange[];
    readonly indexChanges?: readonly ProbeChange[];
    readonly untrackedChanges?: readonly ProbeChange[];
    readonly onDidChange?: vscode.Event<void>;
  };
  getMergeBase(a: string, b: string): Promise<string | undefined>;
  getConfig?(key: string): Promise<string>;
}
export interface ProbeApi {
  readonly state: string;
  readonly repositories: ProbeRepo[];
  readonly onDidChangeState: vscode.Event<string>;
  readonly onDidOpenRepository: vscode.Event<ProbeRepo>;
  readonly onDidCloseRepository?: vscode.Event<ProbeRepo>;
}

const REF = /^(?![-/])[A-Za-z0-9._/-]{1,200}$/;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const okRef = (s: string | undefined): s is string => !!s && REF.test(s) && !s.includes('..') && !s.includes('@{') && !s.endsWith('.lock') && s !== 'HEAD';

/** The refs a base name may mean, in the comparison's order (a branch, a remote branch, a tag); a full id as itself. */
export function refsFor(spec: string | undefined): string[] {
  const s = spec?.trim();
  if (!s) return [];
  if (SHA.test(s)) return [s];
  if (!okRef(s)) return [];
  return [`refs/heads/${s}`, `refs/remotes/origin/${s}`, `refs/remotes/${s}`, `refs/tags/${s}`];
}

/** HEAD is the base's own branch (`main` against `refs/heads/main` or `origin/main`; `origin/HEAD` means main or master). */
export function onBaseBranch(branch: string | undefined, baseRef: string): boolean {
  if (!branch) return false;
  const m = /^refs\/(?:heads\/(.+)|remotes\/[^/]+\/(.+))$/.exec(baseRef);
  if (!m) return false;
  const name = m[1] ?? m[2];
  return name === 'HEAD' ? branch === 'main' || branch === 'master' : name === branch;
}

/** Uncommitted work in the git API's state: staged, unstaged or untracked. */
export const hasUncommitted = (repo: ProbeRepo): boolean =>
  (repo.state.workingTreeChanges?.length ?? 0) > 0 || (repo.state.indexChanges?.length ?? 0) > 0 || (repo.state.untrackedChanges?.length ?? 0) > 0;

async function probeApi(): Promise<ProbeApi | undefined> {
  if (!vscode.workspace.isTrusted) return undefined;
  const ext = vscode.extensions.getExtension<{ enabled?: boolean; getAPI(v: 1): ProbeApi }>('vscode.git');
  if (!ext) return undefined;
  const exports = ext.isActive ? ext.exports : await ext.activate();
  if (!exports.enabled) return undefined;
  return exports.getAPI(1);
}

/** Waits for the git extension to open its repositories (at most `timeoutMs`). */
async function repositories(api: ProbeApi, timeoutMs: number): Promise<ProbeRepo[]> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (api.repositories.some((r) => r.state.HEAD?.commit)) return api.repositories;
    // Initialized with no repository for a while: not a git folder.
    if (api.state === 'initialized' && !api.repositories.length && Date.now() - start > 5000) return [];
    await sleep(500);
  }
  return api.repositories;
}

export interface ProbeOptions {
  /** The Set Base pick for a repository's branch (`HEAD` when detached), if any. */
  pick?(rootFsPath: string, branch: string): string | undefined;
  /** The git API to ask (tests); else the vscode.git extension's. */
  api?: ProbeApi;
}

export async function branchDiffersFromBase(timeoutMs = 30_000, opts: ProbeOptions = {}): Promise<boolean> {
  try {
    const api = opts.api ?? (await probeApi());
    if (!api) return false;
    const cfg = vscode.workspace.getConfiguration('sidestory.changes');
    const setting = cfg.get<string>('defaultBase')?.trim();
    const uncommitted = cfg.get<boolean>('includeUncommitted', true);
    const defaults = ['refs/remotes/origin/HEAD', 'refs/heads/main', 'refs/heads/master', 'refs/remotes/origin/main', 'refs/remotes/origin/master'];
    const seen = new Set<string>();
    for (const repo of (await repositories(api, timeoutMs)).slice(0, 5)) {
      const root = repo.rootUri.toString();
      if (seen.has(root)) continue; // the API may list a repository twice, as two wrappers
      seen.add(root);
      const head = repo.state.HEAD?.commit;
      if (!head) continue;
      const branch = repo.state.HEAD?.name;
      const pick = opts.pick?.(repo.rootUri.fsPath, branch && okRef(branch) ? branch : 'HEAD');
      // A pick is the base: only its refs. One that resolves nowhere is worth showing too (This branch says so).
      const recorded = branch && okRef(branch) && repo.getConfig ? await repo.getConfig(`branch.${branch}.vscode-merge-base`).catch(() => undefined) : undefined;
      const candidates = pick ? refsFor(pick) : [...refsFor(recorded), ...refsFor(setting), ...defaults];
      let found: string | undefined;
      for (const base of candidates) {
        const mb = await repo.getMergeBase(base, head).catch(() => undefined);
        if (!mb) continue;
        if (mb.trim() !== head) return true;
        found = base;
        break;
      }
      if (pick && !found) return true;
      // No commits of its own yet: uncommitted work counts on a branch that isn't its base (a new `feat` with edits).
      if (found && uncommitted && hasUncommitted(repo) && !onBaseBranch(branch, found)) return true;
    }
  } catch {
    // no answer: the container stays as it is
  }
  return false;
}

/**
 * Calls `onChange` (debounced) when a repository's HEAD (its commit or branch) or whether it has uncommitted work
 * changes, or a repository opens. Repositories are told apart by root: the API hands out a new wrapper each time.
 */
export async function watchBranches(onChange: () => void, debounceMs = 1000): Promise<vscode.Disposable> {
  const subs = new Map<string, vscode.Disposable | undefined>();
  const sigs = new Map<string, string>();
  const outer: vscode.Disposable[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const fire = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!disposed) onChange();
    }, debounceMs);
  };
  const sig = (r: ProbeRepo) => `${r.state.HEAD?.name ?? ''}\n${r.state.HEAD?.commit ?? ''}\n${hasUncommitted(r)}`;
  const watch = (r: ProbeRepo, opened: boolean) => {
    const root = r.rootUri.toString();
    if (subs.has(root)) return;
    sigs.set(root, sig(r));
    subs.set(
      root,
      r.state.onDidChange?.(() => {
        const now = sig(r);
        if (now === sigs.get(root)) return;
        sigs.set(root, now);
        fire();
      }),
    );
    if (opened) fire();
  };
  let attached = false;
  let waiting: vscode.Disposable[] = [];
  const attach = async (late: boolean): Promise<void> => {
    let api: ProbeApi | undefined;
    try {
      api = await probeApi();
    } catch {
      // no git extension: nothing to watch (yet)
    }
    if (!api || attached || disposed) return;
    attached = true;
    waiting.forEach((d) => d.dispose());
    waiting = [];
    api.repositories.forEach((r) => watch(r, late));
    outer.push(api.onDidOpenRepository((r) => watch(r, true)));
    if (api.onDidCloseRepository) {
      outer.push(
        api.onDidCloseRepository((r) => {
          const root = r.rootUri.toString();
          subs.get(root)?.dispose();
          subs.delete(root);
          sigs.delete(root);
        }),
      );
    }
    // Found only now: the caller's earlier probe had no git to ask, so it asks again.
    if (late) fire();
  };
  await attach(false);
  if (!attached) {
    // No git API yet: the git extension doesn't run in Restricted Mode, and after trust is granted it is enabled
    // a moment later (the trust event can come first). Attach when it appears.
    waiting = [vscode.extensions.onDidChange(() => void attach(true)), vscode.workspace.onDidGrantWorkspaceTrust(() => void attach(true))];
  }
  return new vscode.Disposable(() => {
    disposed = true;
    clearTimeout(timer);
    for (const d of subs.values()) d?.dispose();
    outer.forEach((d) => d.dispose());
    waiting.forEach((d) => d.dispose());
  });
}

/** The pick function the bootstrap gives the probe: Set Base's record, read the way the full extension keeps it. */
export function picksFrom(globalState: Pick<vscode.Memento, 'get'> | undefined, workspaceState: Pick<vscode.Memento, 'get'> | undefined): ProbeOptions['pick'] {
  return (rootFsPath, branch) => {
    const salt = globalState?.get<string>(SALT_KEY);
    const picks = workspaceState?.get<unknown>(PICKS_KEY);
    if (!salt || !/^[0-9a-f]{32}$/.test(salt) || !Array.isArray(picks)) return undefined;
    const key = `${repoIdFor(salt, rootFsPath)}\n${branch}`;
    const hit = picks.find((x): x is [string, string] => Array.isArray(x) && x[0] === key && typeof x[1] === 'string');
    return hit?.[1];
  };
}

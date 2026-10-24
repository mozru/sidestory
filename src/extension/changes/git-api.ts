// The parts of the vscode.git API (git.d.ts, version 1) branch comparison uses (docs/CHANGES-PLAN.md §4.2). The
// extension never runs git itself (SECURITY.md): every call here is the git extension's, which runs git only in
// trusted workspaces. Calls newer than VS Code 1.95 are optional and feature-detected.
import * as vscode from 'vscode';
import type { RefReader } from './base.ts';
import { FULL_SHA } from './base.ts';

export interface GitChange {
  readonly uri: vscode.Uri;
  readonly originalUri: vscode.Uri;
  readonly renameUri: vscode.Uri | undefined;
  readonly status: number;
}
export interface GitDiffChange extends GitChange {
  readonly insertions: number;
  readonly deletions: number;
}
export interface GitRef {
  readonly type: number; // 0 head, 1 remote head, 2 tag
  readonly name?: string;
  readonly commit?: string;
  readonly remote?: string;
}
export interface GitBranch extends GitRef {
  readonly upstream?: { readonly remote: string; readonly name: string; readonly commit?: string };
  readonly ahead?: number;
  readonly behind?: number;
}
export interface GitCommit {
  readonly hash: string;
  readonly message: string;
  readonly parents: string[];
}
export interface GitRepo {
  readonly rootUri: vscode.Uri;
  readonly state: {
    readonly HEAD: GitBranch | undefined;
    readonly refs: GitRef[];
    readonly remotes: { readonly name: string }[];
    readonly rebaseCommit: unknown;
    readonly mergeChanges: GitChange[];
    readonly indexChanges: GitChange[];
    readonly workingTreeChanges: GitChange[];
    readonly untrackedChanges?: GitChange[];
    readonly onDidChange: vscode.Event<void>;
  };
  getConfig(key: string): Promise<string>;
  getGlobalConfig?(key: string): Promise<string>;
  getObjectDetails(treeish: string, path: string): Promise<{ mode: string; object: string; size: number }>;
  buffer(ref: string, path: string): Promise<Uint8Array>;
  getCommit(ref: string): Promise<GitCommit>;
  getBranch(name: string): Promise<GitBranch>;
  getRefs?(query: { pattern?: string | string[]; count?: number; sort?: 'alphabetically' | 'committerdate' }, token?: vscode.CancellationToken): Promise<GitRef[]>;
  getMergeBase(a: string, b: string): Promise<string | undefined>;
  diffWith(ref: string): Promise<GitChange[]>;
  /** One file's patch against the working tree. */
  diffWith(ref: string, path: string): Promise<string>;
  diffBetween(a: string, b: string): Promise<GitChange[]>;
  /** One file's patch, `git diff a...b -- path`. */
  diffBetween(a: string, b: string, path: string): Promise<string>;
  /** `git diff --raw --numstat a...b` (VS Code 1.9x+). */
  diffBetweenWithStats?(a: string, b: string): Promise<GitDiffChange[]>;
  /** `git diff --raw --numstat ref`: the working tree against ref, tracked files only (newer). */
  diffBetweenWithStats2?(ref: string): Promise<GitDiffChange[]>;
  log(options: { maxEntries?: number; range?: string }): Promise<GitCommit[]>;
  fetch?(options: { remote?: string; ref?: string }): Promise<void>;
}
export interface GitApi {
  readonly state: 'uninitialized' | 'initialized';
  readonly onDidChangeState: vscode.Event<'uninitialized' | 'initialized'>;
  readonly repositories: GitRepo[];
  readonly onDidOpenRepository: vscode.Event<GitRepo>;
  readonly onDidCloseRepository: vscode.Event<GitRepo>;
  getRepository(uri: vscode.Uri): GitRepo | null;
}
interface GitExtension {
  readonly enabled: boolean;
  readonly onDidChangeEnablement: vscode.Event<boolean>;
  getAPI(version: 1): GitApi;
}

/** Why there is no API: Restricted Mode, no git extension (vscode.dev), or `git.enabled: false` / no git binary. */
export type ApiState = { kind: 'ok'; api: GitApi; ext: GitExtension } | { kind: 'untrusted' } | { kind: 'missing' } | { kind: 'disabled'; ext?: GitExtension };

export async function gitApi(): Promise<ApiState> {
  if (!vscode.workspace.isTrusted) return { kind: 'untrusted' };
  const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!ext) return { kind: 'missing' };
  try {
    const exports = ext.isActive ? ext.exports : await ext.activate();
    if (!exports.enabled) return { kind: 'disabled', ext: exports };
    return { kind: 'ok', api: exports.getAPI(1), ext: exports };
  } catch {
    return { kind: 'disabled' };
  }
}

const quiet = async <T>(p: () => Promise<T>): Promise<T | undefined> => {
  try {
    return await p();
  } catch {
    return undefined;
  }
};

/** A `RefReader` over a repository: only validated, fully qualified refs or full ids reach the API. */
export function refReader(repo: GitRepo): RefReader {
  return {
    commit: async (ref) => {
      const c = await quiet(() => repo.getCommit(ref));
      return c && FULL_SHA.test(c.hash) ? c.hash : undefined;
    },
    upstream: async (branch) => {
      const b = await quiet(() => repo.getBranch(branch));
      return b?.upstream?.remote && b.upstream.name ? { remote: b.upstream.remote, name: b.upstream.name } : undefined;
    },
    mergeBase: async (a, b) => {
      const mb = await quiet(() => repo.getMergeBase(a, b));
      return mb && FULL_SHA.test(mb) ? mb : undefined;
    },
    remotes: () => {
      // A remote's name lands in a ref (refs/remotes/<name>/…): only names that are valid ref components.
      const names = repo.state.remotes.map((r) => r.name).filter((n) => /^[A-Za-z0-9._-]{1,100}$/.test(n) && !n.startsWith('.') && !n.startsWith('-') && !n.endsWith('.lock') && !n.includes('..'));
      const up = repo.state.HEAD?.upstream?.remote;
      const preferred = up && names.includes(up) ? up : names.includes('origin') ? 'origin' : names[0];
      return preferred ? [preferred, ...names.filter((n) => n !== preferred)] : names;
    },
  };
}

/** A config value, or undefined when unset (the API rejects then). */
export const configValue = (repo: GitRepo, key: string) => quiet(() => repo.getConfig(key)).then((v) => (v?.trim() ? v.trim() : undefined));

/** The repository's path for a git API call: absolute, built from the root and a checked repo-relative path. */
export const apiPath = (repo: GitRepo, rel: string) => vscode.Uri.joinPath(repo.rootUri, ...rel.split('/')).fsPath;

/** A file URI from the git API as a repo-relative POSIX path, or undefined when it isn't under the root. */
export function relPath(repo: GitRepo, uri: vscode.Uri): string | undefined {
  if (uri.scheme !== 'file') return undefined;
  const root = repo.rootUri.path.replace(/\/+$/, '');
  const p = uri.path;
  const win = process.platform === 'win32';
  const head = p.slice(0, root.length);
  if ((win ? head.toLowerCase() !== root.toLowerCase() : head !== root) || p[root.length] !== '/') return undefined;
  return p.slice(root.length + 1);
}

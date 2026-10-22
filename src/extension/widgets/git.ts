// Git facts for widget consent and code access (docs/WIDGETS-PLAN.md §5.1, §5.2), only through the built-in
// git extension's API and only in trusted workspaces: git itself is never spawned (repository config can run
// commands). A `.git` found by walking up the file system that the git extension has no repository for
// (disabled, outside the workspace folder, a nested repository or submodule it hasn't opened) makes the
// answer `unknown`, which the callers treat conservatively.
import { stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import * as vscode from 'vscode';

/** The parts of the vscode.git API (version 1) used here. */
interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: {
    readonly HEAD?: { readonly commit?: string };
    readonly indexChanges: readonly { readonly uri: vscode.Uri }[];
  };
  status(): Promise<void>;
  show(ref: string, path: string): Promise<string>;
  checkIgnore(paths: string[]): Promise<Set<string>>;
}
interface GitApi {
  getRepository(uri: vscode.Uri): GitRepository | null;
}

export type RepoLookup = { kind: 'none' } | { kind: 'unknown' } | { kind: 'repo'; repo: GitRepository };

/** The nearest folder at or above `dir` holding a `.git` (directory or file), or undefined. */
export async function dotGitAbove(dir: string): Promise<string | undefined> {
  for (let d = resolve(dir); ; d = dirname(d)) {
    try {
      await stat(join(d, '.git'));
      return d;
    } catch {
      // keep walking
    }
    if (dirname(d) === d) return undefined;
  }
}

export class Git {
  private api: Promise<GitApi | undefined> | undefined;
  /** One status refresh at a time per repository, reused for a moment. */
  private readonly refreshing = new Map<GitRepository, { at: number; done: Promise<void> }>();
  private readonly headTexts = new Map<string, Promise<string | null>>();

  private getApi(): Promise<GitApi | undefined> {
    if (!vscode.workspace.isTrusted) return Promise.resolve(undefined);
    this.api ??= (async () => {
      try {
        const ext = vscode.extensions.getExtension<{ getAPI(v: 1): GitApi }>('vscode.git');
        if (!ext) return undefined;
        const exports = ext.isActive ? ext.exports : await ext.activate();
        return exports.getAPI(1);
      } catch {
        return undefined;
      }
    })();
    return this.api;
  }

  /** The repository a file belongs to, as the git extension sees it (after a forced status refresh). */
  async lookup(file: vscode.Uri): Promise<RepoLookup> {
    if (file.scheme !== 'file') return { kind: 'unknown' };
    const top = await dotGitAbove(dirname(file.fsPath));
    if (!top) return { kind: 'none' };
    const api = await this.getApi();
    const repo = api?.getRepository(file) ?? null;
    // A nested repository the extension hasn't opened resolves to the outer one: that's not this file's repo.
    if (!repo || resolve(repo.rootUri.fsPath) !== top) return { kind: 'unknown' };
    await this.refresh(repo);
    return { kind: 'repo', repo };
  }

  /** Settles the repository's state (HEAD, index) before attributing a change. */
  async refresh(repo: GitRepository): Promise<void> {
    const r = this.refreshing.get(repo);
    if (r && Date.now() - r.at < 500) return r.done;
    const done = repo.status().catch(() => undefined);
    this.refreshing.set(repo, { at: Date.now(), done });
    return done;
  }

  head(repo: GitRepository): string | null {
    return repo.state.HEAD?.commit ?? null;
  }

  /** The file's text at HEAD, or null when it isn't in HEAD. Cached per commit. */
  headText(repo: GitRepository, file: vscode.Uri): Promise<string | null> {
    const head = this.head(repo);
    if (!head) return Promise.resolve(null);
    const key = `${head}\n${file.fsPath}`;
    let p = this.headTexts.get(key);
    if (!p) {
      p = repo.show(head, file.fsPath).then(
        (t) => t,
        () => null,
      );
      this.headTexts.set(key, p);
      if (this.headTexts.size > 500) this.headTexts.delete(this.headTexts.keys().next().value!);
    }
    return p;
  }

  /** In HEAD or added to the index. */
  async tracked(repo: GitRepository, file: vscode.Uri): Promise<boolean> {
    if ((await this.headText(repo, file)) !== null) return true;
    return repo.state.indexChanges.some((c) => c.uri.fsPath === file.fsPath);
  }

  async ignored(repo: GitRepository, file: vscode.Uri): Promise<boolean> {
    try {
      return (await repo.checkIgnore([file.fsPath])).has(file.fsPath);
    } catch {
      return true; // can't tell: treat as ignored (refused)
    }
  }
}

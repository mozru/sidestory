// Git facts for widget consent and code access (docs/WIDGETS-PLAN.md §5.1, §5.2), only through the built-in
// git extension's API and only in trusted workspaces: git itself is never spawned (repository config can run
// commands). A `.git` found by walking up the file system that the git extension has no repository for
// (disabled, outside the workspace folder, a nested repository or submodule it hasn't opened) makes the
// answer `unknown`, which the callers treat conservatively.
//
// Consent decisions need the repository's state after the change that triggered them (a checkout writes the
// files before, or while, it moves HEAD): `settle` waits until git is done (no index.lock, no merge or rebase
// in progress) and then for a status refresh that began after the triggering event. Code access only reads
// the state the git extension already has (it runs on every edit of an anchored file).
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import * as vscode from 'vscode';

/** The parts of the vscode.git API (version 1) used here. */
export interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: {
    readonly HEAD?: { readonly commit?: string };
    readonly indexChanges: readonly { readonly uri: vscode.Uri }[];
    readonly mergeChanges?: readonly { readonly uri: vscode.Uri }[];
    readonly rebaseCommit?: unknown;
  };
  status(): Promise<void>;
  show(ref: string, path: string): Promise<string>;
  getObjectDetails?(treeish: string, path: string): Promise<{ mode: string; object: string; size: number }>;
  checkIgnore(paths: string[]): Promise<Set<string>>;
}
export interface GitApi {
  getRepository(uri: vscode.Uri): GitRepository | null;
}

export type RepoLookup = { kind: 'none' } | { kind: 'unknown' } | { kind: 'repo'; repo: GitRepository };

/** How long `settle` waits for git to finish an operation before giving up (the caller then asks). */
export const SETTLE_TIMEOUT_MS = 15_000;
const SETTLE_POLL_MS = 250;

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

/** The repository's git directory: `.git`, or where a `.git` file (worktree, submodule) points. */
async function gitDir(root: string): Promise<string> {
  const dot = join(root, '.git');
  try {
    if ((await stat(dot)).isDirectory()) return dot;
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(dot, 'utf8'));
    if (m) return isAbsolute(m[1]!) ? m[1]! : resolve(root, m[1]!);
  } catch {
    // fall through
  }
  return dot;
}

const exists = (p: string) => stat(p).then(() => true, () => false);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Git {
  private api: Promise<GitApi | undefined> | undefined;
  /** The latest status refresh per repository, and when it began. */
  private readonly refreshing = new Map<GitRepository, { at: number; done: Promise<void> }>();
  private readonly headTexts = new Map<string, Promise<string | null>>();
  private readonly headBlobs = new Map<string, Promise<string | null>>();
  private readonly ignores = new Map<string, Promise<boolean>>();
  /** For tests: the clock. */
  now: () => number = Date.now;

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

  /** The repository a file belongs to, as the git extension sees it now (no refresh). */
  async lookup(file: vscode.Uri): Promise<RepoLookup> {
    if (file.scheme !== 'file') return { kind: 'unknown' };
    const top = await dotGitAbove(dirname(file.fsPath));
    if (!top) return { kind: 'none' };
    const api = await this.getApi();
    const repo = api?.getRepository(file) ?? null;
    // A nested repository the extension hasn't opened resolves to the outer one: that's not this file's repo.
    if (!repo || resolve(repo.rootUri.fsPath) !== top) return { kind: 'unknown' };
    return { kind: 'repo', repo };
  }

  /**
   * Waits until the repository is settled after an event at `since` (ms): no git operation holding the
   * index lock, no merge or rebase in progress, and a status refresh that began after both. False when it
   * doesn't settle in time (the caller then treats the change as arriving through git).
   */
  async settle(repo: GitRepository, since: number, timeoutMs = SETTLE_TIMEOUT_MS): Promise<boolean> {
    const deadline = this.now() + timeoutMs;
    const lock = join(await gitDir(repo.rootUri.fsPath), 'index.lock');
    for (;;) {
      if (!(await exists(lock))) {
        await this.refresh(repo, since);
        const s = repo.state;
        if (!(await exists(lock)) && s.rebaseCommit === undefined && !(s.mergeChanges?.length)) return true;
      }
      if (this.now() >= deadline) return false;
      await sleep(SETTLE_POLL_MS);
      since = Math.max(since, this.now() - SETTLE_POLL_MS); // anything older than the last check is stale too
    }
  }

  /** A status refresh that began at or after `since`; an earlier one (even if still running) isn't reused. */
  private refresh(repo: GitRepository, since: number): Promise<void> {
    const r = this.refreshing.get(repo);
    if (r && r.at >= since) return r.done;
    const at = this.now();
    const done = repo.status().catch(() => undefined);
    this.refreshing.set(repo, { at, done });
    return done;
  }

  /** Git is in the middle of something: holding the index lock, or a merge or rebase in progress. */
  async busy(repo: GitRepository): Promise<boolean> {
    const s = repo.state;
    return s.rebaseCommit !== undefined || !!s.mergeChanges?.length || (await exists(join(await gitDir(repo.rootUri.fsPath), 'index.lock')));
  }

  head(repo: GitRepository): string | null {
    return repo.state.HEAD?.commit ?? null;
  }

  private cached<T>(map: Map<string, Promise<T>>, key: string, make: () => Promise<T>): Promise<T> {
    let p = map.get(key);
    if (!p) {
      p = make();
      map.set(key, p);
      if (map.size > 500) map.delete(map.keys().next().value!);
    }
    return p;
  }

  /** The file's text at HEAD, or null when it isn't in HEAD. Cached per commit. */
  headText(repo: GitRepository, file: vscode.Uri): Promise<string | null> {
    const head = this.head(repo);
    if (!head) return Promise.resolve(null);
    return this.cached(this.headTexts, `${head}\n${file.fsPath}`, () => repo.show(head, file.fsPath).then((t) => t, () => null));
  }

  /**
   * The id of the file's blob at HEAD as git stores it (before any checkout filter, line-ending conversion or
   * symlink), or null when it isn't in HEAD. Falls back to a hash of the decoded HEAD text when the API has no
   * getObjectDetails. Cached per commit.
   */
  headBlob(repo: GitRepository, file: vscode.Uri): Promise<string | null> {
    const head = this.head(repo);
    if (!head) return Promise.resolve(null);
    return this.cached(this.headBlobs, `${head}\n${file.fsPath}`, async () => {
      if (repo.getObjectDetails) {
        try {
          const d = await repo.getObjectDetails(head, file.fsPath);
          return d?.object ? `${d.mode}:${d.object}` : null;
        } catch {
          return null;
        }
      }
      const text = await this.headText(repo, file);
      return text === null ? null : `text:${createHash('sha256').update(text).digest('hex')}`;
    });
  }

  /** In HEAD or added to the index. */
  async tracked(repo: GitRepository, file: vscode.Uri): Promise<boolean> {
    if ((await this.headText(repo, file)) !== null) return true;
    return repo.state.indexChanges.some((c) => c.uri.fsPath === file.fsPath);
  }

  /** Ignored by git; cached per HEAD and the root .gitignore's modification time (edits often aren't committed). */
  async ignored(repo: GitRepository, file: vscode.Uri): Promise<boolean> {
    const mtime = await stat(join(repo.rootUri.fsPath, '.gitignore')).then((s) => s.mtimeMs, () => 0);
    return this.cached(this.ignores, `${this.head(repo)}\n${mtime}\n${file.fsPath}`, async () => {
      try {
        return (await repo.checkIgnore([file.fsPath])).has(file.fsPath);
      } catch {
        return true; // can't tell: treat as ignored (refused)
      }
    });
  }
}

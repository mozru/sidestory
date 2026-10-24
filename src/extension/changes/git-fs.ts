// Read-only documents from git (docs/CHANGES-PLAN.md §4.5): the old side of every diff, and the head side in
// committed-only mode. `sidestory-git://<repoId>/<path>?<full commit id>` is served through the vscode.git API
// (getObjectDetails, then buffer): regular files only (never a symlink, a submodule or a tree), with size caps, and
// cached by blob id because a URI's content never changes. `sidestory-empty:/<path>` is the empty side of an
// added or deleted file. The git extension's own `git:` URIs aren't used: their query format is internal, other
// extensions decorate and lint them as the user's files, and they can't serve workspace.fs reads (release 2).
import { createHash, randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import * as vscode from 'vscode';
import { SizeLru } from '../widgets/lru.ts';
import { FULL_SHA } from './base.ts';
import { isSafeRepoPath } from './comparison.ts';
import type { GitRepo } from './git-api.ts';
import { apiPath } from './git-api.ts';
import type { ChangeStatus } from './model.ts';
import { STATUS_NAMES } from './model.ts';

export const GIT_SCHEME = 'sidestory-git';
export const EMPTY_SCHEME = 'sidestory-empty';
export const CHANGE_SCHEME = 'sidestory-change';

/** One cap for every reader: the provider can't know who asks (callers apply their own smaller caps). */
export const MAX_BLOB_BYTES = 10 * 1024 * 1024;
const READONLY_MESSAGE = 'Read-only: a version of this file from git';
const SALT_KEY = 'sidestory.changes.repoSalt';

/** Repository ids: a salted hash of the root's real path, stable across reloads, revealing no path. */
export class RepoIds {
  private readonly salt: string;
  private readonly byId = new Map<string, GitRepo>();
  private readonly ids = new Map<GitRepo, string>();

  constructor(globalState: vscode.Memento) {
    let salt = globalState.get<string>(SALT_KEY);
    if (!salt || !/^[0-9a-f]{32}$/.test(salt)) {
      salt = randomBytes(16).toString('hex');
      void globalState.update(SALT_KEY, salt);
    }
    this.salt = salt;
  }

  idOf(repo: GitRepo): string {
    let id = this.ids.get(repo);
    if (!id) {
      let real = repo.rootUri.fsPath;
      try {
        real = realpathSync.native(real);
      } catch {
        // keep the path as given
      }
      id = createHash('sha256').update(`${this.salt}\n${real}`).digest('hex').slice(0, 16);
      this.ids.set(repo, id);
      this.byId.set(id, repo);
    }
    return id;
  }

  repo(id: string): GitRepo | undefined {
    return this.byId.get(id);
  }

  forget(repo: GitRepo): void {
    const id = this.ids.get(repo);
    this.ids.delete(repo);
    if (id) this.byId.delete(id);
  }
}

/** The only way a `sidestory-git:` URI is built: a known repository, a full commit id, a safe path. */
export function gitUri(ids: RepoIds, repo: GitRepo, sha: string, path: string): vscode.Uri {
  if (!FULL_SHA.test(sha)) throw new Error('not a full commit id');
  if (!isSafeRepoPath(path)) throw new Error('unsafe path');
  return vscode.Uri.from({ scheme: GIT_SCHEME, authority: ids.idOf(repo), path: `/${path}`, query: sha });
}

export const emptyUri = (path: string) => vscode.Uri.from({ scheme: EMPTY_SCHEME, path: `/${path}` });

/** A `sidestory-git:` URI's parts, or undefined for anything malformed or naming a repository that isn't open. */
export function parseGitUri(ids: RepoIds, uri: vscode.Uri): { repo: GitRepo; sha: string; path: string } | undefined {
  if (uri.scheme !== GIT_SCHEME || !FULL_SHA.test(uri.query) || !uri.path.startsWith('/')) return undefined;
  const repo = ids.repo(uri.authority);
  const path = uri.path.slice(1);
  if (!repo || !isSafeRepoPath(path)) return undefined;
  return { repo, sha: uri.query, path };
}

const REGULAR = new Set(['100644', '100755']);

export class GitFileSystem implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly ids: RepoIds;
  private readonly stats = new SizeLru<Promise<{ object: string; size: number } | undefined>>(20_000);
  private readonly blobs = new SizeLru<Uint8Array>(64 * 1024 * 1024);
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;

  constructor(ids: RepoIds) {
    this.ids = ids;
  }

  static register(ids: RepoIds): vscode.Disposable {
    const fs = new GitFileSystem(ids);
    const empty = new EmptyFileSystem();
    return vscode.Disposable.from(
      fs,
      vscode.workspace.registerFileSystemProvider(GIT_SCHEME, fs, { isCaseSensitive: true, isReadonly: new vscode.MarkdownString(READONLY_MESSAGE) }),
      vscode.workspace.registerFileSystemProvider(EMPTY_SCHEME, empty, { isCaseSensitive: true, isReadonly: true }),
    );
  }

  private parse(uri: vscode.Uri) {
    const p = parseGitUri(this.ids, uri);
    if (!p) throw vscode.FileSystemError.FileNotFound(uri);
    return p;
  }

  /** The blob at (sha, path) when it is a regular file; symlinks (120000), gitlinks (160000) and trees aren't. */
  private details(repo: GitRepo, sha: string, path: string): Promise<{ object: string; size: number } | undefined> {
    const key = `${this.ids.idOf(repo)}\n${sha}\n${path}`;
    let p = this.stats.get(key);
    if (!p) {
      p = repo.getObjectDetails(sha, apiPath(repo, path)).then(
        (d) => (d && REGULAR.has(d.mode) && /^[0-9a-f]{40,64}$/.test(d.object) ? { object: d.object, size: d.size } : undefined),
        () => undefined,
      );
      this.stats.set(key, p, 1);
    }
    return p;
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const { repo, sha, path } = this.parse(uri);
    const d = await this.details(repo, sha, path);
    if (!d) throw vscode.FileSystemError.FileNotFound(uri);
    return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: d.size, permissions: vscode.FilePermission.Readonly };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const { repo, sha, path } = this.parse(uri);
    const d = await this.details(repo, sha, path);
    if (!d) throw vscode.FileSystemError.FileNotFound(uri);
    if (d.size > MAX_BLOB_BYTES) throw vscode.FileSystemError.Unavailable(`${path} is larger than 10 MB`);
    const cached = this.blobs.get(d.object);
    if (cached) return cached;
    const bytes = await repo.buffer(sha, apiPath(repo, path));
    // A textconv driver can make the output larger than the blob: capped after the call too.
    if (bytes.byteLength > MAX_BLOB_BYTES) throw vscode.FileSystemError.Unavailable(`${path} is larger than 10 MB`);
    const out = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.blobs.set(d.object, out, out.byteLength);
    return out;
  }

  readDirectory(): never {
    throw vscode.FileSystemError.Unavailable('Listing folders from git is not supported');
  }
  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {}); // contents never change
  }
  createDirectory(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }
  writeFile(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }
  delete(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }
  rename(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  dispose(): void {
    this.emitter.dispose();
    this.stats.clear();
    this.blobs.clear();
  }
}

/** The empty side of an added or deleted file's diff: zero bytes, under the file's own name (so its language). */
class EmptyFileSystem implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;
  stat(): vscode.FileStat {
    return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: 0, permissions: vscode.FilePermission.Readonly };
  }
  readFile(): Uint8Array {
    return new Uint8Array();
  }
  readDirectory(): never {
    throw vscode.FileSystemError.Unavailable('Not a folder');
  }
  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }
  createDirectory(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }
  writeFile(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }
  delete(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }
  rename(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }
}

// ---- status letters on the view's rows ----

const COLORS: Record<ChangeStatus, string> = {
  A: 'gitDecoration.addedResourceForeground',
  M: 'gitDecoration.modifiedResourceForeground',
  D: 'gitDecoration.deletedResourceForeground',
  R: 'gitDecoration.renamedResourceForeground',
  C: 'gitDecoration.addedResourceForeground',
};

/**
 * The row's resource: `sidestory-change:/<path>?<status>`. The real `file:` URI would let the git extension decorate
 * the row with its HEAD-relative letter, contradicting ours; the path keeps its name, so file icons still apply.
 */
export const changeUri = (path: string, status: ChangeStatus | 'folder') => vscode.Uri.from({ scheme: CHANGE_SCHEME, path: `/${path}`, query: status });

export class ChangeDecorations implements vscode.FileDecorationProvider {
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== CHANGE_SCHEME) return undefined;
    const s = uri.query as ChangeStatus;
    if (!(s in COLORS)) return undefined;
    return { badge: s, color: new vscode.ThemeColor(COLORS[s]), tooltip: STATUS_NAMES[s], propagate: false };
  }
}

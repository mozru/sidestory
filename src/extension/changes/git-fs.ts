// Read-only documents from git (docs/CHANGES-PLAN.md §4.5): the old side of every diff, and the head side in
// committed-only mode. `sidestory-git://<repoId>/<path>?<full commit id>` is served through the vscode.git API
// (getObjectDetails, then buffer): regular files only (never a symlink, a submodule or a tree), with size caps, and
// cached (git-blobs.ts, shared with coverage) because a URI's content never changes. `sidestory-empty:/<path>` is
// the empty side of an added or deleted file. The git extension's own `git:` URIs aren't used: their query format is internal, other
// extensions decorate and lint them as the user's files, and they can't serve workspace.fs reads (release 2).
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { FULL_SHA } from './base.ts';
import { isSafeRepoPath, repoKey } from './comparison.ts';
import type { GitRepo } from './git-api.ts';
import { GitBlobs, MAX_BLOB_BYTES } from './git-blobs.ts';
import { repoIdFor, SALT_KEY } from './probe.ts';

export const GIT_SCHEME = 'sidestory-git';
export const EMPTY_SCHEME = 'sidestory-empty';

const READONLY_MESSAGE = 'Read-only: a version of this file from git';

/**
 * Repository ids: a salted hash of the root's real path, stable across reloads, revealing no path. Keyed by root, not
 * by object: the git API hands out a new wrapper for the same repository on every call and event. The first wrapper
 * seen for a root is the one `repo(id)` returns (any of them reads the same repository).
 */
export class RepoIds {
  private readonly salt: string;
  private readonly byId = new Map<string, GitRepo>();
  private readonly ids = new Map<string, string>();

  constructor(globalState: vscode.Memento) {
    let salt = globalState.get<string>(SALT_KEY);
    if (!salt || !/^[0-9a-f]{32}$/.test(salt)) {
      salt = randomBytes(16).toString('hex');
      void globalState.update(SALT_KEY, salt);
    }
    this.salt = salt;
  }

  idOf(repo: GitRepo): string {
    const root = repoKey(repo);
    let id = this.ids.get(root);
    if (!id) {
      id = repoIdFor(this.salt, repo.rootUri.fsPath);
      this.ids.set(root, id);
    }
    if (!this.byId.has(id)) this.byId.set(id, repo);
    return id;
  }

  /** The id a repository rooted at `fsPath` gets (Set Base's picks are keyed by it). */
  idOfPath(fsPath: string): string {
    return repoIdFor(this.salt, fsPath);
  }

  repo(id: string): GitRepo | undefined {
    return this.byId.get(id);
  }

  /** How many repositories have ids (for tests: one per root, however many wrappers). */
  get size(): number {
    return this.ids.size;
  }

  forget(repo: GitRepo): void {
    const root = repoKey(repo);
    const id = this.ids.get(root);
    this.ids.delete(root);
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
  private readonly blobs: GitBlobs;
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;

  constructor(ids: RepoIds, blobs = new GitBlobs()) {
    this.ids = ids;
    this.blobs = blobs;
  }

  static register(ids: RepoIds, blobs: GitBlobs): vscode.Disposable {
    const fs = new GitFileSystem(ids, blobs);
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
  private async details(repo: GitRepo, sha: string, path: string): Promise<{ object: string; size: number } | undefined> {
    const d = await this.blobs.stat(repo, sha, path);
    return d && d !== 'missing' && REGULAR.has(d.mode) && /^[0-9a-f]{40,64}$/.test(d.object) ? { object: d.object, size: d.size } : undefined;
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
    const bytes = await this.blobs.read(repo, sha, path);
    // A textconv driver can make the output larger than the blob: capped after the call too.
    if (bytes.byteLength > MAX_BLOB_BYTES) throw vscode.FileSystemError.Unavailable(`${path} is larger than 10 MB`);
    return bytes;
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

// Running git safely from the checker (docs/CHANGES-PLAN.md §13.2). Used only by check.cjs: the extension never
// runs git itself (SECURITY.md). The repository's files may be hostile (a PR in CI, a cloned project), and the
// checker may be run by an agent, so:
//
// - the repository is found here, in JS (a `.git` directory, or a `.git` file whose `gitdir:` is a directory), and
//   git always gets it explicitly (`--git-dir`, `--work-tree`, `cwd` the root): a bare repository planted inside
//   the tree is never discovered and its config never read;
// - git is found in JS (`resolveGit`): an absolute PATH entry outside the repository, never the working directory
//   (Windows searches the current directory first, and a committed git.exe would run), and spawned by that path;
// - git runs through execFile/spawn, never a shell, with every `GIT_*` variable removed and a fixed set added;
// - every call turns off the pager, fsmonitor, hooks, signatures and the network (`GIT_ALLOW_PROTOCOL=none`, which
//   repository config can't override, unlike `protocol.allow`), and is killed after GIT_LIMITS.callMs;
// - refs pass §3.1's grammar and are resolved to full ids through fully qualified candidates; paths follow `--`
//   with literal pathspecs; only hex ids are written to `cat-file --batch`.
import { spawn } from 'node:child_process';
import { constants, realpathSync } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, posix, resolve, sep, win32 } from 'node:path';
import { MAX_COMPARE_BYTES } from '../core/hunks.ts';
import { FULL_SHA, isValidBase } from '../core/manifest.ts';
import { isSafeFsPath, isSafeRepoPath } from '../core/repo-path.ts';
import type { RefReader } from '../extension/changes/base.ts';

export const GIT_LIMITS = {
  /** One blob or working tree file: the cut-off the extension uses too (MAX_COMPARE_BYTES). */
  blobBytes: MAX_COMPARE_BYTES,
  /** Bytes read per run (§4.6). */
  runBytes: 200 * 1024 * 1024,
  /** Output of a listing call (diff --raw, ls-files, ls-tree). */
  listingBytes: 256 * 1024 * 1024,
  /** One git call, start to exit: a hung git (a lock, a pipe, a filesystem stall) can't hold CI forever. */
  callMs: 120_000,
} as const;

/** git-lfs's own filter settings, the only ones allowed on gits without `--attr-source` (§13.2). */
const LFS_FILTERS: Record<string, string> = {
  'filter.lfs.clean': 'git-lfs clean -- %f',
  'filter.lfs.smudge': 'git-lfs smudge -- %f',
  'filter.lfs.process': 'git-lfs filter-process',
};

export class GitError extends Error {
  readonly code: number | null;
  readonly stderr: string;
  constructor(message: string, code: number | null, stderr: string) {
    super(message);
    this.code = code;
    this.stderr = stderr;
  }
}

/** Paths read or shown from git output (§4.5): the rules the extension uses too (src/core/repo-path.ts). */
export { isSafeFsPath, isSafeRepoPath };

export interface RepoLocation {
  /** The working tree's root (a real path). */
  root: string;
  /** The git directory: `<root>/.git`, or a `.git` file's `gitdir:` target (worktrees, submodules). */
  gitDir: string;
}

/**
 * The nearest ancestor of `start` (itself included) with a `.git` entry, as git finds it: the first `.git` of any
 * kind decides. A directory, a link whose real path is a directory, or a file whose `gitdir:` names a directory is
 * the repository; anything else there (a broken link, a file without a valid `gitdir:`, a FIFO) means no repository,
 * never a search further up, so a stray `.git` can't hand the checker an outer repository. Git is never asked, so
 * nothing inside the tree (a planted bare repository) is ever used.
 */
export async function findRepository(start: string): Promise<RepoLocation | undefined> {
  let dir = await realpath(resolve(start)).catch(() => resolve(start));
  for (;;) {
    const dotGit = join(dir, '.git');
    const st = await lstat(dotGit).catch(() => undefined);
    if (st) {
      if (st.isDirectory()) return { root: dir, gitDir: dotGit };
      if (st.isSymbolicLink()) {
        const real = await realpath(dotGit).catch(() => undefined);
        return real && (await stat(real).catch(() => undefined))?.isDirectory() ? { root: dir, gitDir: real } : undefined;
      }
      if (!st.isFile() || st.size >= 4096) return undefined;
      const text = await readFile(dotGit, 'utf8').catch(() => '');
      const m = /^gitdir: (.+?)\r?\n?$/.exec(text);
      if (!m) return undefined;
      const target = isAbsolute(m[1]!) ? m[1]! : resolve(dir, m[1]!);
      if (!(await stat(target).catch(() => undefined))?.isDirectory()) return undefined;
      return { root: dir, gitDir: await realpath(target).catch(() => target) };
    }
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/** The environment every git call gets: no inherited `GIT_*`, then the fixed set of §13.2. */
export function gitEnv(root: string, base: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!/^GIT_/i.test(k)) env[k] = v;
  // PATH keeps only the folders resolveGit would use, so what git starts in turn (git-lfs, a credential helper,
  // ssh) can't come from `.`, an empty entry or the repository either.
  // On Windows the name is case-insensitive and an env object can hold both PATH and Path: every spelling is
  // replaced by one, so no unfiltered copy reaches the child.
  const keys = pathKeys(base, platform);
  for (const k of keys) delete env[k];
  if (keys.length) env[keys[0]!] = safePathEntries(root, base, platform).join(platform === 'win32' ? win32.delimiter : posix.delimiter);
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_NO_LAZY_FETCH = '1';
  // No transport at all: unlike `-c protocol.allow=never`, which a repository's `protocol.<name>.allow=always`
  // overrides (per-protocol config wins), this list beats every config. No protocol is named "none".
  env.GIT_ALLOW_PROTOCOL = 'none';
  // A repository's refs/replace/ could make a commit or blob read as another one.
  env.GIT_NO_REPLACE_OBJECTS = '1';
  env.GIT_CEILING_DIRECTORIES = dirname(root);
  env.LC_ALL = 'C';
  // Windows: programs git itself starts (a credential helper, an ssh) never come from the current directory.
  env.NoDefaultCurrentDirectoryInExePath = '1';
  return env;
}

/**
 * The git to run, found in JS rather than by spawn: the first `git` (on Windows `git.exe` or `git.com`, never a
 * `.bat` or `.cmd`) in an absolute PATH entry that isn't the repository or inside it. Relative and empty entries
 * (`.`, `::`) are skipped, as is the working directory itself: on Windows a bare `git` would be looked up in the
 * current directory (the repository's root) first, so a committed git.exe would run. Undefined when none is found.
 */
export async function resolveGit(root: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  const windows = platform === 'win32';
  const p = windows ? win32 : posix;
  const names = windows ? ['git.exe', 'git.com'] : ['git'];
  for (const dir of safePathEntries(root, env, platform)) {
    for (const name of names) {
      const file = p.join(dir, name);
      const st = await stat(file).catch(() => undefined);
      if (!st?.isFile()) continue;
      if (!windows && !(await access(file, constants.X_OK).then(() => true, () => false))) continue;
      return file;
    }
  }
  return undefined;
}

/**
 * The PATH variable's names in `env`: on Windows every spelling (`PATH`, `Path`, …; an exact `PATH` first, then
 * `Path`, then the rest), elsewhere only `PATH`.
 */
export function pathKeys(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform !== 'win32') return Object.prototype.hasOwnProperty.call(env, 'PATH') ? ['PATH'] : [];
  const rank = (k: string) => (k === 'PATH' ? 0 : k === 'Path' ? 1 : 2);
  return Object.keys(env)
    .filter((k) => k.toUpperCase() === 'PATH')
    .sort((a, b) => rank(a) - rank(b));
}

/**
 * PATH's folders that may be searched, as real paths: absolute entries only (no `.`, no empty entry), existing, and
 * neither the repository's root nor inside it (compared case-insensitively on Windows and macOS).
 */
export function safePathEntries(root: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const windows = platform === 'win32';
  const p = windows ? win32 : posix;
  const key = pathKeys(env, platform)[0];
  const pathVar = (key !== undefined ? env[key] : undefined) ?? '';
  const fold = (s: string) => (windows || platform === 'darwin' ? s.toLowerCase() : s);
  const real = (s: string) => {
    try {
      // Native: on Windows it expands 8.3 short names (RUNNER~1), as findRepository's root is expanded, so a short
      // spelling of a folder inside the repository is still recognised as inside it.
      return realpathSync.native(s);
    } catch {
      return undefined;
    }
  };
  const rootReal = fold(real(root) ?? root);
  const insideRoot = (d: string) => {
    const f = fold(d);
    return f === rootReal || f.startsWith(rootReal.endsWith(p.sep) ? rootReal : rootReal + p.sep);
  };
  const out: string[] = [];
  for (let entry of pathVar.split(p.delimiter)) {
    if (windows) entry = entry.replace(/^"(.*)"$/, '$1');
    if (!entry || !p.isAbsolute(entry)) continue;
    const dir = real(entry);
    if (!dir || insideRoot(dir) || insideRoot(p.resolve(entry)) || out.includes(dir)) continue;
    out.push(dir);
  }
  return out;
}

/** One raw diff record (`--raw -z`). */
export interface RawEntry {
  status: string;
  oldMode: string;
  newMode: string;
  oldId: string;
  newId: string;
  /** The new path (the old one for a deletion). */
  path: string;
  /** For renames and copies: the path at the merge-base. */
  oldPath?: string;
}

export interface BlobInfo {
  type: string;
  size: number;
}

export class Git {
  readonly root: string;
  readonly gitDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly gitPath: string | undefined;
  private resolvedGit: Promise<string | undefined> | undefined;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private hooksDir: string | undefined;
  private emptyFile: string | undefined;
  private versionCache: [number, number] | undefined;
  /** Bytes read through `blobs()` and `readWorkingFile()` so far, against GIT_LIMITS.runBytes. */
  bytesRead = 0;

  constructor(loc: RepoLocation, opts: { gitPath?: string; env?: NodeJS.ProcessEnv } = {}) {
    this.root = loc.root;
    this.gitDir = loc.gitDir;
    this.env = gitEnv(loc.root, opts.env);
    this.baseEnv = opts.env ?? process.env;
    this.gitPath = opts.gitPath;
  }

  /** The git executable: `opts.gitPath` (tests), else `resolveGit` over the caller's PATH. */
  private async executable(): Promise<string> {
    if (this.gitPath) return this.gitPath;
    this.resolvedGit ??= resolveGit(this.root, this.baseEnv);
    const exe = await this.resolvedGit;
    if (!exe) throw new GitError("git wasn't found: no absolute folder on PATH outside the repository holds it. Install git, or put its folder on PATH.", null, '');
    return exe;
  }

  /** Removes the temporary hooks folder. */
  async dispose(): Promise<void> {
    if (this.hooksDir) await rm(this.hooksDir, { recursive: true, force: true });
    this.hooksDir = undefined;
  }

  private async prefix(): Promise<string[]> {
    if (!this.hooksDir) {
      this.hooksDir = await mkdtemp(join(tmpdir(), 'sidestory-git-'));
      this.emptyFile = join(this.hooksDir, 'empty');
      await writeFile(this.emptyFile, '');
      // The hooks path is an empty folder of its own; the empty attributes file lives beside it.
      await mkdir(join(this.hooksDir, 'hooks'));
    }
    return [
      '--no-pager',
      `--git-dir=${this.gitDir}`,
      `--work-tree=${this.root}`,
      '--literal-pathspecs',
      '-c', 'core.fsmonitor=false',
      '-c', `core.hooksPath=${join(this.hooksDir, 'hooks')}`,
      '-c', 'safe.bareRepository=explicit',
      '-c', 'protocol.allow=never',
      '-c', 'log.showSignature=false',
      '-c', 'diff.renameLimit=1000',
    ];
  }

  /**
   * Runs git with the hardened prefix; resolves with its output, rejects with GitError on a failure exit unless `ok`
   * allows the code, once the output passes `maxBytes` (the child is killed, and nothing more is kept), or after
   * `timeoutMs`. With `exact`, `maxBytes` is the expected size (cat-file): the output goes straight into one buffer
   * of that size, so a blob batch is held once, not as chunks plus their concatenation.
   */
  async run(args: readonly string[], opts: { input?: string; ok?: readonly number[]; maxBytes?: number; exact?: boolean; extra?: readonly string[]; timeoutMs?: number } = {}): Promise<{ code: number; stdout: Buffer; stderr: string }> {
    const argv = [...(await this.prefix()), ...(opts.extra ?? []), ...args];
    const exe = await this.executable();
    return new Promise((resolvePromise, reject) => {
      const child = spawn(exe, argv, { cwd: this.root, env: this.env, shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      const max = opts.maxBytes ?? GIT_LIMITS.listingBytes;
      const into = opts.exact ? Buffer.allocUnsafe(max) : undefined;
      const chunks: Buffer[] = [];
      let size = 0;
      let err = '';
      let settled = false;
      const fail = (e: GitError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        chunks.length = 0;
        child.kill('SIGKILL');
        reject(e);
      };
      const timeoutMs = opts.timeoutMs ?? GIT_LIMITS.callMs;
      const timer = setTimeout(() => fail(new GitError(`git ${args[0]}: no answer after ${Math.round(timeoutMs / 1000)} s`, null, '')), timeoutMs);
      child.stdout.on('data', (b: Buffer) => {
        if (settled) return;
        if (size + b.length > max) {
          fail(new GitError(`git ${args[0]}: output larger than ${max} bytes`, null, ''));
          return;
        }
        if (into) b.copy(into, size);
        else chunks.push(b);
        size += b.length;
      });
      child.stderr.on('data', (b: Buffer) => {
        if (err.length < 64_000) err += b.toString('utf8');
      });
      child.on('error', (e) => fail(new GitError(`git couldn't be run: ${e.message}`, null, '')));
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const c = code ?? -1;
        if (c === 0 || opts.ok?.includes(c)) resolvePromise({ code: c, stdout: into ? into.subarray(0, size) : chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, size), stderr: err });
        else reject(new GitError(`git ${args[0]} failed (${c}): ${err.trim().split('\n')[0] ?? ''}`, c, err));
      });
      child.stdin.on('error', () => {});
      child.stdin.end(opts.input ?? '');
    });
  }

  /** `git version` as [major, minor]. */
  async version(): Promise<[number, number]> {
    if (!this.versionCache) {
      const out = (await this.run(['version'])).stdout.toString('utf8');
      const m = /git version (\d+)\.(\d+)/.exec(out);
      this.versionCache = m ? [Number(m[1]), Number(m[2])] : [0, 0];
    }
    return this.versionCache;
  }

  /**
   * The commit a fully qualified ref (`refs/…`) or a full id names, or undefined. Anything else is refused before
   * git runs: a leading `-`, a pseudo-ref, `..`, `@{` (§3.1, §13.2).
   */
  async commit(ref: string): Promise<string | undefined> {
    const peel = ref.endsWith('^{commit}') ? ref.slice(0, -'^{commit}'.length) : ref;
    if (!isQualifiedRef(peel)) return undefined;
    const r = await this.run(['rev-parse', '--verify', '--quiet', '--end-of-options', `${peel}^{commit}`], { ok: [1, 128] });
    const sha = r.code === 0 ? r.stdout.toString('utf8').trim() : '';
    return FULL_SHA.test(sha) ? sha : undefined;
  }

  /** HEAD's commit (internal: HEAD never comes from a user or a manifest). */
  async headCommit(): Promise<string | undefined> {
    const r = await this.run(['rev-parse', '--verify', '--quiet', '--end-of-options', 'HEAD^{commit}'], { ok: [1, 128] });
    const sha = r.stdout.toString('utf8').trim();
    return r.code === 0 && FULL_SHA.test(sha) ? sha : undefined;
  }

  async mergeBases(a: string, b: string): Promise<string[]> {
    assertSha(a, b);
    const r = await this.run(['merge-base', '--all', '--end-of-options', a, b], { ok: [1] });
    return r.stdout.toString('utf8').split('\n').map((s) => s.trim()).filter((s) => FULL_SHA.test(s));
  }

  async isAncestor(a: string, b: string): Promise<boolean> {
    assertSha(a, b);
    return (await this.run(['merge-base', '--is-ancestor', '--end-of-options', a, b], { ok: [1] })).code === 0;
  }

  /** Remote names, `origin` first when it exists. */
  async remotes(): Promise<string[]> {
    const names = (await this.run(['remote'])).stdout.toString('utf8').split('\n').map((s) => s.trim()).filter((s) => isValidBase(s) && !s.includes('/'));
    return names.includes('origin') ? ['origin', ...names.filter((n) => n !== 'origin')] : names;
  }

  /** A local branch's upstream, as {remote, name}. */
  async upstream(branch: string): Promise<{ remote: string; name: string } | undefined> {
    if (!isValidBase(branch) || FULL_SHA.test(branch)) return undefined;
    const r = await this.run(['for-each-ref', '--format=%(upstream:remotename)%00%(upstream:short)', '--end-of-options', `refs/heads/${branch}`], { ok: [1] });
    const [remote, short] = r.stdout.toString('utf8').trim().split('\0');
    if (!remote || !short || !short.startsWith(`${remote}/`)) return undefined;
    return { remote, name: short.slice(remote.length + 1) };
  }

  /** A RefReader for `resolveBase` (src/extension/changes/base.ts), so the checker resolves bases in §4.3's order exactly as the view. */
  async refReader(): Promise<RefReader> {
    const remotes = await this.remotes();
    return {
      commit: (ref) => this.commit(ref).catch(() => undefined),
      upstream: (b) => this.upstream(b).catch(() => undefined),
      mergeBase: async (a, b) => (FULL_SHA.test(a) && FULL_SHA.test(b) ? (await this.mergeBases(a, b).catch(() => []))[0] : undefined),
      remotes: () => remotes,
    };
  }

  /** The empty tree's id (it differs in SHA-256 repositories). */
  async emptyTree(): Promise<string> {
    const id = (await this.run(['hash-object', '-t', 'tree', '--stdin'], { input: '' })).stdout.toString('utf8').trim();
    if (!FULL_SHA.test(id)) throw new GitError('git hash-object gave no id', null, '');
    return id;
  }

  /** Committed changes, tree to tree: no working tree, so no filter can run. */
  async diffTree(mergeBase: string, head: string): Promise<RawEntry[]> {
    assertSha(mergeBase, head);
    return parseRaw((await this.run(['diff-tree', '-r', '-z', '--raw', '--no-abbrev', '-M', '--no-ext-diff', '--no-textconv', '--end-of-options', mergeBase, head, '--'])).stdout);
  }

  /**
   * Changes from the merge-base to the working tree (tracked files). Refreshing racily modified files can run a
   * clean filter: on git 2.40+ the in-tree attributes are replaced by the empty tree's and the user's attributes
   * file by an empty one, and `info/attributes` must not mention a filter; on older gits only git-lfs's standard
   * filters may be configured. Otherwise this refuses (a WorkingTreeRefused).
   */
  async diffWorkingTree(mergeBase: string): Promise<RawEntry[]> {
    assertSha(mergeBase);
    const extra = await this.filterGuard();
    // --ignore-submodules=all: git would otherwise look inside each submodule's working tree (its config, its
    // fsmonitor) to see whether it is dirty. Committed mode still lists submodule pointer changes (not counted).
    const entries = parseRaw((await this.run(['diff', '--raw', '-z', '--no-abbrev', '-M', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--end-of-options', mergeBase, '--'], { extra })).stdout);
    // --ignore-submodules=all hides gitlink changes altogether, committed ones too. The index's gitlinks against the
    // merge-base (`--cached`: no working tree, so no submodule is looked inside) add them back: a submodule moved on
    // the branch, or staged, counts (§5.1). A submodule only checked out at another commit isn't listed.
    const listed = new Set(entries.map((e) => e.path));
    const cached = parseRaw((await this.run(['diff', '--cached', '--raw', '-z', '--no-abbrev', '--no-renames', '--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty', '--end-of-options', mergeBase, '--'], { extra })).stdout);
    for (const e of cached) if ((e.oldMode === '160000' || e.newMode === '160000') && !listed.has(e.path)) entries.push(e);
    return entries;
  }

  /** The global options for working tree reads, or throws WorkingTreeRefused. */
  async filterGuard(): Promise<string[]> {
    const [major, minor] = await this.version();
    // A linked worktree's gitDir is .git/worktrees/<name>; git reads info/attributes from the common dir.
    for (const dir of await this.attributeDirs()) {
      const file = join(dir, 'info', 'attributes');
      const info = await readFile(file, 'utf8').catch(() => '');
      if (/filter/i.test(info)) throw new WorkingTreeRefused(`${file} selects a filter, which reading the working tree could run. Use --committed, or remove it.`);
    }
    if (major > 2 || (major === 2 && minor >= 40)) {
      await this.prefix();
      return [`--attr-source=${await this.emptyTree()}`, '-c', `core.attributesFile=${this.emptyFile!}`];
    }
    const r = await this.run(['config', '-z', '--get-regexp', '^filter\\..*\\.(clean|process|smudge)$'], { ok: [1] });
    for (const rec of r.stdout.toString('utf8').split('\0')) {
      if (!rec) continue;
      const nl = rec.indexOf('\n');
      const key = (nl < 0 ? rec : rec.slice(0, nl)).toLowerCase();
      const value = nl < 0 ? '' : rec.slice(nl + 1);
      if (LFS_FILTERS[key] === value) continue;
      throw new WorkingTreeRefused(`git ${major}.${minor} can't keep the filter "${key.replace(/^filter\.|\.(clean|process|smudge)$/g, '')}" (${key}) from running while reading the working tree. Use --committed, or git 2.40 or newer.`);
    }
    return ['-c', `core.attributesFile=${this.emptyFile!}`];
  }

  /** The git directory and, for a linked worktree, its common dir (`<gitDir>/commondir`). */
  private async attributeDirs(): Promise<string[]> {
    const dirs = [this.gitDir];
    const common = (await readFile(join(this.gitDir, 'commondir'), 'utf8').catch(() => '')).trim();
    if (common && common.length < 4096) {
      const dir = isAbsolute(common) ? common : resolve(this.gitDir, common);
      if (dir !== this.gitDir) dirs.push(dir);
    }
    return dirs;
  }

  /** Untracked files that aren't ignored, as `git status` lists them. */
  async untracked(): Promise<string[]> {
    return (await this.run(['ls-files', '-o', '--exclude-standard', '-z', '--'])).stdout.toString('utf8').split('\0').filter(Boolean);
  }

  /** Blob ids and modes of paths at a commit (`ls-tree`), for files the diff doesn't list. */
  async lsTree(commit: string, paths: readonly string[]): Promise<Map<string, { mode: string; id: string }>> {
    assertSha(commit);
    const out = new Map<string, { mode: string; id: string }>();
    const safe = paths.filter(isSafeRepoPath);
    for (let i = 0; i < safe.length; i += 200) {
      const r = await this.run(['ls-tree', '-z', '--full-tree', '--end-of-options', commit, '--', ...safe.slice(i, i + 200)]);
      for (const rec of r.stdout.toString('utf8').split('\0')) {
        const m = /^(\d{6}) (\w+) ([0-9a-f]{40,64})\t(.*)$/s.exec(rec);
        if (m && m[2] === 'blob') out.set(m[4]!, { mode: m[1]!, id: m[3]! });
      }
    }
    return out;
  }

  /** Every file under a folder at a commit (`ls-tree -r`). */
  async lsTreeRecursive(commit: string, folder: string): Promise<Map<string, { mode: string; id: string }>> {
    assertSha(commit);
    if (!isSafeRepoPath(folder)) return new Map();
    const r = await this.run(['ls-tree', '-r', '-z', '--full-tree', '--end-of-options', commit, '--', folder]);
    const out = new Map<string, { mode: string; id: string }>();
    for (const rec of r.stdout.toString('utf8').split('\0')) {
      const m = /^(\d{6}) (\w+) ([0-9a-f]{40,64})\t(.*)$/s.exec(rec);
      if (m && m[2] === 'blob') out.set(m[4]!, { mode: m[1]!, id: m[3]! });
    }
    return out;
  }

  /** Types and sizes of blobs (`cat-file --batch-check`), by hex id only. Missing ones are left out. */
  async blobInfo(ids: readonly string[]): Promise<Map<string, BlobInfo>> {
    const unique = [...new Set(ids)];
    assertSha(...unique);
    const out = new Map<string, BlobInfo>();
    if (!unique.length) return out;
    const r = await this.run(['cat-file', '--batch-check'], { input: unique.map((id) => `${id}\n`).join('') });
    for (const line of r.stdout.toString('utf8').split('\n')) {
      const m = /^([0-9a-f]{40,64}) (\w+) (\d+)$/.exec(line);
      if (m) out.set(m[1]!, { type: m[2]!, size: Number(m[3]) });
    }
    return out;
  }

  /**
   * Blob contents through one streamed `cat-file --batch`, by hex id only (never paths), after `--batch-check`:
   * blobs over 10 MB, missing ones and anything past the run's 200 MB are left out (`skipped` says why).
   */
  async blobs(ids: readonly string[]): Promise<{ bytes: Map<string, Uint8Array>; skipped: Map<string, 'missing' | 'too-large' | 'budget' | 'not-a-blob'> }> {
    const unique = [...new Set(ids)];
    assertSha(...unique);
    const bytes = new Map<string, Uint8Array>();
    const skipped = new Map<string, 'missing' | 'too-large' | 'budget' | 'not-a-blob'>();
    const info = await this.blobInfo(unique);
    const wanted: string[] = [];
    for (const id of unique) {
      const i = info.get(id);
      if (!i) skipped.set(id, 'missing');
      else if (i.type !== 'blob') skipped.set(id, 'not-a-blob');
      else if (i.size > GIT_LIMITS.blobBytes) skipped.set(id, 'too-large');
      else if (this.bytesRead + i.size > GIT_LIMITS.runBytes) skipped.set(id, 'budget');
      else {
        this.bytesRead += i.size;
        wanted.push(id);
      }
    }
    if (!wanted.length) return { bytes, skipped };
    const max = wanted.reduce((n, id) => n + info.get(id)!.size + 200, 0);
    const out = (await this.run(['cat-file', '--batch'], { input: wanted.map((id) => `${id}\n`).join(''), maxBytes: max, exact: true })).stdout;
    let at = 0;
    while (at < out.length) {
      const nl = out.indexOf(10, at);
      if (nl < 0) break;
      const header = out.subarray(at, nl).toString('utf8');
      const m = /^([0-9a-f]{40,64}) (\w+) (\d+)$/.exec(header);
      if (!m) break;
      const size = Number(m[3]);
      // Views into the one output buffer, not copies: every byte of it is a wanted blob.
      bytes.set(m[1]!, out.subarray(nl + 1, nl + 1 + size));
      at = nl + 1 + size + 1;
    }
    for (const id of wanted) if (!bytes.has(id)) skipped.set(id, 'missing');
    return { bytes, skipped };
  }

  /** Whether a working tree path is a regular file (no link, no folder), without reading it; the file system rule first. */
  async isWorkingFile(rel: string): Promise<boolean> {
    if (!isSafeFsPath(rel)) return false;
    const st = await lstat(join(this.root, ...rel.split('/'))).catch(() => undefined);
    return !!st?.isFile();
  }

  /**
   * A working tree file's bytes (the new side in working tree mode): a path that passes `isSafeFsPath`, lstat first
   * and no links, its real path inside the root, a regular file only, opened without blocking (an untracked FIFO),
   * size checked first.
   */
  async readWorkingFile(rel: string): Promise<{ bytes: Uint8Array } | { error: 'unsupported' | 'missing' | 'link' | 'directory' | 'not-a-file' | 'outside' | 'too-large' | 'budget' }> {
    // The file system rule: no device names, trailing dots or spaces, or ":" (NTFS streams) on any OS.
    if (!isSafeFsPath(rel)) return { error: 'unsupported' };
    const abs = join(this.root, ...rel.split('/'));
    const st = await lstat(abs).catch(() => undefined);
    if (!st) return { error: 'missing' };
    if (st.isSymbolicLink()) return { error: 'link' };
    if (st.isDirectory()) return { error: 'directory' };
    if (!st.isFile()) return { error: 'not-a-file' };
    const real = await realpath(abs).catch(() => undefined);
    const rootReal = await realpath(this.root).catch(() => this.root);
    if (!real || !(real === rootReal || real.startsWith(rootReal.endsWith(sep) ? rootReal : rootReal + sep))) return { error: 'outside' };
    if (st.size > GIT_LIMITS.blobBytes) return { error: 'too-large' };
    if (this.bytesRead + st.size > GIT_LIMITS.runBytes) return { error: 'budget' };
    const handle = await open(real, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0)).catch(() => undefined);
    if (!handle) return { error: 'missing' };
    try {
      const hs = await handle.stat();
      if (!hs.isFile()) return { error: 'not-a-file' };
      if (hs.size > GIT_LIMITS.blobBytes) return { error: 'too-large' };
      const buf = Buffer.alloc(hs.size);
      let off = 0;
      while (off < hs.size) {
        const { bytesRead } = await handle.read(buf, off, hs.size - off, off);
        if (bytesRead === 0) break;
        off += bytesRead;
      }
      this.bytesRead += off;
      return { bytes: new Uint8Array(buf.buffer, buf.byteOffset, off) };
    } finally {
      await handle.close();
    }
  }
}

/** Raised when working tree mode can't rule out a clean filter (§13.2). */
export class WorkingTreeRefused extends Error {}

/** `refs/…` names that pass §3.1's grammar after the prefix, or full ids. */
export function isQualifiedRef(ref: string): boolean {
  if (FULL_SHA.test(ref)) return true;
  if (!ref.startsWith('refs/')) return false;
  return isValidBase(ref.slice(5)) && !FULL_SHA.test(ref.slice(5));
}

function assertSha(...ids: string[]): void {
  for (const id of ids) if (!FULL_SHA.test(id)) throw new GitError(`not a full object id: ${JSON.stringify(id.slice(0, 80))}`, null, '');
}

/** Parses `--raw -z` output: `:<old mode> <new mode> <old id> <new id> <status>\0<path>\0[<new path>\0]`. */
export function parseRaw(out: Buffer): RawEntry[] {
  const parts = out.toString('utf8').split('\0');
  const entries: RawEntry[] = [];
  for (let i = 0; i < parts.length; ) {
    const head = parts[i++]!;
    if (!head) continue;
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) ([A-Z])\d*$/.exec(head);
    if (!m) break;
    const status = m[5]!;
    const first = parts[i++] ?? '';
    if (status === 'R' || status === 'C') {
      const second = parts[i++] ?? '';
      entries.push({ status, oldMode: m[1]!, newMode: m[2]!, oldId: m[3]!, newId: m[4]!, path: second, oldPath: first });
    } else entries.push({ status, oldMode: m[1]!, newMode: m[2]!, oldId: m[3]!, newId: m[4]!, path: first });
  }
  return entries;
}

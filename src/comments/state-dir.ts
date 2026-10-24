// The per-user state directory (docs/COMMENTS-PLAN.md §9.3, §9.4): where the extension and the MCP servers
// exchange sends, delivery records, presence, the reader's profile and the authored ledger. Outside every
// repository, so no file in a repository can cause a push.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, promises as fs, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { mkdirsNoFollow, readSmall, UnsafePathError } from './fsx.ts';

/** The default location, per OS (a fixed path on Linux: XDG_STATE_HOME often differs between GUI and terminal). */
export function defaultStateDir(platform: NodeJS.Platform = process.platform, home = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'sidestory');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'sidestory');
  return join(home, '.local', 'state', 'sidestory');
}

/** The state directory: the override the extension recorded in `override.json` at the default location, else the default. */
export async function resolveStateDir(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  // For tests and unusual setups launched by hand; the extension never sets it.
  if (env.SIDESTORY_STATE_DIR && isAbsolute(env.SIDESTORY_STATE_DIR)) return env.SIDESTORY_STATE_DIR;
  const def = defaultStateDir();
  const text = await readSmall(join(def, 'override.json'), 10_000);
  if (text) {
    try {
      const v = JSON.parse(text) as { stateDir?: unknown };
      if (typeof v.stateDir === 'string' && isAbsolute(v.stateDir)) return v.stateDir;
    } catch {
      /* ignored: the default */
    }
  }
  return def;
}

export const STATE_SUBDIRS = ['sessions', 'sends', 'pushed', 'seen', 'authored', 'bin'] as const;

/**
 * Creates (0700) and checks the state directory: each segment below an existing ancestor created without following
 * symlinks; refused when it's a link, not ours, or writable by group or others (POSIX).
 */
export async function ensureStateDir(dir: string): Promise<string> {
  // Find the nearest existing ancestor, then create the rest segment by segment.
  let base = dir;
  const segs: string[] = [];
  while (!existsSync(base)) {
    segs.unshift(base.slice(dirname(base).length).replace(/^[\\/]+/, ''));
    const up = dirname(base);
    if (up === base) break;
    base = up;
  }
  await mkdirsNoFollow(base, segs, 0o700);
  checkPrivate(dir);
  for (const s of STATE_SUBDIRS) {
    await mkdirsNoFollow(dir, [s], 0o700);
    checkPrivate(join(dir, s));
  }
  return dir;
}

export function checkPrivate(dir: string): void {
  const l = lstatSync(dir);
  if (l.isSymbolicLink() || !l.isDirectory()) throw new UnsafePathError(`${dir} is not a plain folder`);
  if (process.platform === 'win32') return;
  const uid = process.getuid?.();
  if (uid !== undefined && l.uid !== uid) throw new UnsafePathError(`${dir} isn't owned by you`);
  if (l.mode & 0o022) throw new UnsafePathError(`${dir} is writable by other users`);
}

/** A canonical absolute path: real (case-canonical on macOS and Windows), drive letter uppercased. */
export function canonical(p: string): string {
  let r: string;
  try {
    r = realpathSync.native(p);
  } catch {
    r = p;
  }
  return /^[a-z]:/.test(r) ? r[0]!.toUpperCase() + r.slice(1) : r;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The folder a path's sidestories belong to: nearest holding `.sidestory/`, else nearest holding `.git`, else itself. */
export function repoRootFor(path: string): string {
  const start = canonical(path);
  for (let d = start; ; d = dirname(d)) {
    if (isDir(join(d, '.sidestory'))) return d;
    if (dirname(d) === d) break;
  }
  for (let d = start; ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return d;
    if (dirname(d) === d) break;
  }
  return start;
}

/** The repository key both sides use (§9.3): 16 hex of the SHA-256 of `repoRootFor`. */
export function repoKeyFor(path: string): string {
  return createHash('sha256').update(repoRootFor(path), 'utf8').digest('hex').slice(0, 16);
}

/**
 * Whether a session with these roots serves `path` (§9.3): a canonical root contains it, and the way down from the
 * root crosses no `.git` file (a separate worktree), no `.git` folder other than the root's own repository's (or,
 * for a root outside any repository, the first one below it), and no `.claude/worktrees` segment. A session in a
 * subfolder serves the repository above it too (walking up to the folder holding `.sidestory/` or `.git`).
 */
export function servesPath(roots: readonly string[], path: string): boolean {
  const target = canonical(path);
  for (const r of roots) {
    const root = canonical(r);
    // A session started in repo/src serves repo: walk up to the nearest folder holding .sidestory or .git.
    const top = repoRootFor(root);
    const base = isInside(target, top) ? top : isInside(target, root) ? root : undefined;
    if (!base) continue;
    const rel = relative(base, target);
    if (!rel) return true;
    const segs = rel.split(sep);
    if (segs.some((s, i) => s === '.claude' && segs[i + 1] === 'worktrees')) continue;
    let ok = true;
    let sawRepo = existsSync(join(base, '.git'));
    let d = base;
    for (const s of segs) {
      d = join(d, s);
      const git = join(d, '.git');
      if (!existsSync(git)) continue;
      let file = false;
      try {
        file = lstatSync(git).isFile();
      } catch {
        /* gone */
      }
      if (file || sawRepo) {
        ok = false;
        break;
      }
      sawRepo = true;
    }
    if (ok) return true;
  }
  return false;
}

function isInside(p: string, root: string): boolean {
  return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
}

export interface Profile {
  v: 1;
  /** The reader's display name, cleaned (§5.1). */
  name?: string;
  /** `sidestory.claude.channelFlag` (§9.2). */
  channelFlag?: 'dev' | 'channels';
}

export async function readProfile(state: string): Promise<Profile> {
  const t = await readSmall(join(state, 'profile.json'), 10_000);
  try {
    const v = t ? (JSON.parse(t) as Profile) : undefined;
    return v && v.v === 1 ? v : { v: 1 };
  } catch {
    return { v: 1 };
  }
}

/** Deletes records older than `maxAgeMs` in a state subfolder (sends, pushed, seen). */
export async function sweepOld(dir: string, maxAgeMs: number, now = Date.now()): Promise<number> {
  let n = 0;
  for (const f of await fs.readdir(dir).catch(() => [] as string[])) {
    const p = join(dir, f);
    try {
      const s = await fs.lstat(p);
      if (s.isFile() && now - s.mtimeMs > maxAgeMs) {
        await fs.unlink(p);
        n++;
      }
    } catch {
      /* raced */
    }
  }
  return n;
}

// File-system primitives for thread files and the state directory (docs/COMMENTS-PLAN.md §3.2, §12.5): no
// symlinks followed on the way down, no-replace writes through link-then-unlink, and real-path checks after.
// Node only, no VS Code: shared by the extension, the MCP server and the checker.
import { randomBytes } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { join, sep } from 'node:path';
import { encodeUlid } from '../core/threads/schema.ts';

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

let lastTime = 0;
let lastRandom = new Uint8Array(10);

/** A fresh ULID, monotonic within this process. */
export function newUlid(now = Date.now()): string {
  if (now <= lastTime) {
    // Same millisecond: increment the random part, so ids made in a burst still sort in creation order.
    const r = lastRandom.slice();
    for (let i = r.length - 1; i >= 0; i--) {
      if (r[i]! < 255) {
        r[i]!++;
        break;
      }
      r[i] = 0;
    }
    lastRandom = r;
    return encodeUlid(lastTime, r);
  }
  lastTime = now;
  lastRandom = new Uint8Array(randomBytes(10));
  lastRandom[0]! &= 0x7f; // room to increment
  return encodeUlid(now, lastRandom);
}

export const newId = (prefix: 't' | 'e' | 's' | 'srv') => `${prefix}_${newUlid()}`;

export class UnsafePathError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retries Windows' transient EPERM/EBUSY (antivirus, open watchers) with backoff. */
export async function retrying<T>(f: () => Promise<T>, tries = 5): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await f();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') || i >= tries - 1) throw e;
      await sleep(50 * 2 ** i);
    }
  }
}

/**
 * Creates `base/…segments` one segment at a time, refusing a segment that exists as a symlink or a non-directory.
 * `base` itself must exist and is trusted (a workspace root, the user's home).
 */
export async function mkdirsNoFollow(base: string, segments: readonly string[], mode?: number): Promise<string> {
  let dir = base;
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..' || seg.includes('/') || seg.includes('\\')) throw new UnsafePathError(`bad path segment ${seg}`);
    dir = join(dir, seg);
    let info;
    try {
      info = await fs.lstat(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      try {
        await fs.mkdir(dir, mode !== undefined ? { mode } : {});
      } catch (e2) {
        if ((e2 as NodeJS.ErrnoException).code !== 'EEXIST') throw e2;
      }
      info = await fs.lstat(dir);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new UnsafePathError(`${dir} is not a plain folder`);
  }
  return dir;
}

/** True when `p` is `root` or inside it, after both are made real. */
export async function realInside(p: string, root: string): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([fs.realpath(p), fs.realpath(root)]);
    return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
  } catch {
    return false;
  }
}

/**
 * Writes `name` in `dir` without ever replacing an existing file: a temp file created exclusively, flushed, then
 * hard-linked into place (link fails if the target exists) and unlinked. Where the file system can't link (FAT,
 * exFAT, some SMB and FUSE mounts), an existence check plus rename. Returns false when the target exists.
 */
export async function writeNoReplace(dir: string, name: string, text: string, mode = 0o644): Promise<boolean> {
  const target = join(dir, name);
  const tmp = join(dir, `${name}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  const h = await fs.open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, mode);
  try {
    await h.writeFile(text, 'utf8');
    await h.sync().catch(() => undefined);
  } finally {
    await h.close();
  }
  try {
    try {
      await retrying(() => fs.link(tmp, target));
      return true;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') return false;
      if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EXDEV' && code !== 'ENOSYS' && code !== 'EOPNOTSUPP') throw e;
      // No hard links here: check, then rename (collisions of fresh ULIDs are only theoretical).
      if (await exists(target)) return false;
      await retrying(() => fs.rename(tmp, target));
      return true;
    }
  } finally {
    await fs.unlink(tmp).catch(() => undefined);
  }
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** Reads a small regular file without following a symlink at its last segment. Undefined when missing, a link, or too big. */
export async function readSmall(p: string, maxBytes: number): Promise<string | undefined> {
  let h;
  try {
    // Non-blocking: a FIFO planted in the repository can't stall the reader.
    h = await fs.open(p, constants.O_RDONLY | NOFOLLOW | (constants.O_NONBLOCK ?? 0));
  } catch {
    return undefined;
  }
  try {
    const info = await h.stat();
    if (!info.isFile() || info.size > maxBytes) return undefined;
    return await h.readFile('utf8');
  } catch {
    return undefined;
  } finally {
    await h.close();
  }
}

/** Replaces a small file atomically (temp then rename), never through a symlink. For records that are rewritten. */
export async function writeReplace(dir: string, name: string, text: string, mode = 0o600): Promise<void> {
  const target = join(dir, name);
  try {
    if ((await fs.lstat(target)).isSymbolicLink()) throw new UnsafePathError(`${target} is a link`);
  } catch (e) {
    if (e instanceof UnsafePathError) throw e;
  }
  const tmp = join(dir, `.${name}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  const h = await fs.open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, mode);
  try {
    await h.writeFile(text, 'utf8');
  } finally {
    await h.close();
  }
  try {
    await retrying(() => fs.rename(tmp, target));
  } catch (e) {
    await fs.unlink(tmp).catch(() => undefined);
    throw e;
  }
}

/** Directory entries, or [] when the folder is missing or not a plain folder. */
export async function listDir(dir: string): Promise<string[]> {
  try {
    const info = await fs.lstat(dir);
    if (info.isSymbolicLink() || !info.isDirectory()) return [];
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

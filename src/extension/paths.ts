// File-system checks that don't need the VS Code API, so they can be unit tested.
import { randomBytes } from 'node:crypto';
import { lstat, open, realpath, rename, stat } from 'node:fs/promises';
import { sep } from 'node:path';

/**
 * The real path of `file` (symlinks followed) if it lies inside `root`, otherwise null.
 * Reading through the returned path avoids a symlink being swapped between check and read.
 */
export async function realPathInside(file: string, root: string): Promise<string | null> {
  try {
    const [f, r] = await Promise.all([realpath(file), realpath(root)]);
    const prefix = r.endsWith(sep) ? r : r + sep;
    return f.startsWith(prefix) ? f : null;
  } catch {
    return null;
  }
}

export class TooLargeError extends Error {}

/** Throws TooLargeError when the file is bigger than `maxBytes`, and an error when it isn't a regular file (a FIFO would block). */
export async function assertSize(file: string, maxBytes: number): Promise<void> {
  const s = await stat(file);
  if (!s.isFile()) throw new Error(`${file} is not a regular file`);
  if (s.size > maxBytes) throw new TooLargeError(`${file} is larger than ${Math.round(maxBytes / 1e6)} MB`);
}

/**
 * Replaces a file's contents atomically, without following links: the file must not be a link, and the
 * temporary file gets a fresh, unguessable name created exclusively ('wx' fails on anything already
 * there, links included), so a link planted next to it can't redirect the write.
 */
export async function writeFileAtomic(file: string, text: string): Promise<void> {
  const info = await lstat(file);
  if (info.isSymbolicLink()) throw new Error(`${file} is a link`);
  const tmp = `${file}.${randomBytes(16).toString('hex')}.tmp`;
  const handle = await open(tmp, 'wx', info.mode);
  try {
    await handle.writeFile(text, 'utf8');
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
}

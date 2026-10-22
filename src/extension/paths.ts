// File-system checks that don't need the VS Code API, so they can be unit tested.
import { realpath, stat } from 'node:fs/promises';
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

/** Throws TooLargeError when the file is bigger than `maxBytes`. */
export async function assertSize(file: string, maxBytes: number): Promise<void> {
  const s = await stat(file);
  if (s.size > maxBytes) throw new TooLargeError(`${file} is larger than ${Math.round(maxBytes / 1e6)} MB`);
}

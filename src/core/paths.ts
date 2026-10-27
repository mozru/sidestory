// Repo path and anchor id grammar shared by the manifest, comment threads and the panel.
// Kept free of zod: the panel's bundle imports this, and any top-level zod schema would pull all of zod in.

/** The longest repo-relative path a manifest, thread or link may name. */
export const MAX_PATH_CHARS = 1024;

/** An anchor id: a letter, then letters, digits, - and _ (64 characters at most). */
export const ANCHOR_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** Windows device names, which no path segment may be (with or without an extension). */
export const RESERVED_SEGMENT = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** True for a canonical repo-relative POSIX path that can't escape the repo on any OS. */
export function isSafeRelativePath(p: string): boolean {
  if (p.length === 0 || p.length > MAX_PATH_CHARS) return false;
  // Backslashes, drive letters, URLs, control characters, and glob syntax (paths become file watcher patterns).
  if (/[\\:\x00-\x1f\x7f*?[\]{}]/.test(p)) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..' && !/[. ]$/.test(seg) && !RESERVED_SEGMENT.test(seg) && seg.toLowerCase() !== '.git');
}

// Which repo-relative paths from git (diff listings, the git API, sidestory-git: URIs) Sidestory reads, opens or
// shows (docs/CHANGES-PLAN.md §4.5). Pure, one module for the extension and the checker, with two rules:
//
// - `isSafeRepoPath`: a path git gave us that Sidestory may name, list and read **by object id or inside a tree**
//   (blob reads through `cat-file`, the git extension's `buffer`, sidestory-git: URIs). Nothing on disk is touched,
//   so only what could confuse git or a reader matters.
// - `isSafeFsPath`: stricter, for **file system reads** (working tree files): also no Windows device names, no
//   segment ending in a dot or a space (Windows drops those, so `docs/a.` would read `docs/a`), and no `:` anywhere
//   (an NTFS alternate data stream, `a.ts:hidden`, or a drive-relative path). The same on every OS, so the checker
//   on Linux CI and the extension on Windows agree.
//
// `pathProblem` says which rule a path breaks, for messages.
import { RESERVED_SEGMENT } from './manifest.ts';

/** Why a path is refused (a short phrase for messages), or undefined when it passes. `fs`: the file system rule. */
export function pathProblem(p: string, fs = false): string | undefined {
  if (!p) return 'an empty path';
  if (p.length > 4096) return 'over 4,096 characters';
  if (/[\x00-\x1f\x7f]/.test(p)) return 'a control character';
  if (p.includes('\\')) return 'a backslash';
  if (p.startsWith(':')) return 'a leading ":" (git pathspec magic)';
  const segs = p.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) return 'an empty, "." or ".." segment';
  if (segs.some((s) => s.toLowerCase() === '.git')) return 'a ".git" segment';
  if (!fs) return undefined;
  if (p.includes(':')) return 'a ":" (an NTFS alternate data stream on Windows)';
  if (segs.some((s) => RESERVED_SEGMENT.test(s))) return 'a Windows device name (con, nul.txt, com1…)';
  if (segs.some((s) => /[. ]$/.test(s))) return 'a segment ending in a dot or a space (Windows drops them)';
  return undefined;
}

/**
 * A path git gave us that is safe to name and to read by object id or inside a tree: no control characters,
 * backslashes, `..`, `.` or empty segments, `.git` segments, or a leading `:` (git reads `:(literal)x` and `:/x` as
 * pathspec magic). At most 4,096 characters. Windows-only names (`con`, `a.`) pass: they are ordinary blobs.
 */
export function isSafeRepoPath(p: string): boolean {
  return pathProblem(p) === undefined;
}

/**
 * A path that is also safe to open on the file system on every OS: `isSafeRepoPath`, and no Windows device names
 * (`con`, `nul.txt`), no segment ending in a dot or a space, and no `:` anywhere (NTFS alternate data streams).
 */
export function isSafeFsPath(p: string): boolean {
  return pathProblem(p, true) === undefined;
}

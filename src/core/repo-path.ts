// Which repo-relative paths from git (diff listings, the git API, sidestory-git: URIs) Sidestory reads, opens or
// shows (docs/CHANGES-PLAN.md §4.5). Pure, one rule for the extension and the checker.
import { RESERVED_SEGMENT } from './manifest.ts';

/**
 * A path git gave us that is safe to read on every OS: no control characters, backslashes, `..`, `.` or empty
 * segments, `.git` segments, or a leading `:` (git reads `:(literal)x` and `:/x` as pathspec magic); and, as
 * `isSafeRelativePath`, no Windows device names (`con`, `nul.txt`) or segments ending in a dot or a space (Windows
 * drops those, so `docs/a.` would read `docs/a`). At most 4,096 characters.
 */
export function isSafeRepoPath(p: string): boolean {
  if (!p || p.length > 4096 || p.startsWith(':') || /[\x00-\x1f\x7f\\]/.test(p)) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..' && s.toLowerCase() !== '.git' && !/[. ]$/.test(s) && !RESERVED_SEGMENT.test(s));
}

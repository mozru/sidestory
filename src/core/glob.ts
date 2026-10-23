// Exclusion globs for discovery (docs/NAVIGATION-PLAN.md §6.3): the built-in list merged with the user's
// `files.exclude`, as one glob for `findFiles`, and as a matcher for paths the startup watcher reports.

/** Folders never searched for sidestories. */
export const DEFAULT_EXCLUDES = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/out/**', '**/build/**', '**/target/**'];

/**
 * The exclusion patterns: the defaults plus every `files.exclude` entry set to `true`. Entries set to `false`
 * or with a `when` clause can't be expressed in one glob and are dropped.
 */
export function excludePatterns(filesExclude: unknown): string[] {
  const out = [...DEFAULT_EXCLUDES];
  if (filesExclude && typeof filesExclude === 'object' && !Array.isArray(filesExclude)) {
    for (const [pattern, on] of Object.entries(filesExclude as Record<string, unknown>)) {
      if (on !== true || !pattern || pattern.length > 1000) continue;
      // `files.exclude` patterns match a folder and, implicitly, everything in it.
      const p = pattern.replace(/\/+$/, '');
      if (!out.includes(p)) out.push(p);
      if (!p.endsWith('/**') && !out.includes(`${p}/**`)) out.push(`${p}/**`);
    }
  }
  return out;
}

/**
 * One glob for `findFiles`: `{a,b,c}`. A pattern that contains braces itself is expanded into its alternatives
 * first, so no brace group is ever nested inside another (VS Code's glob doesn't nest them).
 */
export function joinGlobs(patterns: readonly string[]): string {
  const flat = patterns.flatMap(expandBraces);
  return flat.length === 1 ? flat[0]! : `{${flat.join(',')}}`;
}

/** `a/{b,c}/d` → `a/b/d`, `a/c/d` (nested groups too), at most 64 results per pattern. */
export function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf('{');
  if (open < 0) return [pattern];
  let depth = 0;
  let close = -1;
  const commas: number[] = [];
  for (let i = open; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    } else if (c === ',' && depth === 1) commas.push(i);
  }
  if (close < 0) return [pattern.replace(/[{}]/g, '')];
  const head = pattern.slice(0, open);
  const tail = pattern.slice(close + 1);
  const bounds = [open, ...commas, close];
  const out: string[] = [];
  for (let k = 0; k + 1 < bounds.length && out.length < 64; k++) {
    for (const t of expandBraces(head + pattern.slice(bounds[k]! + 1, bounds[k + 1]) + tail)) {
      if (out.length < 64) out.push(t);
    }
  }
  return out;
}

/** A matcher for workspace-relative POSIX paths: `**`, `*`, `?`, `[…]` and `{a,b}`. */
export function globMatcher(patterns: readonly string[]): (relPath: string) => boolean {
  const res = patterns.flatMap(expandBraces).map(globToRegExp);
  return (p) => res.some((r) => r.test(p));
}

export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` matches any number of folders (none included); a trailing `**` matches the rest.
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end < 0) re += '\\[';
      else {
        const body = glob.slice(i + 1, end).replace(/\\/g, '\\\\').replace(/^!/, '^');
        re += `[${body}]`;
        i = end;
      }
    } else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

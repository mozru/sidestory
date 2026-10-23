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


/** Longest path a matcher looks at; longer ones never match (a hostile name can't buy unbounded work). */
const MAX_PATH = 4096;
const MAX_PATTERN = 1000;

type Tok = { k: 'lit'; c: string } | { k: 'any' } | { k: 'star' } | { k: 'class'; neg: boolean; items: [string, string][] };
type Seg = { globstar: true } | { globstar: false; toks: Tok[] };

/**
 * A matcher for workspace-relative POSIX paths: `**`, `*`, `?`, `[…]` and `{a,b}`. No regular expressions: the
 * patterns come from settings a repository can set, so matching must not backtrack. Segments are matched with a
 * dynamic program over (pattern segment, path segment) for `**`, and each segment with the two-pointer wildcard
 * algorithm, so the work is O(pattern × path) whatever the input. A malformed pattern never throws.
 */
export function globMatcher(patterns: readonly string[]): (relPath: string) => boolean {
  const compiled = patterns
    .filter((p) => p.length <= MAX_PATTERN)
    .flatMap(expandBraces)
    .map(compile);
  return (p) => p.length <= MAX_PATH && compiled.some((c) => matchSegments(c, p.split('/')));
}

function compile(glob: string): Seg[] {
  return glob.split('/').map((seg): Seg => (seg === '**' ? { globstar: true } : { globstar: false, toks: tokens(seg) }));
}

function tokens(seg: string): Tok[] {
  const out: Tok[] = [];
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]!;
    if (c === '*') {
      if (out.at(-1)?.k !== 'star') out.push({ k: 'star' }); // `**` inside a segment is just `*`
    } else if (c === '?') out.push({ k: 'any' });
    else if (c === '[') {
      const end = seg.indexOf(']', i + 2);
      if (end < 0) {
        out.push({ k: 'lit', c });
        continue;
      }
      let body = seg.slice(i + 1, end);
      const neg = body[0] === '!' || body[0] === '^';
      if (neg) body = body.slice(1);
      const items: [string, string][] = [];
      for (let j = 0; j < body.length; j++) {
        if (body[j + 1] === '-' && j + 2 < body.length) {
          items.push([body[j]!, body[j + 2]!]); // a reversed range (z-a) simply matches nothing
          j += 2;
        } else items.push([body[j]!, body[j]!]);
      }
      out.push({ k: 'class', neg, items });
      i = end;
    } else out.push({ k: 'lit', c });
  }
  return out;
}

function one(t: Tok, c: string): boolean {
  switch (t.k) {
    case 'lit':
      return t.c === c;
    case 'any':
      return true;
    case 'class': {
      const hit = t.items.some(([a, b]) => c >= a && c <= b);
      return t.neg ? !hit : hit;
    }
    default:
      return false;
  }
}

/** The two-pointer wildcard match: each `*` remembers one restart point, so no exponential backtracking. */
function matchSegment(toks: Tok[], s: string): boolean {
  let t = 0;
  let i = 0;
  let starT = -1;
  let starI = 0;
  while (i < s.length) {
    const tok = toks[t];
    if (tok && tok.k !== 'star' && one(tok, s[i]!)) {
      t++;
      i++;
    } else if (tok && tok.k === 'star') {
      starT = t++;
      starI = i;
    } else if (starT >= 0) {
      t = starT + 1;
      i = ++starI;
    } else return false;
  }
  while (toks[t]?.k === 'star') t++;
  return t === toks.length;
}

/** `**` matches zero or more whole segments: a table over (pattern segment, path segment), filled once. */
function matchSegments(pat: Seg[], path: string[]): boolean {
  const m = pat.length;
  const n = path.length;
  // can[j]: the pattern so far matches the first j path segments.
  let can = new Uint8Array(n + 1);
  can[0] = 1;
  for (let i = 0; i < m; i++) {
    const seg = pat[i]!;
    const next = new Uint8Array(n + 1);
    if (seg.globstar) {
      let reach = 0;
      for (let j = 0; j <= n; j++) {
        if (can[j]) reach = 1;
        next[j] = reach;
      }
    } else {
      for (let j = 0; j < n; j++) if (can[j] && matchSegment(seg.toks, path[j]!)) next[j + 1] = 1;
    }
    can = next;
  }
  return can[n] === 1;
}

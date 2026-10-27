// Code links without a manifest anchor: `data-explain-code="rtl/dma_fifo.sv#driver(count_q)"` (docs/AUTHORING-PLAN.md
// §8.1). The panel resolves `data-explain-code-file` inheritance and checks the syntax; the extension checks it again,
// resolves real paths and finds the target. Shared by the panel, the protocol schemas and (later) the checker.
import { isSafeRelativePath } from '../core/paths.ts';

/** Line numbers above this are refused (a typo, or a page trying to make the host scan a huge range). */
export const MAX_CODE_LINE = 10_000_000;
/** A symbol path's length limit, as for manifest `symbol` (§4.1). */
export const MAX_CODE_SYMBOL = 200;
/** The most distinct code links a page reports in `codeTargets`; the rest light nothing from the cursor. */
export const MAX_CODE_LINKS = 500;

export type CodeTarget = { kind: 'lines'; start: number; end: number } | { kind: 'symbol'; path: string };

export interface CodeLink {
  /** Relative to the folder that holds `.sidestory/`, like a manifest `file`. */
  path: string;
  /** What follows `#`, as written; absent when the link opens the file at the top. */
  target?: string;
}

const LINES = /^L(\d{1,8})(?:-L(\d{1,8}))?$/;
/** Format characters (bidi controls, zero-width), line and paragraph separators, and whitespace other than a space. */
const UNSEEN = /[\p{Cf}\p{Zl}\p{Zp}]|(?! )\s/u;
/**
 * Symbol paths (§4.2): names joined with `.` or `::`, with `driver(x)`, `.case(LABEL)`, `u_ctrl(.port)` and slice
 * keys such as `driver(x[7:4])`. This is only a cheap shape check (printable, starts like a name, brackets
 * balanced); the scanner that resolves the path is the authority on what it means.
 */
const SYMBOL_CHARS = /^[A-Za-z_\\][\x20-\x7e]*$/;

/** Parses what follows `#`; null when it isn't a line range or a plausible symbol path. */
export function parseCodeTarget(t: string): CodeTarget | null {
  const lines = LINES.exec(t);
  if (lines) {
    const start = Number(lines[1]);
    const end = lines[2] === undefined ? start : Number(lines[2]);
    if (start < 1 || end < start || end > MAX_CODE_LINE) return null;
    return { kind: 'lines', start, end };
  }
  // A mistyped line range (`L10-20`, `L5:9`) is an error here, not a symbol that's never found.
  if (/^L\d+([-:]|$)/.test(t)) return null;
  if (t.length === 0 || t.length > MAX_CODE_SYMBOL || !SYMBOL_CHARS.test(t) || t.includes('#')) return null;
  // Whitespace only inside brackets (`.case({a, b})`), never around the path itself.
  if (t !== t.trim()) return null;
  const open: string[] = [];
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  for (const c of t) {
    if (c === '(' || c === '[' || c === '{') open.push(c);
    else if (c in pairs && open.pop() !== pairs[c]) return null;
    else if (c === ' ' && open.length === 0 && !t.startsWith('\\')) return null;
  }
  return open.length === 0 ? { kind: 'symbol', path: t } : null;
}

/**
 * Splits a `data-explain-code` value at its first `#`. An empty path takes `inheritedFile` (the nearest
 * `data-explain-code-file`). Returns null for anything invalid: a bad path, a bad target, or no file at all.
 */
export function parseCodeLink(value: string, inheritedFile?: string): CodeLink | null {
  const v = value.trim();
  if (v.length > 2048) return null;
  const hash = v.indexOf('#');
  const rawPath = hash < 0 ? v : v.slice(0, hash);
  const target = hash < 0 ? undefined : v.slice(hash + 1);
  const path = rawPath === '' ? inheritedFile?.trim() ?? '' : rawPath;
  // No `#` (it would end the path when the link is read back), and no invisible or direction-changing characters, so
  // the name a confirmation shows is the name opened.
  if (!isSafeRelativePath(path) || path.includes('#') || UNSEEN.test(path)) return null;
  if (target === undefined || target === '') return { path };
  return parseCodeTarget(target) ? { path, target } : null;
}

/** The canonical text of a link, as `codeTargets` and `here` carry it: `path` or `path#target`. */
export function formatCodeLink(l: CodeLink): string {
  return l.target === undefined ? l.path : `${l.path}#${l.target}`;
}

/** True for a canonical link string (no inheritance: the path must be there). */
export function isCodeLink(s: string): boolean {
  const l = parseCodeLink(s);
  return l !== null && formatCodeLink(l) === s;
}

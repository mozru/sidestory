// What a widget may read with `useAnchorCode` (docs/WIDGETS-PLAN.md §5.2). Served only when the author
// demonstrably knew the text: decided by how the anchor matched, not by its state. Pure, so every rule is
// unit tested; the extension gathers the inputs (git state through the vscode.git API, confirmations).
import type { Anchor } from '../../core/manifest.ts';
import type { Resolution } from '../../core/resolve.ts';
import { normalizeLines, splitLines } from '../../core/text.ts';
import type { WidgetCode } from '../../shared/widget-protocol.ts';
import { isSecretFileName, isSecretPath } from './secret-files.ts';

export const MAX_CODE_LINES = 2000;

/** What git says about the anchored file; `none`: no repository at all; `unknown`: a `.git` the git extension doesn't know. */
export type GitFacts =
  | { kind: 'none' }
  | { kind: 'unknown' }
  | {
      kind: 'repo';
      tracked: boolean;
      ignored: boolean;
      /** The file's text at HEAD (null when it isn't in HEAD). */
      headText: string | null;
    };

export interface CodeAccessInput {
  anchor: Anchor;
  resolution: Resolution | undefined;
  /** The file's current lines (unsaved edits included). */
  lines: readonly string[] | undefined;
  /** The name of the file's real path (symlinks followed). */
  realName: string | undefined;
  /** The quote is identical in the manifest committed at HEAD. */
  quoteAtHead: boolean;
  /** Pin wrote this quote in this workspace after the reader confirmed, or the reader confirmed it since. */
  confirmed: boolean;
  git: GitFacts;
  language: string;
}

const unavailable = (anchor: string, reason: NonNullable<WidgetCode['reason']>): WidgetCode => ({ anchor, status: 'unavailable', reason });

/** True when the anchor's quote was matched in full against the current text (not approximately). */
export function matchedInFull(r: Resolution): boolean {
  return r.method === 'exact' || r.method === 'hint' || (r.method === 'fuzzy' && r.similarity === 1);
}

/** Whether the quote's lines appear, exactly (whitespace-normalized), in a text. */
export function quoteIn(text: string, quote: string): boolean {
  const q = normalizeLines(splitLines(quote)).filter((l, i, all) => l !== '' || (i > 0 && i < all.length - 1));
  if (q.length === 0) return false;
  const n = normalizeLines(splitLines(text));
  for (let i = 0; i + q.length <= n.length; i++) {
    let ok = true;
    for (let j = 0; j < q.length && ok; j++) ok = n[i + j] === q[j];
    if (ok) return true;
  }
  return false;
}

export function decideCodeAccess(i: CodeAccessInput): WidgetCode {
  const { anchor: a, resolution: r } = i;
  // Never secret-looking files, by the anchor's path or by the real file's name.
  if (isSecretPath(a.file) || (i.realName !== undefined && isSecretFileName(i.realName))) return unavailable(a.id, 'secret-file');
  // The quote must be author knowledge: a v2 quote, whitespace-normalized only.
  if (!a.quote || a.quote.norm !== 'ws') return unavailable(a.id, 'not-pinned');
  if (!i.quoteAtHead && !i.confirmed) return unavailable(a.id, 'unconfirmed');
  if (!r?.range || r.state === 'lost' || !i.lines) return unavailable(a.id, 'lost');
  if (r.range.end - r.range.start + 1 > MAX_CODE_LINES) return unavailable(a.id, 'too-large');
  const g = i.git;
  if (matchedInFull(r) && (r.state === 'exact' || r.state === 'moved')) {
    // Current text, matched in full: in tracked files, or untracked ones git doesn't ignore.
    if (g.kind === 'unknown') return unavailable(a.id, 'ignored');
    if (g.kind === 'repo' && !g.tracked && g.ignored) return unavailable(a.id, 'ignored');
  } else {
    // Matched approximately: only in tracked files, and only when the quote is exactly the HEAD text.
    if (g.kind !== 'repo' || !g.tracked) return unavailable(a.id, 'changed-untracked');
    if (g.headText === null || !quoteIn(g.headText, a.quote.exact)) return unavailable(a.id, 'changed-since-commit');
  }
  return {
    anchor: a.id,
    status: 'ok',
    text: i.lines.slice(r.range.start - 1, r.range.end).join('\n'),
    startLine: r.range.start,
    language: i.language,
    state: r.state,
  };
}

const LANGUAGES: Record<string, string> = {
  ts: 'typescript', tsx: 'typescriptreact', js: 'javascript', jsx: 'javascriptreact', mjs: 'javascript', cjs: 'javascript',
  py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp',
  cs: 'csharp', rb: 'ruby', php: 'php', swift: 'swift', sv: 'systemverilog', svh: 'systemverilog', v: 'verilog',
  vhd: 'vhdl', vhdl: 'vhdl', sh: 'shellscript', json: 'json', yaml: 'yaml', yml: 'yaml', sql: 'sql', md: 'markdown',
};

/** A language id from a file name, for widgets that color code. */
export function languageOf(file: string): string {
  return LANGUAGES[file.split('.').pop()?.toLowerCase() ?? ''] ?? 'plaintext';
}

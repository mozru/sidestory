// Code block languages for syntax highlighting (docs/HIGHLIGHT-PLAN.md): the grammars we ship, the class
// names that pick them, and the limits shared by the panel and the extension host.

/** Grammars shipped in dist/highlight/grammars (Shiki names). Requests may name only these. */
export const HIGHLIGHT_LANGS = [
  'typescript', 'tsx', 'javascript', 'python', 'c', 'cpp', 'rust', 'go', 'java', 'csharp', 'system-verilog', 'verilog', 'vhdl',
  'json', 'jsonc', 'yaml', 'toml', 'shellscript', 'sql', 'html', 'css', 'markdown', 'diff',
] as const;
export type HighlightLang = (typeof HIGHLIGHT_LANGS)[number];

/** Grammars shipped only because the ones above embed them (never requested directly). */
export const EMBEDDED_GRAMMARS = ['cpp-macro', 'regexp', 'glsl', 'html-derivative'] as const;

/** `language-x` / `lang-x` names (lower case) → grammar. A Map, so `__proto__` or `constructor` find nothing. */
export const LANG_ALIASES: ReadonlyMap<string, HighlightLang> = new Map<string, HighlightLang>([
  ...(['ts', 'typescript', 'mts', 'cts'] as const).map((a) => [a, 'typescript'] as const),
  ['tsx', 'tsx'],
  // VS Code's JavaScript grammar covers JSX.
  ...(['js', 'javascript', 'mjs', 'cjs', 'jsx', 'node'] as const).map((a) => [a, 'javascript'] as const),
  ...(['py', 'python', 'python3', 'py3'] as const).map((a) => [a, 'python'] as const),
  ['c', 'c'], ['h', 'c'],
  ...(['cpp', 'c++', 'cc', 'cxx', 'hpp', 'hh', 'hxx'] as const).map((a) => [a, 'cpp'] as const),
  ['rs', 'rust'], ['rust', 'rust'],
  ['go', 'go'], ['golang', 'go'],
  ['java', 'java'],
  ...(['cs', 'csharp', 'c#'] as const).map((a) => [a, 'csharp'] as const),
  ...(['sv', 'systemverilog', 'system-verilog', 'svh'] as const).map((a) => [a, 'system-verilog'] as const),
  ['v', 'verilog'], ['verilog', 'verilog'],
  ['vhdl', 'vhdl'], ['vhd', 'vhdl'],
  ['json', 'json'],
  ['jsonc', 'jsonc'], ['json5', 'jsonc'],
  ['yaml', 'yaml'], ['yml', 'yaml'],
  ['toml', 'toml'],
  ...(['sh', 'bash', 'shell', 'shellscript', 'zsh', 'console', 'shell-session'] as const).map((a) => [a, 'shellscript'] as const),
  ['sql', 'sql'],
  ...(['html', 'htm', 'xhtml'] as const).map((a) => [a, 'html'] as const),
  ['css', 'css'],
  ['md', 'markdown'], ['markdown', 'markdown'],
  ['diff', 'diff'], ['patch', 'diff'],
]);

/** The grammar for a language name (`ts`, `Python`, `c++`), or undefined: unknown languages stay plain. */
export function grammarFor(name: string): HighlightLang | undefined {
  return LANG_ALIASES.get(name.trim().toLowerCase());
}

/** The language a class attribute names (`language-x` or `lang-x`; the first known one wins). */
export function langFromClass(className: string | null | undefined): HighlightLang | undefined {
  if (!className) return undefined;
  for (const c of className.split(/\s+/)) {
    const m = /^(?:language|lang)-(.+)$/i.exec(c);
    const lang = m ? grammarFor(m[1]!) : undefined;
    if (lang) return lang;
  }
  return undefined;
}

/** Blocks over these stay plain. Lengths are in UTF-16 code units. */
export const MAX_BLOCK_CHARS = 100_000;
export const MAX_BLOCK_LINES = 2_000;
/** A longer line is left plain as a whole. */
export const MAX_LINE_CHARS = 2_000;
/** Per `highlight` message. */
export const MAX_REQUEST_BLOCKS = 200;
export const MAX_REQUEST_CHARS = 1_000_000;

/** One palette entry: a color (hex) and font style bits. Index 0 of every palette means "no style". */
export interface HighlightStyle {
  color?: string;
  /** Bits: 1 italic, 2 bold, 4 underline, 8 strikethrough (Shiki's FontStyle). */
  font?: number;
}

export const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

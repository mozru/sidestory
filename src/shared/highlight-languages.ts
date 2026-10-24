// Code block languages for syntax highlighting (docs/HIGHLIGHT-PLAN.md §10): the language names blocks give,
// and the limits shared by the panel and the extension host.

/**
 * A language name as a code block gives it (`language-ts`, `lang-python`), lower case. The extension host maps it
 * to a grammar from the installed extensions (src/extension/highlight/catalog.ts); unknown names stay plain.
 */
export const LANG_NAME = /^[a-z0-9][a-z0-9_+#.-]{0,63}$/;

/** A language name, normalized (trimmed, lower case), or undefined if it can't be one. */
export function langName(name: string): string | undefined {
  const n = name.trim().toLowerCase();
  return LANG_NAME.test(n) ? n : undefined;
}

/** The language a class attribute names (the first `language-x` or `lang-x` that can be a name). */
export function langFromClass(className: string | null | undefined): string | undefined {
  if (!className) return undefined;
  for (const c of className.split(/\s+/)) {
    const m = /^(?:language|lang)-(.+)$/i.exec(c);
    const lang = m ? langName(m[1]!) : undefined;
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

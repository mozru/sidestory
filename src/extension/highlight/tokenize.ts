// Shiki, as the highlight worker uses it (docs/HIGHLIGHT-PLAN.md §2): grammars loaded on first use from
// dist/highlight/grammars, themes given by the host, and results as run lengths plus a palette. No DOM, no HTML.
import { createHighlighterCoreSync, type HighlighterCore, type LanguageRegistration, type ThemeRegistrationRaw } from '@shikijs/core';
import { createJavaScriptRegexEngine } from '@shikijs/engine-javascript';
import { countLines } from './grammars.ts';
import { HEX_COLOR, type HighlightLang, type HighlightStyle, MAX_BLOCK_CHARS, MAX_BLOCK_LINES, MAX_LINE_CHARS } from '../../shared/highlight-languages.ts';
import type { HighlightTheme } from './theme.ts';

/** Reads a shipped grammar by its Shiki name (a fixed list, never a name from content); undefined if missing. */
export type GrammarReader = (name: string) => LanguageRegistration | undefined;

export interface Tokenized {
  /** [length, style, length, style, …] covering the whole text; style 0 is unstyled. */
  runs: number[];
}

const MAX_THEMES = 3;

export class Tokenizer {
  private readonly shiki: HighlighterCore;
  private readonly loaded = new Set<string>();
  /** Theme key → palette (style index → style), built as tokens are seen. Index 0 is "no style". */
  private readonly palettes = new Map<string, { styles: HighlightStyle[]; index: Map<string, number>; fg: string }>();
  private readonly readGrammar: GrammarReader;

  constructor(readGrammar: GrammarReader) {
    this.readGrammar = readGrammar;
    this.shiki = createHighlighterCoreSync({ engine: createJavaScriptRegexEngine({ forgiving: true }), langs: [], themes: [] });
  }

  hasTheme(key: string): boolean {
    return this.palettes.has(key);
  }

  setTheme(theme: HighlightTheme): void {
    if (this.palettes.has(theme.key)) return;
    const reg: ThemeRegistrationRaw = { name: theme.key, type: theme.type, fg: theme.fg, bg: theme.bg, colors: { 'editor.foreground': theme.fg, 'editor.background': theme.bg }, settings: theme.rules as ThemeRegistrationRaw['settings'] };
    this.shiki.loadThemeSync(reg);
    // Shiki keeps themes for good; ours are few (the active one, perhaps the previous), but cap the palettes we keep.
    if (this.palettes.size >= MAX_THEMES) this.palettes.delete(this.palettes.keys().next().value!);
    this.palettes.set(theme.key, { styles: [{}], index: new Map(), fg: theme.fg.toLowerCase() });
  }

  /** Whether every grammar the block needs is loaded (the host warms the worker before timing a block). */
  isWarm(langs: readonly string[]): boolean {
    return langs.every((l) => this.loaded.has(l));
  }

  /** Loads grammars and their embedded grammars (by fixed names), then tokenizes a line so the first block is fast. */
  load(langs: readonly string[]): void {
    for (const l of langs) this.loadOne(l, 0);
    for (const l of langs) if (this.loaded.has(l)) this.shiki.codeToTokensBase('x', { lang: l, theme: this.shiki.getLoadedThemes()[0] ?? 'none' });
  }

  private loadOne(name: string, depth: number): void {
    if (this.loaded.has(name) || depth > 4) return;
    const g = this.readGrammar(name);
    if (!g) return;
    for (const dep of g.embeddedLangs ?? []) this.loadOne(dep, depth + 1);
    this.shiki.loadLanguageSync(g);
    this.loaded.add(name);
  }

  palette(themeKey: string): HighlightStyle[] {
    return this.palettes.get(themeKey)?.styles ?? [{}];
  }

  /** Runs for one block, or null if it's over the caps or its grammar or theme isn't loaded. */
  tokenize(code: string, lang: HighlightLang, themeKey: string): Tokenized | null {
    const pal = this.palettes.get(themeKey);
    if (!pal || !this.loaded.has(lang) || code.length > MAX_BLOCK_CHARS || countLines(code) > MAX_BLOCK_LINES) return null;
    const lines = this.shiki.codeToTokensBase(code, { lang, theme: themeKey, tokenizeMaxLineLength: MAX_LINE_CHARS, tokenizeTimeLimit: 500 });
    const runs: number[] = [];
    let pos = 0;
    const push = (len: number, style: number) => {
      if (len <= 0) return;
      const n = runs.length;
      if (n && runs[n - 1] === style) runs[n - 2]! += len;
      else runs.push(len, style);
    };
    for (const line of lines) {
      for (const t of line) {
        if (t.offset > pos) push(t.offset - pos, this.whitespaceStyle(runs, pal.styles));
        if (t.offset < pos) continue; // never overlap (shouldn't happen)
        const style = /^\s+$/.test(t.content) ? this.whitespaceStyle(runs, pal.styles) : this.styleOf(pal, t.color, t.fontStyle);
        push(t.content.length, style);
        pos = t.offset + t.content.length;
      }
    }
    if (pos < code.length) push(code.length - pos, this.whitespaceStyle(runs, pal.styles));
    return { runs };
  }

  /** Whitespace looks the same in any color: give it the previous run's style (fewer spans), unless that draws lines. */
  private whitespaceStyle(runs: number[], styles: HighlightStyle[]): number {
    const prev = runs.length ? runs[runs.length - 1]! : 0;
    return (styles[prev]?.font ?? 0) & (4 | 8) ? 0 : prev;
  }

  private styleOf(pal: { styles: HighlightStyle[]; index: Map<string, number>; fg: string }, color: string | undefined, font: number | undefined): number {
    const c = color && HEX_COLOR.test(color) && color.toLowerCase() !== pal.fg ? color.toLowerCase() : undefined;
    const f = font && font > 0 ? font & 15 : 0;
    if (!c && !f) return 0;
    const k = `${c ?? ''}|${f}`;
    let i = pal.index.get(k);
    if (i === undefined) {
      i = pal.styles.length;
      pal.styles.push(c ? (f ? { color: c, font: f } : { color: c }) : { font: f });
      pal.index.set(k, i);
    }
    return i;
  }
}

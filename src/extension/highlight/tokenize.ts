// The tokenizer the highlight worker runs (docs/HIGHLIGHT-PLAN.md §10.4): vscode-textmate, as VS Code runs it,
// with grammars the host read from the installed extensions and VS Code's own Oniguruma (or a JavaScript regex
// engine when that can't be loaded). Results are run lengths plus a palette. No DOM, no HTML.
import { readFileSync, statSync } from 'node:fs';
import { createJavaScriptRegexEngine } from '@shikijs/engine-javascript';
// Both are CommonJS bundles whose exports Node can't name statically: default imports work in Node and esbuild.
import onig from 'vscode-oniguruma';
import textmate, { type IGrammar, type IOnigLib, type IRawGrammar, type StateStack } from 'vscode-textmate';
import { countLines } from './grammars.ts';
import { HEX_COLOR, type HighlightStyle, MAX_BLOCK_CHARS, MAX_BLOCK_LINES, MAX_LINE_CHARS } from '../../shared/highlight-languages.ts';
import type { GrammarSet } from './catalog.ts';
import type { HighlightTheme } from './theme.ts';

export interface Tokenized {
  /** [length, style, length, style, …] covering the whole text; style 0 is unstyled. */
  runs: number[];
}

export type EngineName = 'oniguruma' | 'javascript';

const { INITIAL, parseRawGrammar, Registry } = textmate;

const MAX_THEMES = 3;
const MAX_WASM = 8 * 1024 * 1024;
/** Per line, as VS Code's own tokenizer limits it. */
const LINE_TIME_MS = 500;

// Bits of vscode-textmate's encoded token attributes (EncodedTokenAttributes, not exported).
const FONT_STYLE_OFFSET = 11;
const FONT_STYLE_MASK = 0b1111 << FONT_STYLE_OFFSET;
const FOREGROUND_OFFSET = 15;
const FOREGROUND_MASK = 0b111111111 << FOREGROUND_OFFSET;

/**
 * The regex engine: Oniguruma from the first of `wasmFiles` if it loads and answers a smoke test (VS Code ships
 * onig.wasm; we ship only vscode-oniguruma's JS for it), else the JavaScript engine. Only the first file is tried:
 * vscode-oniguruma loads one wasm per process and answers every later call with that first attempt.
 */
export async function createOnigLib(wasmFiles: readonly string[], log?: (m: string) => void): Promise<{ lib: IOnigLib; engine: EngineName }> {
  for (const file of wasmFiles.slice(0, 1)) {
    try {
      if (statSync(file).size > MAX_WASM) {
        log?.(`onig.wasm at ${file} is over ${MAX_WASM / 1024 / 1024} MB`);
        continue;
      }
      const data = readFileSync(file);
      await onig.loadWASM({ data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer, print: () => {} });
      const lib: IOnigLib = { createOnigScanner: (p) => new onig.OnigScanner(p), createOnigString: (s) => new onig.OnigString(s) };
      // A wasm of another vscode-oniguruma version could load and still answer wrongly.
      const scanner = lib.createOnigScanner(['(?<=a)b', '\\Gx']);
      const str = lib.createOnigString('ab');
      const m = scanner.findNextMatchSync(str, 0, 0);
      scanner.dispose?.();
      str.dispose?.();
      if (m?.index === 0 && m.captureIndices[0]?.start === 1) return { lib, engine: 'oniguruma' };
      log?.(`onig.wasm at ${file} answered wrongly`);
    } catch (e) {
      log?.(`onig.wasm at ${file}: ${(e as Error).message}`);
    }
  }
  const js = createJavaScriptRegexEngine({ forgiving: true });
  const lib: IOnigLib = {
    createOnigScanner: (p) => js.createScanner(p) as unknown as ReturnType<IOnigLib['createOnigScanner']>,
    createOnigString: (s) => js.createString(s) as unknown as ReturnType<IOnigLib['createOnigString']>,
  };
  return { lib, engine: 'javascript' };
}

interface Palette {
  styles: HighlightStyle[];
  index: Map<string, number>;
  fg: string;
  theme: HighlightTheme;
}

export class Tokenizer {
  private readonly registry: InstanceType<typeof Registry>;
  /** Grammar texts the host sent, by scope; parsed when vscode-textmate asks for them. */
  private readonly files = new Map<string, GrammarSet['files'][number]>();
  /** Scopes vscode-textmate has asked for (it keeps the answer, a grammar or none, for good), and those it got none for. */
  private readonly asked = new Set<string>();
  private readonly missing = new Set<string>();
  private readonly injections = new Map<string, string[]>();
  private readonly loaded = new Map<string, IGrammar>();
  /** Theme key → palette (style index → style), built as tokens are seen. Index 0 is "no style". */
  private readonly palettes = new Map<string, Palette>();
  private currentTheme: string | undefined;

  constructor(lib: Promise<IOnigLib> | IOnigLib) {
    this.registry = new Registry({
      onigLib: Promise.resolve(lib),
      loadGrammar: async (scope) => this.parse(scope),
      getInjections: (scope) => this.injections.get(scope),
    });
  }

  private parse(scope: string): IRawGrammar | null {
    this.asked.add(scope);
    const f = this.files.get(scope);
    if (!f) {
      this.missing.add(scope);
      return null;
    }
    try {
      // The file name only picks the parser (vscode-textmate: .json is JSON, anything else plist).
      return parseRawGrammar(f.text, f.format === 'json' ? `${scope}.json` : `${scope}.tmLanguage`);
    } catch {
      return null; // broken for good (not "missing"): a new worker wouldn't do better
    } finally {
      // Parsed once: the registry keeps the grammar.
      this.files.delete(scope);
    }
  }

  hasTheme(key: string): boolean {
    return this.palettes.has(key);
  }

  setTheme(theme: HighlightTheme): void {
    if (this.palettes.has(theme.key)) return;
    // Ours are few (the active one, perhaps the previous): cap the palettes we keep.
    if (this.palettes.size >= MAX_THEMES) this.palettes.delete(this.palettes.keys().next().value!);
    this.palettes.set(theme.key, { styles: [{}], index: new Map(), fg: theme.fg.toLowerCase(), theme });
  }

  private useTheme(key: string): Palette | undefined {
    const pal = this.palettes.get(key);
    if (pal && this.currentTheme !== key) {
      const t = pal.theme;
      this.registry.setTheme({ name: t.key, settings: [{ settings: { foreground: t.fg, background: t.bg } }, ...t.rules] });
      this.currentTheme = key;
    }
    return pal;
  }

  /** Which of `scopes` vscode-textmate asked for and got text for (loaded, or broken for good): what the host needn't send again. */
  parsed(scopes: readonly string[]): string[] {
    return scopes.filter((s) => this.asked.has(s) && !this.missing.has(s));
  }

  /** Whether a scope's grammar is loaded (the host warms the worker before timing a block). */
  isWarm(scope: string): boolean {
    return this.loaded.has(scope);
  }

  /**
   * Loads a scope's grammar from the files the host read, then tokenizes a line so the first block is fast.
   * 'stale': vscode-textmate already answered "no grammar" for this scope (it was left out of an earlier set by
   * the caps); only a new worker can load it.
   */
  async load(scope: string, set: GrammarSet): Promise<boolean | 'stale'> {
    if (this.loaded.has(scope)) return true;
    // A scope this worker knows as missing (left out of an earlier set by the caps) can't load here.
    if (this.missing.has(scope) || set.files.some((f) => this.missing.has(f.scopeName))) return 'stale';
    // Scopes already asked for are parsed (or known missing) for good: their text isn't kept again.
    for (const f of set.files) if (!this.asked.has(f.scopeName)) this.files.set(f.scopeName, f);
    for (const [s, inj] of set.injections) this.injections.set(s, inj);
    // A grammar that's missing or doesn't parse is reported by throwing.
    const g = await this.registry.loadGrammar(scope).catch(() => null);
    // Texts the grammar didn't need (an include of another file's single rule leaves that file's other includes
    // unasked, an injection target never loaded) aren't kept either: `parsed` tells the host what this worker has.
    this.files.clear();
    // Its own text wasn't sent (the host thought this worker had it): a new worker gets everything.
    if (!g) return this.missing.has(scope) ? 'stale' : false;
    this.loaded.set(scope, g);
    g.tokenizeLine2('x', INITIAL, LINE_TIME_MS);
    return true;
  }

  palette(themeKey: string): HighlightStyle[] {
    return this.palettes.get(themeKey)?.styles ?? [{}];
  }

  /** Runs for one block, or null if it's over the caps or its grammar or theme isn't loaded. */
  tokenize(code: string, scope: string, themeKey: string): Tokenized | null {
    const g = this.loaded.get(scope);
    if (!g || !this.palettes.has(themeKey) || code.length > MAX_BLOCK_CHARS || countLines(code) > MAX_BLOCK_LINES) return null;
    const pal = this.useTheme(themeKey)!;
    const colors = this.registry.getColorMap();
    const runs: number[] = [];
    const push = (len: number, style: number) => {
      if (len <= 0) return;
      const n = runs.length;
      if (n && runs[n - 1] === style) runs[n - 2]! += len;
      else runs.push(len, style);
    };
    let state: StateStack = INITIAL;
    let start = 0;
    while (start <= code.length) {
      const nl = code.indexOf('\n', start);
      const end = nl < 0 ? code.length : nl;
      // \r\n counts as the line break; a lone \r (at the very end) stays part of the line.
      const lineEnd = nl >= 0 && end > start && code.charCodeAt(end - 1) === 13 ? end - 1 : end;
      const line = code.slice(start, lineEnd);
      if (line.length > MAX_LINE_CHARS) push(line.length, 0); // plain, state carried over (as VS Code does)
      else {
        // Empty lines too: `while` rules and `^$` patterns end blocks there.
        const r = g.tokenizeLine2(line, state, LINE_TIME_MS);
        if (r.stoppedEarly) push(line.length, 0);
        else {
          const t = r.tokens;
          for (let i = 0; i < t.length; i += 2) {
            const from = t[i]!;
            const to = i + 2 < t.length ? t[i + 2]! : line.length;
            const meta = t[i + 1]!;
            const text = line.slice(from, to);
            const style = /^\s*$/.test(text)
              ? this.whitespaceStyle(runs, pal.styles)
              : this.styleOf(pal, colors[(meta & FOREGROUND_MASK) >>> FOREGROUND_OFFSET], (meta & FONT_STYLE_MASK) >>> FONT_STYLE_OFFSET);
            push(to - from, style);
          }
          state = r.ruleStack;
        }
      }
      if (nl < 0) break;
      push(nl + 1 - lineEnd, this.whitespaceStyle(runs, pal.styles)); // the line break (\n or \r\n)
      start = nl + 1;
    }
    return { runs };
  }

  /** Whitespace looks the same in any color: give it the previous run's style (fewer spans), unless that draws lines. */
  private whitespaceStyle(runs: number[], styles: HighlightStyle[]): number {
    const prev = runs.length ? runs[runs.length - 1]! : 0;
    return (styles[prev]?.font ?? 0) & (4 | 8) ? 0 : prev;
  }

  private styleOf(pal: Palette, color: string | undefined, font: number): number {
    const c = color && HEX_COLOR.test(color) && color.toLowerCase() !== pal.fg ? color.toLowerCase() : undefined;
    const f = font & 15;
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

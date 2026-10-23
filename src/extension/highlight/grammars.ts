// Which grammars a block needs (no Shiki here: the extension host imports this without loading the highlighter).
import { grammarFor, type HighlightLang } from '../../shared/highlight-languages.ts';

/** The grammars a block needs: its own, and for markdown the shipped grammars its fences name (via the alias table). */
export function grammarsFor(lang: HighlightLang, code: string): HighlightLang[] {
  const out: HighlightLang[] = [lang];
  if (lang !== 'markdown') return out;
  for (const m of code.matchAll(/^[ \t]{0,3}(?:`{3,}|~{3,})[ \t]*\{?\.?([^\s`{}]+)/gm)) {
    const g = grammarFor(m[1]!);
    if (g && !out.includes(g) && out.length < 24) out.push(g);
  }
  return out;
}

export function countLines(s: string): number {
  let n = 1;
  for (let i = s.indexOf('\n'); i >= 0; i = s.indexOf('\n', i + 1)) n++;
  return n;
}

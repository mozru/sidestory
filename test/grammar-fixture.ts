// A fake installed extension holding real TextMate grammars (from @shikijs/langs, a dev dependency: the same
// grammars VS Code's built-in language extensions ship), for tests of the highlighter (docs/HIGHLIGHT-PLAN.md §10).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ExtensionInfo } from '../src/extension/highlight/catalog.ts';
import type { ThemeReader } from '../src/extension/highlight/theme.ts';
import { realPathInside } from '../src/extension/paths.ts';

interface ShikiLang {
  name: string;
  scopeName: string;
  aliases?: string[];
  injectTo?: string[];
}

/** Writes `names`' grammars (and those they embed) as one extension in `dir`, as VS Code would list it. */
export async function writeGrammarExtension(dir: string, names: readonly string[], id = 'test.grammars', builtin = true): Promise<ExtensionInfo> {
  const languages: { id: string; aliases: string[] }[] = [];
  const grammars: { language?: string; scopeName: string; path: string; injectTo?: string[] }[] = [];
  const seen = new Set<string>();
  mkdirSync(join(dir, 'syntaxes'), { recursive: true });
  for (const name of names) {
    const mod = (await import(`@shikijs/langs/${name}`)) as { default: ShikiLang[] };
    for (const g of mod.default) {
      if (seen.has(g.scopeName)) continue;
      seen.add(g.scopeName);
      const path = `./syntaxes/${g.name}.tmLanguage.json`;
      writeFileSync(join(dir, path), JSON.stringify(g));
      languages.push({ id: g.name, aliases: g.aliases ?? [] });
      grammars.push({ language: g.name, scopeName: g.scopeName, path, ...(g.injectTo ? { injectTo: g.injectTo } : {}) });
    }
  }
  const contributes = { languages, grammars };
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: id.split('.')[1], publisher: id.split('.')[0], contributes }));
  return { id, root: pathToFileURL(dir).href, builtin, contributes };
}

/** Reads extension files from disk with the real-path check, as the service's reader does for `file:` URIs. */
export const diskReader: ThemeReader = {
  async read(uri, maxBytes = 2 * 1024 * 1024) {
    try {
      const text = readFileSync(new URL(uri), 'utf8');
      return text.length > maxBytes ? undefined : text;
    } catch {
      return undefined;
    }
  },
  async inside(uri, root) {
    return (await realPathInside(fileURLToPath(uri), fileURLToPath(root))) !== null;
  },
};

/** vscode-oniguruma's own copy of onig.wasm (in node_modules), standing in for VS Code's. */
export const ONIG_WASM = join(dirname(createRequire(import.meta.url).resolve('vscode-oniguruma')), 'onig.wasm');

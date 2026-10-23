// Writes the syntax highlighter's data (docs/HIGHLIGHT-PLAN.md §6): one JSON file per shipped grammar, from
// @shikijs/langs' ES modules (each grammar alone; the worker loads embedded grammars by name), and VS Code's
// default themes for the fallback.
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EMBEDDED_GRAMMARS, HIGHLIGHT_LANGS } from '../src/shared/highlight-languages.ts';

/** @param {string} outDir e.g. dist/highlight */
export async function buildHighlight(outDir = 'dist/highlight') {
  mkdirSync(join(outDir, 'grammars'), { recursive: true });
  for (const name of [...HIGHLIGHT_LANGS, ...EMBEDDED_GRAMMARS]) {
    const mod = await import(`@shikijs/langs/${name}`);
    const self = mod.default.find((g) => g.name === name);
    if (!self) throw new Error(`grammar ${name} not found in @shikijs/langs`);
    // Embedded grammars we don't ship are dropped from the lists; lazy ones load only when already loaded.
    const shipped = new Set([...HIGHLIGHT_LANGS, ...EMBEDDED_GRAMMARS]);
    const g = { ...self, embeddedLangs: (self.embeddedLangs ?? []).filter((l) => shipped.has(l)) };
    // Markdown's inline HTML (its other embedded languages are loaded by the worker from the fences it finds).
    if (name === 'markdown') g.embeddedLangs.push('html-derivative');
    // Kept (shipped ones only): Shiki resets a grammar that lazily embeds a language loaded after it was used.
    if (self.embeddedLangsLazy) g.embeddedLangsLazy = self.embeddedLangsLazy.filter((l) => shipped.has(l));
    writeFileSync(join(outDir, 'grammars', `${name}.json`), JSON.stringify(g));
  }
  cpSync('src/extension/highlight/fallback-themes', join(outDir, 'themes'), { recursive: true });
}

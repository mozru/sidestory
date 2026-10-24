// Code block highlighting (docs/HIGHLIGHT-PLAN.md): language names, the grammar catalog built from installed
// extensions, theme loading, the tokenizer, the host's worker manager, the protocol, and the size of what ships.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { diskReader, ONIG_WASM, writeGrammarExtension } from '../grammar-fixture.ts';
import { type ExtensionInfo, GrammarCatalog, includedScopes, loadGrammarSet, MAX_GRAMMAR_SET_FILES } from '../../src/extension/highlight/catalog.ts';
import { BREAKER_TIMEOUTS, type GrammarSource, Highlighter } from '../../src/extension/highlight/host.ts';
import {
  candidateThemes, customizationRules, findContribution, loadThemeChain, normalizeTheme, resolveInside, type ThemeContribution, themeKeyMatches,
  type ThemeReader,
} from '../../src/extension/highlight/theme.ts';
import { createOnigLib, type EngineName, Tokenizer } from '../../src/extension/highlight/tokenize.ts';
import { langFromClass, langName } from '../../src/shared/highlight-languages.ts';
import { fromWebviewSchema } from '../../src/shared/protocol.ts';

const repo = join(import.meta.dirname, '../..');
const themesDir = join(repo, 'src/extension/highlight/fallback-themes');
/** The languages of the fake "built-in" extension (as VS Code's own language extensions would give them). */
const LANGS = ['typescript', 'tsx', 'javascript', 'python', 'rust', 'go', 'c', 'cpp', 'json', 'yaml', 'shellscript', 'html', 'css', 'markdown', 'diff'];
let out: string;
let builtin: ExtensionInfo;
let catalog: GrammarCatalog;
let source: GrammarSource;

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), 'cx-hl-'));
  builtin = await writeGrammarExtension(join(out, 'builtin'), LANGS, 'vscode.languages');
  catalog = new GrammarCatalog([builtin]);
  source = sourceOf(catalog);
}, 60_000);
afterAll(() => rmSync(out, { recursive: true, force: true }));

function sourceOf(c: GrammarCatalog): GrammarSource {
  return { key: c.key, scopeFor: (l) => c.scopeFor(l), load: (s) => loadGrammarSet(c, s, diskReader) };
}

/** A theme from the bundled fallbacks (VS Code's defaults). */
async function fallback(kind: 'dark' | 'light' | 'hc-dark' | 'hc-light') {
  const root = pathToFileURL(themesDir).href;
  const raw = await loadThemeChain(`${root}/${kind}.json`, root, fileReader);
  return normalizeTheme(raw!, kind, kind);
}
const fileReader: ThemeReader = {
  read: async (u) => {
    try {
      return readFileSync(new URL(u), 'utf8');
    } catch {
      return undefined;
    }
  },
  inside: async () => true,
};

const engines: Record<EngineName, ReturnType<typeof createOnigLib>> = {} as never;
/** A tokenizer with the fake extension's grammars loaded for `scopes`, on Oniguruma (node_modules' wasm) or JS. */
async function tokenizerFor(scopes: string[], engine: EngineName = 'oniguruma') {
  engines[engine] ??= createOnigLib(engine === 'oniguruma' ? [ONIG_WASM] : []);
  const e = await engines[engine];
  expect(e.engine).toBe(engine);
  const t = new Tokenizer(e.lib);
  for (const s of scopes) expect(await t.load(s, (await loadGrammarSet(catalog, s, diskReader))!), s).toBe(true);
  return t;
}

/** The colors of the runs' pieces: [text, color] in order. */
function pieces(code: string, runs: number[], pal: { color?: string }[]): [string, string | undefined][] {
  const out: [string, string | undefined][] = [];
  let sum = 0;
  for (let i = 0; i < runs.length; i += 2) {
    expect(runs[i]).toBeGreaterThan(0);
    out.push([code.slice(sum, sum + runs[i]!), pal[runs[i + 1]!]?.color]);
    sum += runs[i]!;
  }
  expect(sum).toBe(code.length);
  return out;
}

describe('language names', () => {
  it('takes the first language class that can be a name, lower case', () => {
    expect(langFromClass('foo language-Rust bar')).toBe('rust');
    expect(langFromClass('lang-go')).toBe('go');
    expect(langFromClass('language-c++ language-vhdl')).toBe('c++');
    expect(langFromClass('language-../x language-c#')).toBe('c#');
    expect(langFromClass(null)).toBeUndefined();
    for (const bad of ['', ' ', '../x', 'a/b', 'x y', '-x', `a${'b'.repeat(64)}`, 'é']) expect(langName(bad), bad).toBeUndefined();
    expect(langName(' SystemVerilog ')).toBe('systemverilog');
  });
});

describe('grammar catalog', () => {
  it('maps names through language ids, aliases, file extensions and a few fence names', () => {
    const c = new GrammarCatalog([{
      id: 'vscode.x', root: 'file:///ext/x', builtin: true,
      contributes: {
        languages: [{ id: 'python', aliases: ['Python', 'py'], extensions: ['.py', '.pyw'] }, { id: 'shellscript', aliases: ['Shell Script', 'bash'], extensions: ['.sh'] }, { id: 'go', extensions: ['.go'] }],
        grammars: [{ language: 'python', scopeName: 'source.python', path: './syntaxes/python.tmLanguage.json' }, { language: 'shellscript', scopeName: 'source.shell', path: 'syntaxes/shell.tmLanguage.json' }, { language: 'go', scopeName: 'source.go', path: './go.tmLanguage' }],
      },
    }]);
    for (const n of ['python', 'PY', 'pyw', 'python3', 'Python']) expect(c.scopeFor(n), n).toBe('source.python');
    for (const n of ['bash', 'sh', 'shell script', 'console', 'shell']) expect(c.scopeFor(n), n).toBe('source.shell');
    expect(c.scopeFor('golang')).toBe('source.go');
    expect(c.grammar('source.go')?.format).toBe('plist');
    for (const n of ['klingon', '__proto__', 'constructor', 'toString', '', 'json5']) expect(c.scopeFor(n), n).toBeUndefined();
  });

  it("lets the reader's extensions win over built-in ones, and keys on what it would load", () => {
    const builtinX = { id: 'vscode.v', root: 'file:///b', builtin: true, contributes: { languages: [{ id: 'verilog', extensions: ['.v'] }], grammars: [{ language: 'verilog', scopeName: 'source.verilog', path: 'a.json' }] } };
    const user = { id: 'me.sv', root: 'file:///u', builtin: false, contributes: { languages: [{ id: 'verilog', aliases: ['sv'] }], grammars: [{ language: 'verilog', scopeName: 'source.verilog.mine', path: 'b.json' }] } };
    const c = new GrammarCatalog([user, builtinX]);
    expect(c.scopeFor('v')).toBe('source.verilog.mine');
    expect(c.scopeFor('sv')).toBe('source.verilog.mine');
    expect(new GrammarCatalog([builtinX]).key).not.toBe(c.key);
    expect(new GrammarCatalog([builtinX, user]).key).toBe(c.key);
  });

  it('skips grammars outside their extension, of unknown formats, or malformed', () => {
    const c = new GrammarCatalog([{
      id: 'evil.x', root: 'file:///ext/x', builtin: false,
      contributes: {
        languages: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }, { id: 7 }, null],
        grammars: [
          { language: 'a', scopeName: 'source.a', path: '../other/a.json' },
          { language: 'b', scopeName: 'source.b', path: '/etc/b.json' },
          { language: 'c', scopeName: 'source.c', path: 'c.js' },
          { language: 'd', scopeName: 'source.d', path: 'file:///etc/d.json' },
          { language: 'e', scopeName: 'source e', path: 'e.json' },
          { language: 'a', scopeName: 7, path: 'x.json' },
          null,
        ],
      },
    }, { id: 'bad.y', root: 'file:///ext/y', builtin: false, contributes: 'nope' }]);
    expect(c.size).toBe(0);
    for (const n of ['a', 'b', 'c', 'd', 'e']) expect(c.scopeFor(n)).toBeUndefined();
  });

  it('finds included scopes in JSON and plist grammars without parsing them', () => {
    const json = JSON.stringify({ patterns: [{ include: '#local' }, { include: '$self' }, { include: 'source.js' }, { include: 'text.html.basic#tags' }, { include: 'source.js' }] });
    expect(includedScopes(json, 'json')).toEqual(['source.js', 'text.html.basic']);
    const plist = '<dict><key>include</key><string>source.css</string><key>include</key>\n<string>#x</string></dict>';
    expect(includedScopes(plist, 'plist')).toEqual(['source.css']);
  });

  it("reads a grammar's includes and injections, breadth first, and refuses files outside the extension", async () => {
    const md = await loadGrammarSet(catalog, 'text.html.markdown', diskReader);
    expect(md!.files[0]!.scopeName).toBe('text.html.markdown');
    const scopes = md!.files.map((f) => f.scopeName);
    for (const s of ['source.python', 'source.ts', 'text.html.basic']) expect(scopes).toContain(s);
    expect(scopes.length).toBeLessThanOrEqual(MAX_GRAMMAR_SET_FILES);
    expect(await loadGrammarSet(catalog, 'source.nope', diskReader)).toBeUndefined();

    // A grammar whose file is a symlink out of its extension folder isn't read.
    const dir = join(out, 'evil');
    mkdirSync(join(dir, 'syntaxes'), { recursive: true });
    writeFileSync(join(out, 'secret.json'), JSON.stringify({ scopeName: 'source.evil', patterns: [] }));
    symlinkSync(join(out, 'secret.json'), join(dir, 'syntaxes', 'evil.json'));
    const evil = new GrammarCatalog([{ id: 'evil.x', root: pathToFileURL(dir).href, builtin: false, contributes: { languages: [{ id: 'evil' }], grammars: [{ language: 'evil', scopeName: 'source.evil', path: './syntaxes/evil.json' }] } }]);
    expect(evil.scopeFor('evil')).toBe('source.evil');
    expect(await loadGrammarSet(evil, 'source.evil', diskReader)).toBeUndefined();
  });

  it('matches injectTo on dotted prefixes, as VS Code does, and skips scopes the worker has', async () => {
    const c = new GrammarCatalog([builtin, { id: 'me.all', root: 'file:///ext/all', builtin: false, contributes: { grammars: [{ scopeName: 'all.injection', path: 'a.json', injectTo: ['source'] }] } }]);
    expect(c.injectorsOf('source.python')).toEqual(['all.injection']);
    expect(c.injectorsOf('text.html.basic')).toEqual([]);
    const full = (await loadGrammarSet(catalog, 'text.html.markdown', diskReader))!;
    const have = new Set(['source.python', 'source.ts']);
    const less = (await loadGrammarSet(catalog, 'text.html.markdown', diskReader, undefined, have))!;
    expect(less.files.map((f) => f.scopeName)).toEqual(full.files.map((f) => f.scopeName).filter((s) => !have.has(s)));
    expect(less.bytes).toBeLessThan(full.bytes!);
  });

  it('collects injections into the scopes it loads', async () => {
    const dir = join(out, 'inject');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'todo.json'), JSON.stringify({ scopeName: 'todo.injection', injectionSelector: 'L:comment', patterns: [{ match: 'TODO', name: 'keyword.todo' }] }));
    const ext: ExtensionInfo = { id: 'me.todo', root: pathToFileURL(dir).href, builtin: false, contributes: { grammars: [{ scopeName: 'todo.injection', path: 'todo.json', injectTo: ['source.python'] }] } };
    const c = new GrammarCatalog([builtin, ext]);
    const set = await loadGrammarSet(c, 'source.python', diskReader);
    expect(set!.injections).toEqual([['source.python', ['todo.injection']]]);
    expect(set!.files.map((f) => f.scopeName)).toContain('todo.injection');
  });
});

describe('theme loading', () => {
  const root = 'file:///ext/theme';
  const files: Record<string, string> = {};
  const reader: ThemeReader = { read: async (u) => files[u], inside: async (u) => !u.includes('/escape/') };
  const tc = (scope: string, fg: string) => ({ scope, settings: { foreground: fg } });

  it('reads JSONC and follows include chains, included rules first and own colors winning', async () => {
    files[`${root}/base.json`] = JSON.stringify({ colors: { 'editor.foreground': '#111111', 'editor.background': '#222222' }, tokenColors: [tc('keyword', '#aa0000')] });
    files[`${root}/themes/mid.json`] = `{
      // a comment
      "include": "../base.json",
      "tokenColors": [{ "scope": "string", "settings": { "foreground": "#00aa00" } },],
    }`;
    files[`${root}/themes/top.json`] = JSON.stringify({ include: './mid.json', colors: { 'editor.foreground': '#333333' }, tokenColors: [tc('keyword', '#0000aa')] });
    const raw = await loadThemeChain(`${root}/themes/top.json`, root, reader);
    expect(raw?.colors).toEqual({ 'editor.foreground': '#333333', 'editor.background': '#222222' });
    expect(raw?.tokenColors.map((r) => (r as { scope: string }).scope)).toEqual(['keyword', 'string', 'keyword']);
    const t = normalizeTheme(raw!, 'dark', 'Top');
    expect(t.fg).toBe('#333333');
    expect(t.rules.at(-1)).toEqual(tc('keyword', '#0000aa'));
  });

  it('refuses cycles, escapes, absolute paths, missing files and bad JSON', async () => {
    files[`${root}/a.json`] = JSON.stringify({ include: './b.json' });
    files[`${root}/b.json`] = JSON.stringify({ include: './a.json' });
    expect(await loadThemeChain(`${root}/a.json`, root, reader)).toBeUndefined();
    for (const inc of ['../other/x.json', '/etc/x.json', 'file:///etc/x.json', 'C:\\x.json', 'https://example.com/x.json', 'missing.json', './escape/x.json']) {
      files[`${root}/inc.json`] = JSON.stringify({ include: inc, tokenColors: [] });
      files[`${root}/escape/x.json`] = '{}';
      expect(await loadThemeChain(`${root}/inc.json`, root, reader), inc).toBeUndefined();
    }
    files[`${root}/bad.json`] = '{ "tokenColors": [ }';
    expect(await loadThemeChain(`${root}/bad.json`, root, reader)).toBeUndefined();
    expect(resolveInside('../../x.json', `${root}/t/a.json`, root)).toBeUndefined();
    expect(resolveInside('x.json?y', `${root}/a.json`, root)).toBeUndefined();
  });

  it('caps include depth and file size', async () => {
    for (let i = 0; i < 12; i++) files[`${root}/d${i}.json`] = JSON.stringify({ include: `./d${i + 1}.json` });
    files[`${root}/d12.json`] = '{}';
    expect(await loadThemeChain(`${root}/d0.json`, root, reader)).toBeUndefined();
    files[`${root}/big.json`] = JSON.stringify({ tokenColors: [], pad: 'x'.repeat(2 * 1024 * 1024 + 1) });
    expect(await loadThemeChain(`${root}/big.json`, root, reader)).toBeUndefined();
  });

  it('reads the old `settings` key and a tokenColors file, not a .tmTheme', async () => {
    files[`${root}/old.json`] = JSON.stringify({ settings: [{ settings: { foreground: '#abcdef' } }, tc('comment', '#123456')] });
    const old = await loadThemeChain(`${root}/old.json`, root, reader);
    expect(old?.tokenColors).toEqual([{ settings: { foreground: '#abcdef' } }, tc('comment', '#123456')]);
    expect(old?.colors['editor.foreground']).toBe('#abcdef'); // the scope-less rule of the old format
    files[`${root}/tc.json`] = JSON.stringify({ tokenColors: [tc('string', '#654321')] });
    files[`${root}/ref.json`] = JSON.stringify({ tokenColors: './tc.json' });
    expect((await loadThemeChain(`${root}/ref.json`, root, reader))?.tokenColors).toEqual([tc('string', '#654321')]);
    files[`${root}/plist.json`] = JSON.stringify({ tokenColors: './x.tmTheme' });
    expect(await loadThemeChain(`${root}/plist.json`, root, reader)).toBeUndefined();
  });

  it('keeps only hex colors and known font styles, and keys on the content', () => {
    const raw = {
      colors: { 'editor.foreground': 'red' },
      tokenColors: [
        tc('a', '#abc'), tc('b', 'red'), tc('c', '#12345'), tc('d', 'url(x)'), { scope: 'e', settings: { fontStyle: 'italic blink bold' } },
        { scope: 'f', settings: { fontStyle: '' } }, { scope: 7, settings: { foreground: '#fff' } }, null, 'x', { scope: 'g' },
        { settings: { foreground: '#999999' } },
      ],
    };
    const t = normalizeTheme(raw, 'dark', 'X');
    // Rules without a scope are ignored, as VS Code does; editor.foreground wasn't hex: the kind's default.
    expect(t.rules).toEqual([tc('a', '#abc'), { scope: 'e', settings: { fontStyle: 'italic bold' } }, { scope: 'f', settings: { fontStyle: '' } }]);
    expect(t.fg).toBe('#bbbbbb');
    // "normal" (any string) resets inherited styles.
    expect(normalizeTheme({ colors: {}, tokenColors: [{ scope: 'c', settings: { fontStyle: 'normal' } }] }, 'dark', 'N').rules).toEqual([{ scope: 'c', settings: { fontStyle: '' } }]);
    expect(normalizeTheme(raw, 'dark', 'Y').key).toBe(t.key);
    expect(normalizeTheme({ ...raw, colors: { 'editor.foreground': '#000000' } }, 'dark', 'X').key).not.toBe(t.key);
    expect(normalizeTheme({ colors: {}, tokenColors: [] }, 'hc-light', 'Z')).toMatchObject({ type: 'light', fg: '#292929' });
  });

  it("applies the user's token color customizations, global then per theme, capped", () => {
    const setting = {
      comments: '#111111',
      strings: { foreground: '#222222', fontStyle: 'italic' },
      keywords: 'not a color',
      textMateRules: [tc('x', '#333333'), ...Array.from({ length: 2000 }, () => tc('y', '#444444'))],
      '[Dark*]': { numbers: '#555555' },
      '[Other][Dark 2026]': { textMateRules: [tc('z', '#666666')] },
      '[Light 2026]': { functions: '#777777' },
    };
    const rules = customizationRules(setting, 'Dark 2026');
    expect(rules[0]).toEqual({ scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: '#111111' } });
    expect(rules[1]?.settings).toEqual({ foreground: '#222222', fontStyle: 'italic' });
    expect(rules.filter((r) => r.scope === 'y').length).toBe(999);
    expect(rules.some((r) => r.settings.foreground === '#555555')).toBe(true);
    expect(rules.at(-1)).toEqual(tc('z', '#666666'));
    expect(rules.some((r) => r.settings.foreground === '#777777')).toBe(false);
    expect(themeKeyMatches('[A][B]', 'B')).toBe(true);
    expect(themeKeyMatches('[*Dark*]', 'Dark Modern')).toBe(true);
    expect(themeKeyMatches('[Dark]x', 'Dark')).toBe(false);
    expect(themeKeyMatches('[a.b]', 'aXb')).toBe(false);
    expect(themeKeyMatches('[A] [B]', 'B')).toBe(true);
    expect(themeKeyMatches('[Dark*]', 'Dark Modern')).toBe(true);
    expect(themeKeyMatches('[*Modern]', 'Dark Modern')).toBe(true);
    expect(themeKeyMatches('[Da*rn]', 'Dark Modern')).toBe(false); // only a leading or trailing * is a wildcard
    // Linear: the key can come from a repository's settings.
    const t0 = performance.now();
    expect(themeKeyMatches(`[${'*'.repeat(40)}!]`, 'Default Dark Modern')).toBe(false);
    expect(themeKeyMatches(`[${'a*'.repeat(100)}]`, 'a'.repeat(100))).toBe(false);
    expect(themeKeyMatches('['.repeat(100_000), 'x')).toBe(false);
    expect(customizationRules({ [`[${'*'.repeat(40)}!]`]: { comments: '#fff' }, ['['.repeat(100_000)]: {} }, 'Default Dark Modern')).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(200);
    expect(customizationRules('#fff', 'X')).toEqual([]);
  });

  it('picks the theme the way VS Code does, and checks it fits the active kind', () => {
    const s = { colorTheme: 'Default Dark Modern', preferredDark: 'Night', preferredLight: 'Day', preferredHighContrast: 'HC', kindDefault: 'Dark 2026' };
    expect(candidateThemes('dark', s)).toEqual(['Dark Modern', 'Dark 2026']);
    expect(candidateThemes('dark', { ...s, autoDetectColorScheme: true })).toEqual(['Night', 'Dark Modern', 'Dark 2026']);
    // A high-contrast theme picked by hand is in colorTheme; the preferred one is for the OS's high contrast mode.
    expect(candidateThemes('hc-dark', { ...s, kindDefault: 'Default High Contrast' })).toEqual(['Dark Modern', 'HC', 'Default High Contrast']);
    expect(candidateThemes('hc-dark', { ...s, autoDetectHighContrast: false, kindDefault: 'Default High Contrast' })).toEqual(['Dark Modern', 'Default High Contrast']);
    expect(candidateThemes('dark', { colorTheme: 'VS Code Dark', kindDefault: 'Dark 2026' })).toEqual(['Dark 2026']);
    const all: ThemeContribution[] = [
      { id: 'Dark 2026', label: '%dark2026%', uiTheme: 'vs-dark', uri: 'file:///a/d.json', root: 'file:///a' },
      { id: 'Solar', label: 'Solarized', uiTheme: 'vs', uri: 'file:///b/s.json', root: 'file:///b' },
    ];
    expect(findContribution('Dark 2026', 'dark', all)?.uri).toBe('file:///a/d.json');
    expect(findContribution('Solarized', 'light', all)?.id).toBe('Solar');
    expect(findContribution('Solar', 'dark', all)).toBeUndefined(); // a light theme can't be the active dark one
  });

  it('bundles VS Code default themes for every kind', async () => {
    for (const kind of ['dark', 'light', 'hc-dark', 'hc-light'] as const) {
      const t = await fallback(kind);
      expect(t.rules.length).toBeGreaterThan(40);
    }
    expect((await fallback('dark')).fg).toBe('#bbbebf');
  });
});


describe('tokenizer', () => {
  for (const engine of ['oniguruma', 'javascript'] as const) {
    it(`returns runs that cover the text exactly, with theme colors and unstyled defaults (${engine})`, async () => {
      const theme = await fallback('dark');
      const t = await tokenizerFor(['source.ts'], engine);
      t.setTheme(theme);
      const code = 'const x = "<b>&amp;</b>";\r\n// done\n';
      const r = t.tokenize(code, 'source.ts', theme.key)!;
      const pal = t.palette(theme.key);
      const p = pieces(code, r.runs, pal);
      const color = (s: string) => p.find(([x]) => x.includes(s))?.[1];
      // Dark 2026's colors, as the editor shows them.
      expect(color('const')).toBe('#ff7b72');
      expect(color('"<b>&amp;</b>"')).toBe('#a5d6ff');
      expect(color('// done')).toBe('#8b949e');
      expect(pal[0]).toEqual({});
      expect(p.some(([, c]) => c === theme.fg)).toBe(false); // default-colored tokens get no style
    });
  }

  it('refuses blocks over the caps, and unknown grammars or themes', async () => {
    const theme = await fallback('light');
    const t = await tokenizerFor(['source.python']);
    t.setTheme(theme);
    expect(t.tokenize('x\n'.repeat(2001), 'source.python', theme.key)).toBeNull();
    expect(t.tokenize('x'.repeat(100_001), 'source.python', theme.key)).toBeNull();
    expect(t.tokenize('x = 1', 'source.rust', theme.key)).toBeNull();
    expect(t.tokenize('x = 1', 'source.python', 'nope')).toBeNull();
    // A line over 2,000 characters is one plain run, and the next line is still tokenized.
    const long = `x = "${'a'.repeat(2100)}"`;
    expect(t.tokenize(long, 'source.python', theme.key)!.runs).toEqual([long.length, 0]);
    const after = t.tokenize(`${long}\ndef f(): pass`, 'source.python', theme.key)!;
    expect(after.runs.length).toBeGreaterThan(4);
  });

  it('colors fenced code in markdown with the grammars it includes', async () => {
    const theme = await fallback('dark');
    const t = await tokenizerFor(['text.html.markdown']);
    t.setTheme(theme);
    const md = '# Title\n\n```python\ndef f(): pass\n```\n\n```rust\nfn main() {}\n```\n';
    const p = pieces(md, t.tokenize(md, 'text.html.markdown', theme.key)!.runs, t.palette(theme.key));
    expect(p.find(([x]) => x.includes('def'))?.[1]).toBe('#ff7b72');
    expect(p.find(([x]) => x.startsWith('fn'))?.[1]).toBe('#ff7b72');
  });

  it('applies injections from other extensions', async () => {
    const dir = join(out, 'inject2');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'todo.json'), JSON.stringify({ scopeName: 'todo.injection', injectionSelector: 'L:comment', patterns: [{ match: 'TODO', name: 'invalid.illegal.todo' }] }));
    const c = new GrammarCatalog([builtin, { id: 'me.todo', root: pathToFileURL(dir).href, builtin: false, contributes: { grammars: [{ scopeName: 'todo.injection', path: 'todo.json', injectTo: ['source.python'] }] } }]);
    const e = await (engines.oniguruma ??= createOnigLib([ONIG_WASM]));
    const t = new Tokenizer(e.lib);
    const theme = { ...(await fallback('dark')), key: 'inj' };
    theme.rules = [...theme.rules, { scope: 'invalid.illegal.todo', settings: { foreground: '#123456' } }];
    t.setTheme(theme);
    expect(await t.load('source.python', (await loadGrammarSet(c, 'source.python', diskReader))!)).toBe(true);
    const code = '# a TODO here';
    const p = pieces(code, t.tokenize(code, 'source.python', 'inj')!.runs, t.palette('inj'));
    expect(p.find(([x]) => x === 'TODO')?.[1]).toBe('#123456');
  });

  it('tokenizes every language of the fake built-in extension', async () => {
    const theme = await fallback('dark');
    const scopes = LANGS.map((l) => catalog.scopeFor(l)!);
    const t = await tokenizerFor(scopes);
    t.setTheme(theme);
    for (const s of scopes) {
      const r = t.tokenize('# h\nmodule x; // a "b" 1\n<b class="c">fn main() {}</b>\n', s, theme.key);
      expect(r, s).not.toBeNull();
      expect(r!.runs.some((v, i) => i % 2 === 1 && v !== 0), `${s} colors something`).toBe(true);
    }
  });

  it('tokenizes empty lines too, so a blank line ends what it ends (markdown HTML blocks)', async () => {
    const theme = await fallback('dark');
    const t = await tokenizerFor(['text.html.markdown']);
    t.setTheme(theme);
    const md = '<div>\nx\n\n# Heading';
    const p = pieces(md, t.tokenize(md, 'text.html.markdown', theme.key)!.runs, t.palette(theme.key));
    expect(p.find(([x]) => x.includes('Heading'))?.[1]).toBeDefined();
  });

  it('covers a lone \\r at the very end', async () => {
    const theme = await fallback('dark');
    const t = await tokenizerFor(['source.python']);
    t.setTheme(theme);
    for (const code of ['x = 1\r', 'x = 1\r\n', '\n\nx', '']) pieces(code, t.tokenize(code, 'source.python', theme.key)!.runs, t.palette(theme.key));
  });

  it("leaves a grammar that doesn't parse unloaded", async () => {
    const e = await (engines.oniguruma ??= createOnigLib([ONIG_WASM]));
    const t = new Tokenizer(e.lib);
    expect(await t.load('source.bad', { files: [{ scopeName: 'source.bad', format: 'json', text: '{ "scopeName": ' }], injections: [] })).toBe(false);
    expect(await t.load('source.bad2', { files: [{ scopeName: 'source.bad2', format: 'plist', text: '<plist><dict><key>' }], injections: [] })).toBe(false);
    expect(await t.load('source.missing', { files: [], injections: [] })).toBe(false);
  });

  it('falls back to the JavaScript engine without a usable wasm', async () => {
    // (A wasm that fails to load is the same path; vscode-oniguruma keeps the first wasm a process gave it, so
    // that's left to the worker test with no wasm at all.)
    const logs: string[] = [];
    const r = await createOnigLib([join(out, 'missing.wasm')], (m) => logs.push(m));
    expect(r.engine).toBe('javascript');
    expect(logs.join()).toMatch(/missing\.wasm/);
  });
});

describe('highlighter (host, with the worker)', () => {
  const workerFile = join(repo, 'src/extension/highlight/worker.ts');
  const make = (opts: ConstructorParameters<typeof Highlighter>[0] = {}) => {
    const h = new Highlighter({ workerFile, wasmFiles: [ONIG_WASM], ...opts });
    h.setGrammars(source);
    return h;
  };

  it('highlights, caches, keeps a stable palette, and leaves unknown languages plain', async () => {
    const logs: string[] = [];
    const h = make({ log: (m) => logs.push(m) });
    h.setTheme(await fallback('dark'));
    const who = h.newRequester();
    const r = (await h.request(who, [{ id: 1, lang: 'ts', code: 'let a = 1;' }, { id: 2, lang: 'rust', code: 'fn main() {}' }, { id: 4, lang: 'klingon', code: 'x' }]))!;
    expect(r.blocks.map((b) => b.id)).toEqual([1, 2, 4]);
    expect(r.blocks.slice(0, 2).every((b) => Array.isArray(b.runs))).toBe(true);
    expect(r.blocks[2]!.runs).toBeNull();
    expect(r.palette[0]).toEqual({});
    expect(h.engine).toBe('oniguruma');
    expect(logs.join()).toMatch(/Oniguruma/);
    const again = (await h.request(who, [{ id: 3, lang: 'typescript', code: 'let a = 1;' }]))!;
    expect(again.blocks[0]!.runs).toEqual(r.blocks[0]!.runs);
    expect(h.workersStarted).toBe(1);
    h.dispose();
  });

  it('uses the JavaScript engine when no wasm is found', async () => {
    const h = make({ wasmFiles: [] });
    h.setTheme(await fallback('dark'));
    const r = (await h.request(h.newRequester(), [{ id: 1, lang: 'python', code: 'def f(): pass' }]))!;
    expect(Array.isArray(r.blocks[0]!.runs)).toBe(true);
    expect(h.engine).toBe('javascript');
    h.dispose();
  });

  it('picks up new grammars: the key changes, the worker is replaced, and a new language is colored', async () => {
    const h = new Highlighter({ workerFile, wasmFiles: [ONIG_WASM] });
    h.setTheme(await fallback('dark'));
    const small = new GrammarCatalog([await writeGrammarExtension(join(out, 'small'), ['python'], 'vscode.python')]);
    h.setGrammars(sourceOf(small));
    const who = h.newRequester();
    const before = h.themeKey;
    expect((await h.request(who, [{ id: 1, lang: 'go', code: 'package main' }]))!.blocks[0]!.runs).toBeNull();
    expect((await h.request(who, [{ id: 2, lang: 'py', code: 'x = 1' }]))!.blocks[0]!.runs).not.toBeNull();
    const go = new GrammarCatalog([...[await writeGrammarExtension(join(out, 'small'), ['python'], 'vscode.python')], await writeGrammarExtension(join(out, 'go-ext'), ['go'], 'golang.go', false)]);
    h.setGrammars(sourceOf(go));
    expect(h.themeKey).not.toBe(before);
    expect(h.running).toBe(false);
    const r = (await h.request(who, [{ id: 3, lang: 'go', code: 'package main' }]))!;
    expect(r.theme).toBe(h.themeKey);
    expect(r.blocks[0]!.runs).not.toBeNull();
    h.dispose();
  });

  it("leaves a language plain when its grammar can't be read", async () => {
    const dir = join(out, 'gone');
    const ext = await writeGrammarExtension(dir, ['go'], 'gone.go', false);
    rmSync(join(dir, 'syntaxes'), { recursive: true });
    const logs: string[] = [];
    const h = new Highlighter({ workerFile, wasmFiles: [ONIG_WASM], log: (m) => logs.push(m) });
    h.setGrammars(sourceOf(new GrammarCatalog([ext])));
    h.setTheme(await fallback('dark'));
    expect((await h.request(h.newRequester(), [{ id: 1, lang: 'go', code: 'package main' }]))!.blocks[0]!.runs).toBeNull();
    expect(logs.join()).toMatch(/couldn't read the grammar source\.go/);
    h.dispose();
  });

  it('replaces a worker that holds too many grammars, and new grammars arriving mid-job', async () => {
    const h = make({ workerGrammarBudget: 1 });
    h.setTheme(await fallback('dark'));
    const who = h.newRequester();
    for (const [id, lang] of ['py', 'go', 'rs', 'ts'].entries()) expect((await h.request(who, [{ id, lang, code: 'x = 1' }]))!.blocks[0]!.runs, lang).not.toBeNull();
    expect(h.workersStarted).toBeGreaterThan(2);
    // New grammars while a block is being loaded: the answer comes under the new ones.
    const p = h.request(who, [{ id: 9, lang: 'markdown', code: '# x' }]);
    h.setGrammars(sourceOf(new GrammarCatalog([builtin, { id: 'x.y', root: 'file:///nowhere', builtin: false, contributes: { grammars: [{ scopeName: 'x.y', path: 'x.json' }] } }])));
    const r = (await p)!;
    expect(r.theme).toBe(h.themeKey);
    expect(r.blocks[0]!.runs).not.toBeNull();
    h.dispose();
  });

  it('replaces a waiting request with a newer one, and joins duplicate blocks', async () => {
    const h = make();
    h.setTheme(await fallback('dark'));
    const who = h.newRequester();
    const code = 'x = 1\n'.repeat(500);
    const first = h.request(who, [{ id: 1, lang: 'python', code }]);
    const second = h.request(who, [{ id: 2, lang: 'python', code }]);
    const third = h.request(who, [{ id: 3, lang: 'python', code }]);
    expect(await second).toBeUndefined();
    const [a, c] = await Promise.all([first, third]);
    expect(a!.blocks[0]!.runs).toEqual(c!.blocks[0]!.runs);
    h.dispose();
  });

  it('answers under the new theme when it changes meanwhile', async () => {
    const h = make();
    const dark = await fallback('dark');
    const light = await fallback('light');
    h.setTheme(dark);
    const p = h.request(h.newRequester(), [{ id: 1, lang: 'go', code: 'package main\nfunc main() {}' }]);
    h.setTheme(light);
    expect((await p)!.theme).toBe(h.themeKey);
    expect(h.themeKey!.startsWith(light.key)).toBe(true);
    h.dispose();
  });

  it('cuts off a slow block, replaces the worker, and stops after repeated timeouts', async () => {
    const logs: string[] = [];
    const h = make({ blockTimeoutMs: 1, msPerKb: 0, log: (m) => logs.push(m) });
    h.setTheme(await fallback('dark'));
    const who = h.newRequester();
    const big = (i: number) => `// ${i}\n${'const x: Array<Map<string, number>> = [1, 2, 3].map((v) => v * 2);\n'.repeat(1300)}`;
    for (let i = 0; i < BREAKER_TIMEOUTS; i++) {
      const r = await h.request(who, [{ id: i, lang: 'typescript', code: big(i) }]);
      expect(r!.blocks[0]!.runs).toBeNull();
    }
    expect(who.tripped).toBe(true);
    expect(logs.join()).toMatch(/too long/);
    expect(h.workersStarted).toBeGreaterThan(1);
    // Tripped: even small blocks stay plain for this requester, not for others.
    expect((await h.request(who, [{ id: 9, lang: 'typescript', code: 'let a;' }]))!.blocks[0]!.runs).toBeNull();
    h.dispose();
  }, 30_000);
});

describe('highlighter budget', () => {
  const workerFile = join(repo, 'src/extension/highlight/worker.ts');
  it('stops a requester that keeps the worker busy past its time budget, and one whose panel is gone', async () => {
    const logs: string[] = [];
    const h = new Highlighter({ workerFile, wasmFiles: [ONIG_WASM], budgetMs: 1, slowJobMs: 0, log: (m) => logs.push(m) });
    h.setGrammars(source);
    h.setTheme(await fallback('dark'));
    const who = h.newRequester();
    const code = 'const x: Array<Map<string, number>> = [1, 2, 3].map((v) => v * 2);\n'.repeat(400);
    await h.request(who, [{ id: 1, lang: 'typescript', code }]);
    expect(who.tripped).toBe(true);
    expect(logs.join()).toMatch(/busy/);
    // It comes back after the breaker's window.
    who.trippedAt = Date.now() - 6 * 60_000;
    expect((await h.request(who, [{ id: 3, lang: 'typescript', code: 'let b;' }]))!.blocks[0]!.runs).not.toBeNull();
    const gone = h.newRequester();
    gone.disposed = true;
    expect(await h.request(gone, [{ id: 2, lang: 'typescript', code: 'let a;' }])).toBeUndefined();
    h.dispose();
  }, 30_000);
});

describe('highlighter during live editing', () => {
  it('many quick re-tokenizations of one block never trip the breaker', async () => {
    const h = new Highlighter({ workerFile: join(repo, 'src/extension/highlight/worker.ts'), wasmFiles: [ONIG_WASM] });
    h.setGrammars(source);
    h.setTheme(await fallback('dark'));
    const who = h.newRequester();
    for (let i = 0; i < 300; i++) await h.request(who, [{ id: i, lang: 'python', code: `x = ${i}\n`.repeat(50) }]);
    expect(who.tripped).toBe(false);
    h.dispose();
  }, 60_000);
});

describe('protocol', () => {
  const msg = (blocks: unknown) => fromWebviewSchema.safeParse({ type: 'highlight', blocks }).success;
  it('accepts language names within the caps only', () => {
    expect(msg([{ id: 1, lang: 'typescript', code: 'x' }])).toBe(true);
    expect(msg([{ id: 1, lang: 'klingon', code: 'x' }])).toBe(true); // the host answers "plain"
    for (const lang of ['__proto__', '../x', 'TS', '', 'a b', 'x'.repeat(65), 7]) expect(msg([{ id: 1, lang, code: 'x' }]), String(lang)).toBe(false);
    expect(msg([{ id: -1, lang: 'c', code: 'x' }])).toBe(false);
    expect(msg([{ id: 1.5, lang: 'c', code: 'x' }])).toBe(false);
    expect(msg([])).toBe(false);
    expect(msg([{ id: 1, lang: 'c', code: 'x'.repeat(100_001) }])).toBe(false);
    expect(msg(Array.from({ length: 201 }, (_, id) => ({ id, lang: 'c', code: 'x' })))).toBe(false);
    expect(msg(Array.from({ length: 11 }, (_, id) => ({ id, lang: 'c', code: 'x'.repeat(100_000) })))).toBe(false);
  });
});

describe('size', () => {
  it('ships no grammars or wasm, keeps the fallback themes small, and the package under 2 MB', () => {
    let bytes = 0;
    for (const f of readdirSync(themesDir)) bytes += deflateRawSync(readFileSync(join(themesDir, f)), { level: 9 }).length;
    expect(bytes).toBeLessThan(20 * 1024);
    const ignore = readFileSync(join(repo, '.vscodeignore'), 'utf8');
    expect(ignore).not.toMatch(/grammars|\.wasm/);
    const vsix = join(repo, 'dist/sidestory.vsix');
    if (existsSync(vsix)) expect(statSync(vsix).size).toBeLessThan(2 * 1024 * 1024);
    const worker = join(repo, 'dist/highlight-worker.cjs');
    if (existsSync(worker) && !existsSync(join(repo, 'dist/highlight-worker.cjs.map'))) expect(statSync(worker).size).toBeLessThan(160 * 1024);
  });
});

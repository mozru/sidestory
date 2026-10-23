// Code block highlighting (docs/HIGHLIGHT-PLAN.md): languages, theme loading, the tokenizer, the host's worker
// manager, the protocol, and the size of what ships.
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LanguageRegistration } from '@shikijs/core';
// @ts-expect-error: a build script without types
import { buildHighlight } from '../../scripts/build-highlight.mjs';
import { grammarsFor } from '../../src/extension/highlight/grammars.ts';
import { BREAKER_TIMEOUTS, Highlighter } from '../../src/extension/highlight/host.ts';
import {
  candidateThemes, customizationRules, findContribution, loadThemeChain, normalizeTheme, resolveInside, type ThemeContribution, themeKeyMatches,
  type ThemeReader,
} from '../../src/extension/highlight/theme.ts';
import { Tokenizer } from '../../src/extension/highlight/tokenize.ts';
import { grammarFor, HIGHLIGHT_LANGS, langFromClass } from '../../src/shared/highlight-languages.ts';
import { fromWebviewSchema } from '../../src/shared/protocol.ts';

const repo = join(import.meta.dirname, '../..');
let out: string;
let grammarDir: string;

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), 'cx-hl-'));
  await buildHighlight(out);
  grammarDir = join(out, 'grammars');
}, 60_000);
afterAll(() => rmSync(out, { recursive: true, force: true }));

const readGrammar = (name: string) => {
  const f = join(grammarDir, `${name}.json`);
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as LanguageRegistration) : undefined;
};

/** A theme from the bundled fallbacks (VS Code's defaults). */
async function fallback(kind: 'dark' | 'light' | 'hc-dark' | 'hc-light') {
  const root = `file://${out}/themes`;
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

describe('languages', () => {
  it('maps classes and aliases to the grammars we ship', () => {
    expect(grammarFor('ts')).toBe('typescript');
    expect(grammarFor('PY')).toBe('python');
    expect(grammarFor('sv')).toBe('system-verilog');
    expect(grammarFor('c++')).toBe('cpp');
    expect(grammarFor('jsx')).toBe('javascript');
    expect(grammarFor('sh')).toBe('shellscript');
    expect(grammarFor('yml')).toBe('yaml');
    expect(langFromClass('foo language-rust bar')).toBe('rust');
    expect(langFromClass('lang-go')).toBe('go');
    expect(langFromClass('language-klingon language-vhdl')).toBe('vhdl');
    for (const name of ['', 'klingon', '__proto__', 'constructor', 'toString', 'hasOwnProperty', '../x']) expect(grammarFor(name)).toBeUndefined();
    expect(langFromClass('language-__proto__ lang-constructor')).toBeUndefined();
    expect(langFromClass(null)).toBeUndefined();
  });

  it('ships a grammar for every language, and the build writes exactly those', () => {
    const files = readdirSync(grammarDir).map((f) => f.replace(/\.json$/, ''));
    for (const l of HIGHLIGHT_LANGS) expect(files).toContain(l);
    expect(files.length).toBe(HIGHLIGHT_LANGS.length + 4);
  });

  it('loads markdown fence languages only through the alias table', () => {
    const md = '```ts\nconst x = 1;\n```\n~~~ ../../x\n~~~\n```__proto__\n```\n```{.python}\n```\n```klingon\n```';
    expect(grammarsFor('markdown', md)).toEqual(['markdown', 'typescript', 'python']);
    expect(grammarsFor('python', md)).toEqual(['python']);
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
  it('returns runs that cover the text exactly, with theme colors and unstyled defaults', async () => {
    const theme = await fallback('dark');
    const t = new Tokenizer(readGrammar);
    t.setTheme(theme);
    t.load(['typescript']);
    const code = 'const x = "<b>&amp;</b>";\r\n// done\n';
    const r = t.tokenize(code, 'typescript', theme.key)!;
    const pal = t.palette(theme.key);
    let sum = 0;
    const pieces: [string, string | undefined][] = [];
    for (let i = 0; i < r.runs.length; i += 2) {
      pieces.push([code.slice(sum, sum + r.runs[i]!), pal[r.runs[i + 1]!]?.color]);
      sum += r.runs[i]!;
      expect(r.runs[i]).toBeGreaterThan(0);
    }
    expect(sum).toBe(code.length);
    const color = (s: string) => pieces.find(([p]) => p.includes(s))?.[1];
    // Dark 2026's colors, as the editor shows them.
    expect(color('const')).toBe('#ff7b72');
    expect(color('"<b>&amp;</b>"')).toBe('#a5d6ff');
    expect(color('// done')).toBe('#8b949e');
    expect(pal[0]).toEqual({});
    expect(pieces.some(([, c]) => c === theme.fg)).toBe(false); // default-colored tokens get no style
  });

  it('refuses blocks over the caps, and unknown grammars or themes', async () => {
    const theme = await fallback('light');
    const t = new Tokenizer(readGrammar);
    t.setTheme(theme);
    t.load(['python']);
    expect(t.tokenize('x\n'.repeat(2001), 'python', theme.key)).toBeNull();
    expect(t.tokenize('x'.repeat(100_001), 'python', theme.key)).toBeNull();
    expect(t.tokenize('x = 1', 'rust', theme.key)).toBeNull();
    expect(t.tokenize('x = 1', 'python', 'nope')).toBeNull();
    // A line over 2,000 characters is one plain run.
    const long = `x = "${'a'.repeat(2100)}"`;
    expect(t.tokenize(long, 'python', theme.key)!.runs).toEqual([long.length, 0]);
  });

  it('colors fenced code in markdown with the grammars it names', async () => {
    const theme = await fallback('dark');
    const t = new Tokenizer(readGrammar);
    t.setTheme(theme);
    const md = '# Title\n\n```python\ndef f(): pass\n```\n';
    t.load(grammarsFor('markdown', md));
    const r = t.tokenize(md, 'markdown', theme.key)!;
    const pal = t.palette(theme.key);
    let pos = 0;
    let defColor: string | undefined;
    for (let i = 0; i < r.runs.length; i += 2) {
      if (md.slice(pos, pos + r.runs[i]!).includes('def')) defColor = pal[r.runs[i + 1]!]?.color;
      pos += r.runs[i]!;
    }
    expect(defColor).toBe('#ff7b72');
  });

  it('colors a markdown fence whose grammar loads after markdown was already used', async () => {
    const theme = await fallback('dark');
    const t = new Tokenizer(readGrammar);
    t.setTheme(theme);
    const first = '```python\nx = 1\n```\n';
    t.load(grammarsFor('markdown', first));
    t.tokenize(first, 'markdown', theme.key);
    const md = '```rust\nfn main() {}\n```\n';
    t.load(grammarsFor('markdown', md));
    const r = t.tokenize(md, 'markdown', theme.key)!;
    const pal = t.palette(theme.key);
    let pos = 0;
    let fnColor: string | undefined;
    for (let i = 0; i < r.runs.length; i += 2) {
      if (md.slice(pos, pos + r.runs[i]!).startsWith('fn')) fnColor = pal[r.runs[i + 1]!]?.color;
      pos += r.runs[i]!;
    }
    expect(fnColor).toBe('#ff7b72');
  });

  it('tokenizes every shipped language', async () => {
    const theme = await fallback('dark');
    const t = new Tokenizer(readGrammar);
    t.setTheme(theme);
    for (const l of HIGHLIGHT_LANGS) {
      t.load([l]);
      const r = t.tokenize('module x; // a "b" 1\nfn main() {}\n', l, theme.key);
      expect(r, l).not.toBeNull();
    }
  });
});

describe('highlighter (host, with the worker)', () => {
  const workerFile = join(repo, 'src/extension/highlight/worker.ts');

  it('highlights, caches and keeps a stable palette', async () => {
    const h = new Highlighter({ workerFile, grammarDir });
    h.setTheme(await fallback('dark'));
    const who = h.newRequester();
    const r = (await h.request(who, [{ id: 1, lang: 'typescript', code: 'let a = 1;' }, { id: 2, lang: 'rust', code: 'fn main() {}' }]))!;
    expect(r.blocks.map((b) => b.id)).toEqual([1, 2]);
    expect(r.blocks.every((b) => Array.isArray(b.runs))).toBe(true);
    expect(r.palette[0]).toEqual({});
    const again = (await h.request(who, [{ id: 3, lang: 'typescript', code: 'let a = 1;' }]))!;
    expect(again.blocks[0]!.runs).toEqual(r.blocks[0]!.runs);
    expect(h.workersStarted).toBe(1);
    h.dispose();
  });

  it('replaces a waiting request with a newer one, and joins duplicate blocks', async () => {
    const h = new Highlighter({ workerFile, grammarDir });
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
    const h = new Highlighter({ workerFile, grammarDir });
    const dark = await fallback('dark');
    const light = await fallback('light');
    h.setTheme(dark);
    const p = h.request(h.newRequester(), [{ id: 1, lang: 'go', code: 'package main\nfunc main() {}' }]);
    h.setTheme(light);
    expect((await p)!.theme).toBe(light.key);
    h.dispose();
  });

  it('cuts off a slow block, replaces the worker, and stops after repeated timeouts', async () => {
    const logs: string[] = [];
    const h = new Highlighter({ workerFile, grammarDir, blockTimeoutMs: 1, msPerKb: 0, log: (m) => logs.push(m) });
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
    const h = new Highlighter({ workerFile, grammarDir, budgetMs: 1, slowJobMs: 0, log: (m) => logs.push(m) });
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
    const h = new Highlighter({ workerFile: join(repo, 'src/extension/highlight/worker.ts'), grammarDir });
    h.setTheme(await fallback('dark'));
    const who = h.newRequester();
    for (let i = 0; i < 300; i++) await h.request(who, [{ id: i, lang: 'python', code: `x = ${i}\n`.repeat(50) }]);
    expect(who.tripped).toBe(false);
    h.dispose();
  }, 60_000);
});

describe('protocol', () => {
  const msg = (blocks: unknown) => fromWebviewSchema.safeParse({ type: 'highlight', blocks }).success;
  it('accepts known languages within the caps only', () => {
    expect(msg([{ id: 1, lang: 'typescript', code: 'x' }])).toBe(true);
    expect(msg([{ id: 1, lang: 'klingon', code: 'x' }])).toBe(false);
    expect(msg([{ id: 1, lang: '__proto__', code: 'x' }])).toBe(false);
    expect(msg([{ id: -1, lang: 'c', code: 'x' }])).toBe(false);
    expect(msg([{ id: 1.5, lang: 'c', code: 'x' }])).toBe(false);
    expect(msg([])).toBe(false);
    expect(msg([{ id: 1, lang: 'c', code: 'x'.repeat(100_001) }])).toBe(false);
    expect(msg(Array.from({ length: 201 }, (_, id) => ({ id, lang: 'c', code: 'x' })))).toBe(false);
    expect(msg(Array.from({ length: 11 }, (_, id) => ({ id, lang: 'c', code: 'x'.repeat(100_000) })))).toBe(false);
  });
});

describe('size', () => {
  it('keeps the highlighter small, and the package under 2 MB', () => {
    // What the highlighter adds to the .vsix, compressed as the zip does it.
    let bytes = 0;
    for (const dir of ['grammars', 'themes']) {
      for (const f of readdirSync(join(out, dir))) bytes += deflateRawSync(readFileSync(join(out, dir, f)), { level: 9 }).length;
    }
    expect(bytes).toBeLessThan(260 * 1024);
    const vsix = join(repo, 'dist/sidestory.vsix');
    if (existsSync(vsix)) expect(statSync(vsix).size).toBeLessThan(2 * 1024 * 1024);
  });
});

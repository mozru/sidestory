// Code block colors in the panel (docs/HIGHLIGHT-PLAN.md): the test plays the extension host with the real
// tokenizer, real grammars in a fake installed extension (§10), and VS Code's default themes.
import { expect, type Page, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { diskReader, ONIG_WASM, writeGrammarExtension } from '../grammar-fixture.ts';
import { GrammarCatalog, loadGrammarSet } from '../../src/extension/highlight/catalog.ts';
import { type HighlightTheme, loadThemeChain, normalizeTheme, type ThemeKind } from '../../src/extension/highlight/theme.ts';
import { createOnigLib, Tokenizer } from '../../src/extension/highlight/tokenize.ts';
import type { FromWebview, ToWebview } from '../../src/shared/protocol.ts';
import { type ThemeName, THEMES, themeCss } from './themes.ts';

const THEMES_DIR = join(import.meta.dirname, '../../src/extension/highlight/fallback-themes');
let catalogOnce: Promise<GrammarCatalog> | undefined;
/** TypeScript, Python and HTML, as an installed extension would give them (once per test process). */
const catalog = () => (catalogOnce ??= writeGrammarExtension(mkdtempSync(join(tmpdir(), 'cx-hl-pw-')), ['typescript', 'python', 'html']).then((e) => new GrammarCatalog([e])));
const engine = createOnigLib([ONIG_WASM]);
/** Screenshots for people to look at (not compared). */
const SHOTS = process.env.CX_HL_SHOTS;

type Request = Extract<FromWebview, { type: 'highlight' }>;

/** Plays the host: tokenizes requests with the real tokenizer, or holds them until released. */
class FakeHost {
  readonly tokenizer = new Tokenizer(engine.then((e) => e.lib));
  theme!: HighlightTheme;
  hold = false;
  held: { m: Request; resolve: (r: ToWebview | null | Promise<ToWebview>) => void }[] = [];
  requests: Request[] = [];

  async setKind(kind: ThemeKind): Promise<void> {
    const root = pathToFileURL(THEMES_DIR).href;
    const reader = { read: async (u: string) => readFileSync(new URL(u), 'utf8'), inside: async () => true };
    this.theme = normalizeTheme((await loadThemeChain(`${root}/${kind}.json`, root, reader))!, kind, kind);
    this.tokenizer.setTheme(this.theme);
  }

  async answer(m: Request): Promise<ToWebview> {
    const c = await catalog();
    const blocks = [];
    for (const b of m.blocks) {
      const scope = c.scopeFor(b.lang);
      if (scope) await this.tokenizer.load(scope, (await loadGrammarSet(c, scope, diskReader))!);
      blocks.push({ id: b.id, runs: (scope && this.tokenizer.tokenize(b.code, scope, this.theme.key)?.runs) || null });
    }
    return { type: 'highlighted', theme: this.theme.key, palette: this.tokenizer.palette(this.theme.key), blocks };
  }

  async attach(page: Page): Promise<void> {
    await page.exposeFunction('__highlight', (m: Request) => {
      this.requests.push(m);
      if (!this.hold) return this.answer(m);
      return new Promise<ToWebview | null>((resolve) => this.held.push({ m, resolve }));
    });
  }

  /** Answers held requests (only the last, when `lastOnly`: as the real host does when a newer one replaces them). */
  release(lastOnly = false): void {
    const held = this.held.splice(0);
    held.forEach((h, i) => h.resolve(!lastOnly || i === held.length - 1 ? this.answer(h.m) : null));
  }
}

const anchors = (ids: string[]) => ids.map((id) => ({ id, file: 'x.ts', range: { start: 1, end: 2 }, state: 'exact' as const }));
const send = (page: Page, m: ToWebview) => page.evaluate((msg) => (window as unknown as { __send(m: unknown): void }).__send(msg), m);
const frame = (page: Page) => page.frameLocator('iframe.cx-content-frame');

const TS = 'const greeting: string = "hello";\n// says hello\nexport function hi() {\n  return greeting;\n}';
const PY = 'def f(x):\n    return x + 1  # one more';
const page1 = (ts = TS, prose = 'Some prose.') => `
<section data-explain-anchor="one"><h2>One</h2><p>${prose}</p>
<pre><code class="language-ts">${ts.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</code></pre></section>
<section data-explain-anchor="two"><h2>Two</h2>
<pre class="lang-py"><code>${PY}</code></pre>
<pre><code class="language-klingon">plain text</code></pre></section>`;

async function open(page: Page, host: FakeHost, html: string, theme: ThemeName = 'dark'): Promise<void> {
  await host.setKind(theme === 'light' ? 'light' : theme === 'hc' ? 'hc-dark' : theme === 'hc-light' ? 'hc-light' : 'dark');
  await host.attach(page);
  await page.goto('/test/webview/harness.html');
  await page.evaluate(([css, cls]) => {
    document.documentElement.setAttribute('style', css);
    document.body.className = cls;
  }, [themeCss(theme), THEMES[theme].bodyClass] as const);
  const base = await page.evaluate(() => `${location.origin}/fixtures/sample-workspace/.sidestory/bit-reader/`);
  await send(page, { type: 'init', title: 'Code', html, anchors: anchors(['one', 'two']), dir: 'file:///ws/.sidestory/code', base, trail: [{ name: 'code', title: 'Code' }] });
}

/** The computed color of the span containing `text` in the first block with that text. */
const colorOf = (page: Page, text: string) =>
  frame(page)
    .locator('pre span', { hasText: text })
    .first()
    .evaluate((el) => getComputedStyle(el).color);
const hex = (c: string) => `rgb(${[1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)).join(', ')})`;

for (const [theme, kw, str] of [['dark', '#ff7b72', '#a5d6ff'], ['light', '#cf222e', '#0a3069']] as const) {
  test(`colors code blocks in the theme's token colors (${theme})`, async ({ page }) => {
    const host = new FakeHost();
    await open(page, host, page1(), theme);
    await expect(frame(page).locator('pre code.language-ts span').first()).toBeAttached();
    expect(await colorOf(page, 'const')).toBe(hex(kw));
    expect(await colorOf(page, '"hello"')).toBe(hex(str));
    // The text is exactly what the author wrote.
    expect(await frame(page).locator('pre code.language-ts').textContent()).toBe(TS);
    // A language from the <pre>'s class; one no installed grammar knows stays plain (asked for once).
    await expect(frame(page).locator('pre.lang-py span').first()).toBeAttached();
    await expect(frame(page).locator('code.language-klingon span')).toHaveCount(0);
    expect(host.requests.flatMap((r) => r.blocks.map((b) => b.lang)).sort()).toEqual(['klingon', 'py', 'ts']);
    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      await frame(page).locator('section[data-explain-anchor="one"]').screenshot({ path: join(SHOTS, `highlight-${theme}.png`) });
    }
  });
}

test('HTML inside code stays text, and author markup inside code is left as written', async ({ page }) => {
  const host = new FakeHost();
  const html = `<section data-explain-anchor="one"><h2>One</h2>
<pre><code class="language-html">&lt;img src=x onerror="alert(1)"&gt;&lt;script&gt;alert(2)&lt;/script&gt;</code></pre>
<pre><code class="language-ts">const <mark>x</mark> = 1;</code></pre>
<pre><code class="language-ts" data-cx-hl="forged">let y = 2;</code></pre>
<pre data-cx-hl><code class="language-ts">let z = 3;</code></pre></section>`;
  await open(page, host, html);
  const htmlBlock = frame(page).locator('code.language-html');
  await expect(htmlBlock.locator('span').first()).toBeAttached();
  await expect(htmlBlock.locator('img, script')).toHaveCount(0);
  expect(await htmlBlock.textContent()).toBe('<img src=x onerror="alert(1)"><script>alert(2)</script>');
  // Author markup: untouched, never sent.
  await expect(frame(page).locator('code:has(mark)')).toHaveJSProperty('innerHTML', 'const <mark>x</mark> = 1;');
  expect(host.requests.flatMap((r) => r.blocks.map((b) => b.code))).not.toContain('const x = 1;');
  // An author's data-cx-hl is removed by the sanitizer (and the panel's own marker has a value nobody can guess).
  const marks = await frame(page).locator('[data-cx-hl]').evaluateAll((els) => els.map((e) => e.getAttribute('data-cx-hl')));
  expect(marks.length).toBe(3);
  expect(new Set(marks).size).toBe(1);
  expect(marks[0]).toMatch(/^[0-9a-f]{24}$/);
});

test('malformed results from the host are ignored', async ({ page }) => {
  const host = new FakeHost();
  host.hold = true;
  await open(page, host, page1());
  await expect.poll(() => host.held.length).toBe(1);
  const ids = host.held[0]!.m.blocks.map((b) => b.id);
  const tsId = host.held[0]!.m.blocks.find((b) => b.lang === 'ts')!.id;
  const bad = (runs: unknown, palette: unknown = [{}, { color: '#ff0000' }]) =>
    send(page, { type: 'highlighted', theme: 'x', palette, blocks: [{ id: tsId, runs }] } as ToWebview);
  await bad([TS.length + 1, 1]); // too long
  await bad([5, 1]); // too short
  await bad([TS.length, 7]); // style outside the palette
  await bad([TS.length / 2, 1, TS.length / 2, 1]); // not whole
  await bad([0, 1, TS.length, 1]); // empty run
  await page.waitForTimeout(100);
  await expect(frame(page).locator('code.language-ts span')).toHaveCount(0);
  // A palette entry that isn't a hex color gives no style.
  const pyId = host.held[0]!.m.blocks.find((b) => b.lang === 'py')!.id;
  expect(ids).toContain(pyId);
  await send(page, { type: 'highlighted', theme: 'y', palette: [{}, { color: 'red; background: url(x)' }, { color: 'expression(1)', font: 99 }], blocks: [{ id: pyId, runs: [PY.length, 1] }] } as ToWebview);
  await page.waitForTimeout(100);
  await expect(frame(page).locator('pre.lang-py span')).toHaveCount(0);
});

test('a live update leaves unchanged blocks alone and keeps colors above an edit', async ({ page }) => {
  const host = new FakeHost();
  await open(page, host, page1());
  await expect(frame(page).locator('pre.lang-py span').first()).toBeAttached();
  await expect(frame(page).locator('code.language-ts span').first()).toBeAttached();
  // Tag the live spans: an unchanged block keeps its very nodes.
  await frame(page).locator('pre.lang-py span').first().evaluate((el) => ((el as unknown as { __kept: boolean }).__kept = true));
  host.hold = true;
  host.requests = [];
  const edited = TS.replace('return greeting;', 'return greeting + "!";');
  await send(page, { type: 'content', title: 'Code', html: page1(edited) });
  await expect.poll(() => host.requests.length).toBe(1);
  expect(host.requests[0]!.blocks.map((b) => b.code)).toEqual([edited]); // only the edited block is asked for
  expect(await frame(page).locator('pre.lang-py span').first().evaluate((el) => (el as unknown as { __kept?: boolean }).__kept)).toBe(true);
  // Before the reply: the lines above the edit are still colored, the rest is plain text.
  expect(await colorOf(page, 'const')).toBe(hex('#ff7b72'));
  await expect(frame(page).locator('code.language-ts span', { hasText: '!' })).toHaveCount(0);
  expect(await frame(page).locator('code.language-ts').textContent()).toBe(edited);
  host.release();
  await expect(frame(page).locator('code.language-ts span', { hasText: '"!"' })).toBeAttached();
  // Highlighting never counts as the author's change.
  await expect(frame(page).locator('[data-explain-anchor="two"]')).not.toHaveClass(/cx-updated/);
});

test('a block is asked for once at a time; one whose request was dropped is asked for again', async ({ page }) => {
  const host = new FakeHost();
  await open(page, host, page1());
  await expect(frame(page).locator('code.language-ts span').first()).toBeAttached();
  host.hold = true;
  const edited = TS.replace('return greeting;', 'return greeting + "?";');
  await send(page, { type: 'content', title: 'Code', html: page1(edited) });
  await expect.poll(() => host.held.length).toBe(1);
  // Prose edited while that request waits: the block isn't sent again.
  for (const p of ['a', 'ab', 'abc']) await send(page, { type: 'content', title: 'Code', html: page1(edited, p) });
  await page.waitForTimeout(100);
  expect(host.held.length).toBe(1);
  // Another block edited: a newer request, which (as the real host does) replaces the waiting one.
  await send(page, { type: 'content', title: 'Code', html: page1(edited, 'abc').replace('return x + 1', 'return x + 2') });
  await expect.poll(() => host.held.length).toBe(2);
  expect(host.held[1]!.m.blocks.map((b) => b.lang)).toEqual(['py']);
  host.release(true); // the first request is never answered
  // Its reply tells the panel the first was dropped: the TypeScript block is asked for again, and completed.
  await expect.poll(() => host.held.length).toBe(1);
  host.hold = false;
  host.release();
  await expect(frame(page).locator('code.language-ts span', { hasText: '"?"' })).toBeAttached();
  await expect(frame(page).locator('pre.lang-py span', { hasText: '2' })).toBeAttached();
});

test('a stale reply (ids no longer pending) asks for nothing', async ({ page }) => {
  const host = new FakeHost();
  host.hold = true;
  await open(page, host, page1());
  await expect.poll(() => host.held.length).toBe(1);
  host.requests = [];
  await send(page, { type: 'highlighted', theme: host.theme.key, palette: [{}], blocks: [{ id: 999_999, runs: null }] });
  await send(page, { type: 'highlighted', theme: host.theme.key, palette: [{}], blocks: [{ id: 0, runs: null }] });
  await page.waitForTimeout(300);
  expect(host.requests.length).toBe(0);
  host.hold = false;
  host.release();
  await expect(frame(page).locator('code.language-ts span').first()).toBeAttached();
});

test('a block whose language is removed goes back to plain text', async ({ page }) => {
  const host = new FakeHost();
  await open(page, host, page1());
  await expect(frame(page).locator('pre.lang-py span').first()).toBeAttached();
  await send(page, { type: 'content', title: 'Code', html: page1().replace('class="lang-py"', 'class="lang-klingon"') });
  await expect(frame(page).locator('pre.lang-klingon span')).toHaveCount(0);
  expect(await frame(page).locator('pre.lang-klingon').textContent()).toBe(PY);
});

test('a click in a block (a caret, no selection) doesn’t hold back its colors', async ({ page }) => {
  const host = new FakeHost();
  await open(page, host, page1());
  await expect(frame(page).locator('code.language-ts span').first()).toBeAttached();
  await frame(page).locator('code.language-ts').click();
  await send(page, { type: 'content', title: 'Code', html: page1(TS.replace('hello', 'howdy')) });
  await expect(frame(page).locator('code.language-ts span', { hasText: '"howdy"' })).toBeAttached();
});

test('switching back to a theme whose palette was dropped asks again', async ({ page }) => {
  const host = new FakeHost();
  await open(page, host, page1());
  await expect(frame(page).locator('code.language-ts span').first()).toBeAttached();
  const first = host.theme.key;
  for (const kind of ['light', 'hc-dark', 'hc-light', 'light', 'dark'] as const) {
    await host.setKind(kind);
    // A distinct key per step, as customizations would make.
    host.theme = { ...host.theme, key: `${host.theme.key}-${Math.random().toString(36).slice(2, 6)}` };
    host.tokenizer.setTheme(host.theme);
    await send(page, { type: 'highlightTheme', theme: host.theme.key });
    await expect.poll(() => host.requests.at(-1)?.blocks.length).toBe(3);
    await page.waitForTimeout(50);
  }
  host.requests = [];
  await host.setKind('dark');
  expect(host.theme.key).toBe(first);
  await send(page, { type: 'highlightTheme', theme: first });
  await expect.poll(() => host.requests.length).toBeGreaterThan(0);
  await expect.poll(() => colorOf(page, 'const')).toBe(hex('#ff7b72'));
});

test('more code answered plain than the panel caches hold is not asked for again and again', async ({ page }) => {
  const host = new FakeHost();
  host.answer = async (m) => ({ type: 'highlighted', theme: 'k', palette: [{}], blocks: m.blocks.map((b) => ({ id: b.id, runs: null })) });
  // 14 blocks of ~92K characters (under the per-block caps): more than the panel's 1M-character caches.
  const big = (i: number) => `// ${i}\n${'let a = 1; // padding padding padding padding padding padding pad\n'.repeat(1400)}`;
  const html = `<section data-explain-anchor="one"><h2>One</h2>${Array.from({ length: 14 }, (_, i) => `<pre><code class="language-ts">${big(i)}</code></pre>`).join('')}</section>`;
  await open(page, host, html);
  await expect.poll(() => host.requests.reduce((n, r) => n + r.blocks.length, 0)).toBe(14);
  await page.waitForTimeout(1500);
  expect(host.requests.length).toBeLessThan(5);
});

test('an explainer with more blocks than one request holds gets them all colored', async ({ page }) => {
  const host = new FakeHost();
  const html = `<section data-explain-anchor="one"><h2>One</h2>${Array.from({ length: 230 }, (_, i) => `<pre><code class="language-py">x${i} = ${i}</code></pre>`).join('')}</section>`;
  await open(page, host, html);
  await expect.poll(() => frame(page).locator('pre code[data-cx-hl]').count()).toBe(230);
  expect(host.requests.length).toBe(2);
});

test('an edit inside code flags its section; highlighting alone never does', async ({ page }) => {
  const host = new FakeHost();
  await open(page, host, page1());
  await expect(frame(page).locator('code.language-ts span').first()).toBeAttached();
  await send(page, { type: 'content', title: 'Code', html: page1(TS, 'Some prose.') + ' ' });
  await page.waitForTimeout(100);
  await expect(frame(page).locator('[data-explain-anchor="one"]')).not.toHaveClass(/cx-updated/);
  await send(page, { type: 'content', title: 'Code', html: page1(TS.replace('hello', 'howdy')) });
  await expect(frame(page).locator('[data-explain-anchor="one"]')).toHaveClass(/cx-updated/);
  await expect(frame(page).locator('[data-explain-anchor="two"]')).not.toHaveClass(/cx-updated/);
});

test('a theme change asks again for every block and recolors in place', async ({ page }) => {
  const host = new FakeHost();
  await open(page, host, page1());
  await expect(frame(page).locator('code.language-ts span').first()).toBeAttached();
  expect(await colorOf(page, 'const')).toBe(hex('#ff7b72'));
  host.requests = [];
  host.hold = true;
  await host.setKind('light');
  await send(page, { type: 'highlightTheme', theme: host.theme.key });
  await expect.poll(() => host.held.length).toBe(1);
  expect(host.held[0]!.m.blocks.length).toBe(3);
  // Until the reply, the old colors stay (no flash of plain text), also through a render.
  await send(page, { type: 'content', title: 'Code', html: page1(TS, 'Typing during the switch.') });
  expect(await colorOf(page, 'const')).toBe(hex('#ff7b72'));
  host.release();
  await expect.poll(() => colorOf(page, 'const')).toBe(hex('#cf222e'));
});

test('live updates of an explainer with 40 colored blocks cost about what plain ones do', async ({ page }) => {
  const host = new FakeHost();
  const code = Array.from({ length: 30 }, (_, i) => `const v${i}: number = compute(${i}, "s${i}"); // line ${i}`).join('\n');
  const doc = (lang: string, prose: string) =>
    Array.from({ length: 40 }, (_, i) => `<section data-explain-anchor="s${i}"><h2>S${i}</h2><p>${i === 0 ? prose : 'Text.'}</p><pre><code class="language-${lang}">${code}</code></pre></section>`).join('\n');
  await host.setKind('dark');
  await host.attach(page);
  await page.goto('/test/webview/harness.html');
  const base = await page.evaluate(() => `${location.origin}/fixtures/sample-workspace/.sidestory/bit-reader/`);
  const ids = Array.from({ length: 40 }, (_, i) => `s${i}`);
  const time = async (lang: string) => {
    await send(page, { type: 'init', title: 'Code', html: doc(lang, 'start'), anchors: anchors(ids), dir: `file:///ws/.sidestory/${lang}`, base, trail: [{ name: lang, title: 'Code' }] });
    if (lang === 'ts') await expect(frame(page).locator('section[data-explain-anchor="s39"] pre span').first()).toBeAttached();
    await page.waitForTimeout(200);
    return page.evaluate(async (docs) => {
      const send = (window as unknown as { __send(m: unknown): void }).__send;
      const t0 = performance.now();
      for (const html of docs) {
        send({ type: 'content', title: 'Code', html });
        await new Promise((r) => setTimeout(r, 0));
      }
      return (performance.now() - t0) / docs.length;
    }, Array.from({ length: 20 }, (_, i) => doc(lang, `edit ${i}`)));
  };
  // Typing inside the first block: only that block is asked for, once per keystroke.
  const typing = async () => {
    host.requests = [];
    const docs = Array.from({ length: 20 }, (_, i) => doc('ts', 'start').replace(`compute(0,`, `compute(0${'1'.repeat(i + 1)},`));
    const ms = await page.evaluate(async (docs) => {
      const send = (window as unknown as { __send(m: unknown): void }).__send;
      const t0 = performance.now();
      for (const html of docs) {
        send({ type: 'content', title: 'Code', html });
        await new Promise((r) => setTimeout(r, 0));
      }
      return (performance.now() - t0) / docs.length;
    }, docs);
    await expect.poll(() => host.requests.length).toBeGreaterThanOrEqual(1);
    await page.waitForTimeout(200);
    expect(host.requests.every((r) => r.blocks.length === 1)).toBe(true);
    return ms;
  };
  const plain = await time('klingon');
  const colored = await time('ts');
  expect(await frame(page).locator('pre span').count()).toBeGreaterThan(4000);
  const inCode = await typing();
  console.log(`per update: plain ${plain.toFixed(1)} ms, colored ${colored.toFixed(1)} ms, typing in a colored block ${inCode.toFixed(1)} ms`);
  expect(colored).toBeLessThan(plain * 1.5 + 5);
  expect(inCode).toBeLessThan(plain * 2 + 10);
});

import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { AnchorView, FromWebview, ToWebview } from '../../src/shared/protocol.ts';
import { type ThemeName, THEMES, themeCss } from './themes.ts';

const FIXTURE = 'fixtures/sample-workspace/.explain/bit-reader';
const HTML = readFileSync(`${FIXTURE}/explainer.html`, 'utf8');
const MANIFEST = JSON.parse(readFileSync(`${FIXTURE}/manifest.json`, 'utf8')) as {
  title: string;
  anchors: Record<string, { file: string; range: [number, number]; color?: string }>;
};

function anchors(states: Record<string, AnchorView['state']> = {}): AnchorView[] {
  return Object.entries(MANIFEST.anchors).map(([id, a]) => ({
    id,
    file: a.file,
    range: states[id] === 'lost' ? null : { start: a.range[0], end: a.range[1] },
    state: states[id] ?? 'exact',
    colorVar: a.color ? `--vscode-${a.color.replace('.', '-')}` : undefined,
  }));
}

const DIR = 'file:///ws/.explain/bit-reader';
const base = (page: Page, name = 'bit-reader') => page.evaluate((n) => `${location.origin}/fixtures/sample-workspace/.explain/${n}/`, name);
const ROOT_TRAIL = [{ name: 'bit-reader', title: MANIFEST.title }];

async function open(page: Page, opts: { theme?: ThemeName; html?: string; active?: string } = {}): Promise<void> {
  const theme = opts.theme ?? 'dark';
  await page.goto('/test/webview/harness.html');
  await page.evaluate(([css, cls]) => {
    document.documentElement.setAttribute('style', css);
    document.body.className = cls;
  }, [themeCss(theme), THEMES[theme].bodyClass] as const);
  await expect.poll(() => posted(page)).toContainEqual({ type: 'ready' });
  await send(page, { type: 'init', title: MANIFEST.title, html: opts.html ?? HTML, anchors: anchors(), active: opts.active, dir: DIR, base: await base(page), trail: ROOT_TRAIL });
}

const send = (page: Page, m: ToWebview) => page.evaluate((msg) => (window as unknown as { __send(m: unknown): void }).__send(msg), m);
const posted = (page: Page) => page.evaluate(() => (window as unknown as { __posted: FromWebview[] }).__posted);
const clearPosted = (page: Page) => page.evaluate(() => ((window as unknown as { __posted: FromWebview[] }).__posted = []));
const frame = (page: Page) => page.frameLocator('iframe.cx-content-frame');
const section = (page: Page, id: string) => frame(page).locator(`[data-explain-anchor="${id}"]`);
/** A section's top in the panel's coordinates (the frame itself doesn't scroll). */
const panelTop = (page: Page, id: string) =>
  page.evaluate((anchor) => {
    const f = document.querySelector<HTMLIFrameElement>('iframe.cx-content-frame')!;
    const el = f.contentDocument!.querySelector(`[data-explain-anchor="${anchor}"]`)!;
    return f.getBoundingClientRect().top + el.getBoundingClientRect().top;
  }, id);

test('renders the title, the steps and the sections', async ({ page }) => {
  await open(page);
  await expect(page.locator('.cx-title')).toHaveText(MANIFEST.title);
  for (const [i, name] of ['Interface', 'State', 'Handshakes', 'Consume', 'Refill'].entries()) {
    await expect(page.getByRole('button', { name: `Step ${i + 1}: ${name}`, exact: true })).toBeVisible();
  }
  await expect(page.locator('.cx-status')).toHaveText('Linked');
  await expect(section(page, 'refill')).toBeAttached();
  await expect(page.locator('.cx-position')).toHaveText('Step 1 of 5');
});

test('clicking a step activates it and reveals its code', async ({ page }) => {
  await open(page);
  await clearPosted(page);
  await page.locator('.cx-step', { hasText: 'Handshakes' }).click();
  await expect(page.locator('.cx-step', { hasText: 'Handshakes' })).toHaveAttribute('aria-current', 'step');
  await expect(section(page, 'handshakes')).toHaveClass(/cx-active/);
  expect(await posted(page)).toContainEqual({ type: 'focusAnchor', anchorId: 'handshakes', source: 'step' });
  await expect(page.locator('.cx-position')).toHaveText('Step 3 of 5');
});

test('choosing the step that is already current still reveals its code', async ({ page }) => {
  await open(page);
  await expect(page.locator('.cx-position')).toHaveText('Step 1 of 5');
  await clearPosted(page);
  await page.locator('.cx-step').first().click();
  expect(await posted(page)).toContainEqual({ type: 'focusAnchor', anchorId: 'interface', source: 'step' });
});

test('the editor cursor moves the page without echoing back', async ({ page }) => {
  await open(page);
  await clearPosted(page);
  await send(page, { type: 'syncTo', anchorId: 'refill' });
  await expect(section(page, 'refill')).toHaveClass(/cx-active/);
  await expect(section(page, 'refill')).toBeInViewport();
  await page.waitForTimeout(400);
  expect((await posted(page)).filter((m) => m.type === 'focusAnchor')).toEqual([]);
});

test('scrolling to a section tells the editor once', async ({ page }) => {
  await open(page);
  await clearPosted(page);
  await page.locator('.cx-scroll').hover();
  await page.mouse.wheel(0, 700);
  await expect.poll(async () => (await posted(page)).filter((m) => m.type === 'focusAnchor').length).toBeGreaterThan(0);
  const last = (await posted(page)).filter((m) => m.type === 'focusAnchor').at(-1);
  expect(last).toMatchObject({ source: 'scroll' });
  await expect(section(page, (last as { anchorId: string }).anchorId)).toHaveClass(/cx-active/);
});

test('the cursor does not yank the page while the reader is scrolling', async ({ page }) => {
  await open(page);
  await page.locator('.cx-scroll').hover();
  await page.mouse.wheel(0, 200);
  await expect.poll(() => page.locator('.cx-scroll').evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await send(page, { type: 'syncTo', anchorId: 'refill' });
  await expect(page.locator('.cx-pill')).toBeVisible();
  await expect(page.locator('.cx-pill')).toContainText('Refill');
  await page.locator('.cx-pill').click();
  await expect(section(page, 'refill')).toBeInViewport();
});

test('an edit above the reader keeps their place and flags the changed section', async ({ page }) => {
  await open(page);
  await page.locator('.cx-step', { hasText: 'Consume' }).click();
  await page.waitForTimeout(800);
  const before = await panelTop(page, 'consume');
  const edited = HTML.replace('<h2>The interface</h2>', '<h2>The interface</h2><p>A new paragraph.</p><p>And another.</p><p>And a third, to push everything down.</p>');
  await send(page, { type: 'content', title: MANIFEST.title, html: edited });
  const after = await panelTop(page, 'consume');
  expect(Math.abs(after - before)).toBeLessThan(2);
  await expect(section(page, 'interface')).toHaveClass(/cx-updated/);
  await expect(section(page, 'consume')).not.toHaveClass(/cx-updated/);
  await expect(section(page, 'consume')).toHaveClass(/cx-active/);
  await expect(page.locator('[aria-live]')).toHaveText('Interface updated');
});

test('a content update keeps the step picker focused', async ({ page }) => {
  await page.setViewportSize({ width: 340, height: 900 });
  await open(page);
  await page.locator('.cx-step-select').focus();
  await send(page, { type: 'content', title: 'Renamed', html: HTML.replace('Three one-line rules', 'Three rules') });
  await expect(page.locator('.cx-step-select')).toBeFocused();
  await expect(page.locator('.cx-title')).toHaveText('Renamed');
});

test('anchor states show on sections and in the header', async ({ page }) => {
  await open(page);
  await send(page, { type: 'anchors', anchors: anchors({ consume: 'stale', refill: 'lost', state: 'changed', interface: 'moved' }) });
  await expect(section(page, 'consume')).toHaveAttribute('data-cx-label', 'Out of date');
  await expect(section(page, 'refill')).toHaveAttribute('data-cx-label', 'Code not found');
  await expect(section(page, 'state')).toHaveAttribute('data-cx-label', 'Code changed');
  await expect(section(page, 'interface')).toHaveAttribute('data-cx-label', '');
  await expect(page.locator('.cx-status')).toHaveText('1 out of date · 1 not found');
});

test('errors show in a banner and keep the last good content', async ({ page }) => {
  await open(page);
  await send(page, { type: 'error', message: 'manifest.json: anchors: bad' });
  await expect(page.locator('.cx-banner-text')).toHaveText('manifest.json: anchors: bad');
  await expect(section(page, 'refill')).toBeAttached();
  await send(page, { type: 'error', message: null });
  await expect(page.locator('.cx-banner')).toBeHidden();
});

test('explainer HTML cannot run scripts, phone home or navigate', async ({ page }) => {
  await open(page, {
    html: `<section data-explain-anchor="state">
      <script>window.__pwned = 1</script>
      <img id="remote" src="https://example.com/x.png">
      <img id="local" src="assets/diagram.png" onerror="window.__pwned = 2">
      <a id="js" href="javascript:window.__pwned=3">x</a>
      <iframe src="https://example.com"></iframe>
      <meta http-equiv="refresh" content="0;url=https://example.com">
    </section>`,
  });
  const host = frame(page).locator('body');
  await expect(host.locator('#remote')).not.toHaveAttribute('src', /.+/);
  await expect(host.locator('#local')).not.toHaveAttribute('src', /.+/); // missing file: nothing to load
  await expect(host.locator('#local')).not.toHaveAttribute('onerror', /.*/);
  await expect(host.locator('#js')).not.toHaveAttribute('href', /.*/);
  await expect(host.locator('iframe, meta, script')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
});

test('the sanitizer refuses every way out of the explainer folder', async ({ page }) => {
  await open(page, {
    html: `<section data-explain-anchor="state">
      <a id="vb" href="vbscript:x">x</a>
      <a id="datahtml" href="data:text/html,<script>1</script>">x</a>
      <img id="proto" src="//example.com/x.png">
      <img id="up" src="../../secret.png">
      <img id="enc" src="%2e%2e/%2e%2e/secret.png">
      <img id="set" srcset="ok.png 1x, https://example.com/x.png 2x">
      <svg><use id="use" href="#frag"></use><image id="svgimg" href="https://example.com/x.png"></image><script>window.__pwned = 4</script></svg>
      <link id="remote-css" rel="stylesheet" href="https://example.com/x.css">
      <base href="https://example.com/">
      <form action="https://example.com"><input id="field"></form>
      <div id="data-svg" style="background:url(data:image/svg+xml,x)"></div>
    </section>`,
  });
  const host = frame(page).locator('body');
  for (const id of ['vb', 'datahtml']) await expect(host.locator(`#${id}`)).not.toHaveAttribute('href', /.*/);
  for (const id of ['proto', 'up', 'enc']) await expect(host.locator(`#${id}`)).not.toHaveAttribute('src', /.*/);
  await expect(host.locator('#set')).not.toHaveAttribute('srcset', /.*/);
  await expect(host.locator('#use')).toHaveAttribute('href', '#frag');
  await expect(host.locator('#svgimg')).not.toHaveAttribute('href', /.*/);
  await expect(host.locator('link, base, form, script')).toHaveCount(0);
  await expect(frame(page).locator('head link')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
});

test('explainer CSS cannot cover the panel controls', async ({ page }) => {
  await open(page, {
    html: `<style>:host{position:fixed!important;inset:0!important;z-index:2147483647!important;contain:none!important;transform:none!important}
      .cover{position:fixed;inset:0;background:red}</style>
      <section data-explain-anchor="state"><div class="cover"></div><div id="pop" popover>covering</div><button popovertarget="pop">x</button></section>`,
  });
  const hit = await page.evaluate(() => {
    const t = document.querySelector('.cx-title')!.getBoundingClientRect();
    return (document.elementFromPoint(t.left + 5, t.top + 5) as HTMLElement | null)?.className;
  });
  expect(hit).toBe('cx-title');
  await expect(frame(page).locator('[popover], [popovertarget]')).toHaveCount(0);
});

test('relative URLs in explainer CSS point at the explainer folder; remote ones are dropped', async ({ page }) => {
  await open(page, {
    html: `<style>@import url(https://example.com/x.css); .a{background:url(assets/dot.svg)} .b{background:url("https://example.com/b.png")} .c{background:url(missing.png)}</style>
      <section data-explain-anchor="state"><div id="inline" style="background-image:url('assets/dot.svg')"></div><img id="img" src="assets/dot.svg" alt="dot">
      <svg><a id="svglink" href="#ok"><set attributeName="href" to="javascript:alert(1)"/></a></svg></section>`,
  });
  const css = await frame(page).locator('body').evaluate((body) => [...body.ownerDocument.querySelectorAll('style')].map((s) => s.textContent).join('\n'));
  // Local files reach the sandboxed frame as blob: URLs; missing and remote ones load nothing.
  expect(css).toMatch(/\.a\{background:url\("blob:/);
  expect(css).toMatch(/\.c\{background:none\}/);
  expect(css).not.toContain('example.com');
  await expect(frame(page).locator('#inline')).toHaveAttribute('style', /url\("blob:/);
  await expect(frame(page).locator('#img')).toHaveAttribute('src', /^blob:/);
  await expect.poll(() => frame(page).locator('#img').evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(16);
  await expect(frame(page).locator('set')).toHaveCount(0);
});

test('links never navigate the content: web links go to VS Code, page links scroll', async ({ page }) => {
  await open(page, {
    html: HTML.replace('<h2>The interface</h2>', '<h2>The interface</h2><p><a id="ext" href="https://example.com/docs">docs</a></p>'),
  });
  await clearPosted(page);
  await frame(page).locator('#ext').click();
  expect(await posted(page)).toContainEqual({ type: 'openExternal', url: 'https://example.com/docs' });
  await expect(section(page, 'refill')).toBeAttached(); // the content is still there
  await send(page, { type: 'content', title: 'still alive', html: HTML });
  await expect(page.locator('.cx-title')).toHaveText('still alive');
  await send(page, { type: 'content', title: 't', html: HTML.replace('<h2>The interface</h2>', '<h2>The interface</h2><p><a id="jump2" href="#cx-a-refill">to refill</a></p>') });
  await frame(page).locator('#jump2').click();
  await expect(section(page, 'refill')).toBeInViewport();
});

test('links to files in the explainer folder open in VS Code; page links activate their section', async ({ page }) => {
  await open(page, {
    html: HTML.replace('<h2>The interface</h2>', '<h2>The interface</h2><p><a id="file" href="notes/more.html">more</a> <a id="jump" href="#cx-a-refill">refill</a></p>'),
  });
  await clearPosted(page);
  await frame(page).locator('#file').click();
  expect(await posted(page)).toContainEqual({ type: 'openFile', path: 'notes/more.html' });
  expect((await posted(page)).some((m) => m.type === 'openExternal')).toBe(false);
  await clearPosted(page);
  await frame(page).locator('#jump').click();
  await expect(section(page, 'refill')).toHaveClass(/cx-active/);
  await page.waitForTimeout(1200);
  const focus = (await posted(page)).filter((m) => m.type === 'focusAnchor');
  expect(focus).toEqual([{ type: 'focusAnchor', anchorId: 'refill', source: 'click' }]);
});

test('Space on a control inside the content operates the control', async ({ page }) => {
  await open(page, { html: '<section data-explain-anchor="state"><details><summary id="sum">More</summary><p>hidden</p></details></section>' });
  await frame(page).locator('#sum').focus();
  await page.keyboard.press(' ');
  await expect(frame(page).locator('details')).toHaveAttribute('open', '');
});

test('content that names elements after document methods cannot break later updates', async ({ page }) => {
  await open(page, { html: '<section data-explain-anchor="state"><img name="createElement"><img name="importNode"><img name="body"><form name="x"></form><p>one</p></section>' });
  await send(page, { type: 'content', title: 'second', html: '<section data-explain-anchor="state"><p>two</p></section>' });
  await expect(section(page, 'state')).toHaveText('two');
});

test('the content frame shrinks when content is removed', async ({ page }) => {
  await open(page);
  const tall = await page.locator('iframe.cx-content-frame').evaluate((f) => f.getBoundingClientRect().height);
  await send(page, { type: 'content', title: 't', html: '<section data-explain-anchor="state"><p>short</p></section>' });
  const short = await page.locator('iframe.cx-content-frame').evaluate((f) => f.getBoundingClientRect().height);
  expect(short).toBeLessThan(tall / 2);
});

test('inline references jump the editor', async ({ page }) => {
  await open(page);
  await clearPosted(page);
  await frame(page).locator('[data-explain-ref="state"]').click();
  expect(await posted(page)).toContainEqual({ type: 'openRef', anchorId: 'state' });
});

test('clicking inside a section focuses its code', async ({ page }) => {
  await open(page);
  await clearPosted(page);
  await section(page, 'handshakes').locator('.rule').first().click();
  expect(await posted(page)).toContainEqual({ type: 'focusAnchor', anchorId: 'handshakes', source: 'click' });
});

test('J and K step through sections; the editor command does too', async ({ page }) => {
  await open(page);
  await page.locator('.cx-scroll').click({ position: { x: 5, y: 5 } });
  await expect(page.locator('.cx-position')).toHaveText('Step 1 of 5');
  await page.keyboard.press('j');
  await page.keyboard.press('j');
  await expect(page.locator('.cx-position')).toHaveText('Step 3 of 5');
  await page.keyboard.press('k');
  await expect(page.locator('.cx-position')).toHaveText('Step 2 of 5');
  await send(page, { type: 'navigate', delta: 1 });
  await expect(page.locator('.cx-position')).toHaveText('Step 3 of 5');
});

test('narrow panes get a step picker instead of tabs', async ({ page }) => {
  await page.setViewportSize({ width: 340, height: 900 });
  await open(page);
  await expect(page.locator('.cx-steps')).toBeHidden();
  await expect(page.locator('.cx-step-select')).toBeVisible();
  await page.locator('.cx-step-select').selectOption('refill');
  await expect(section(page, 'refill')).toHaveClass(/cx-active/);
});

test('the reader comes back to the same place after the panel is rebuilt', async ({ page }) => {
  await open(page);
  await page.locator('.cx-step', { hasText: 'Consume' }).click();
  await page.waitForTimeout(900);
  const saved = await page.evaluate(() => (window as unknown as { __state: unknown }).__state);
  expect(saved).toMatchObject({ active: 'consume', scroll: { anchor: expect.any(String) } });
  // Rebuild: a new page with the saved state, as VS Code does when a hidden panel is shown again.
  await page.goto('/test/webview/harness.html');
  await page.evaluate((s) => ((window as unknown as { __state: unknown }).__state = s), saved);
  await page.reload();
  await page.evaluate((s) => ((window as unknown as { __state: unknown }).__state = s), saved);
});

for (const theme of ['dark', 'light', 'hc'] as const) {
  test(`no accessibility violations (${theme})`, async ({ page }) => {
    await open(page, { theme });
    await page.locator('.cx-step', { hasText: 'State' }).click();
    await send(page, { type: 'anchors', anchors: anchors({ consume: 'stale', refill: 'lost', handshakes: 'changed' }) });
    // Axe can't run inside the content frame (it runs no scripts), so scan the panel without it,
    // then scan a copy of the frame's document as an ordinary page.
    const chrome = await new AxeBuilder({ page }).exclude('iframe.cx-content-frame').analyze();
    const html = await frame(page).locator('html').evaluate((el) => el.outerHTML);
    const copy = await page.context().newPage();
    await copy.goto('/test/webview/harness.html'); // same origin, so the content stylesheet loads
    await copy.setContent(`<!doctype html>${html}`, { waitUntil: 'load' });
    // The frame is transparent over the panel; give the copy the panel's background.
    await copy.addStyleTag({ content: 'html { background: var(--vscode-editor-background); }' });
    // Page-level rules don't apply to a fragment shown inside the panel.
    const body = await new AxeBuilder({ page: copy }).disableRules(['document-title', 'landmark-one-main', 'page-has-heading-one', 'region']).analyze();
    const list = (r: typeof chrome) => r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
    expect([...list(chrome), ...list(body)]).toEqual([]);
  });
}

for (const theme of ['dark', 'light', 'hc'] as const) {
  for (const width of [340, 600, 1000]) {
    test(`screenshot ${theme} ${width}px`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 });
      await open(page, { theme });
      await send(page, { type: 'anchors', anchors: anchors({ consume: 'stale' }) });
      await page.locator(width < 420 ? '.cx-step-select' : '.cx-step >> nth=1').first().evaluate((el) => el);
      if (width < 420) await page.locator('.cx-step-select').selectOption('state');
      else await page.locator('.cx-step', { hasText: 'State' }).click();
      await page.waitForTimeout(700);
      await page.screenshot({ path: info.outputPath(`${theme}-${width}.png`) });
    });
  }
}

test('an asset edited on disk updates live; query variants of one file are fetched once', async ({ page }) => {
  await open(page, { html: '<section data-explain-anchor="state">' + Array.from({ length: 50 }, (_, i) => `<img alt="" src="assets/dot.svg?v=${i}">`).join('') + '</section>' });
  await expect(frame(page).locator('img').first()).toHaveAttribute('src', /^blob:/);
  const requests = async () => (await posted(page)).filter((m) => m.type === 'requestAsset').length;
  expect(await requests()).toBe(1);
  const before = await frame(page).locator('img').first().getAttribute('src');
  await send(page, { type: 'assetsChanged', paths: ['assets/dot.svg'] });
  await expect.poll(requests).toBe(2);
  await expect(frame(page).locator('img').first()).not.toHaveAttribute('src', before!);
  await expect(frame(page).locator('img').first()).toHaveAttribute('src', /^blob:/);
});

test('a content update that arrives while the first render loads its assets is not lost', async ({ page }) => {
  await page.goto('/test/webview/harness.html');
  // Delay asset replies so the first render is still waiting when the update arrives.
  await page.evaluate(() => {
    const w = window as unknown as { __send(m: unknown): void };
    const real = w.__send;
    w.__send = (m: unknown) => ((m as { type: string }).type === 'asset' ? setTimeout(() => real(m), 600) : real(m));
  });
  await expect.poll(() => posted(page)).toContainEqual({ type: 'ready' });
  await send(page, { type: 'init', title: 'first', html: '<section data-explain-anchor="state"><h2>old</h2><img alt="" src="assets/dot.svg"></section>', anchors: anchors(), dir: DIR, base: await base(page), trail: ROOT_TRAIL });
  await page.waitForTimeout(100);
  await send(page, { type: 'content', title: 'second', html: '<section data-explain-anchor="state"><h2>EDITED DURING INIT</h2></section>' });
  await expect(section(page, 'state').locator('h2')).toHaveText('EDITED DURING INIT');
  await expect(page.locator('.cx-title')).toHaveText('second');
  await expect(page.locator('.cx-position')).toHaveText(/Step \d of/);
});

test('hostile CSS can neither stall the panel nor sneak URLs past the rewriter', async ({ page }) => {
  await open(page, {
    html: `<style>.a{background:${'url('.repeat(100_000)}}</style>
      <style>.b{background:\\75 rl(https://example.com/x.png)} @\\69mport "https://example.com/y.css"; .c{background:image-set("https://example.com/z.png" 1x)}
        .d{background:\\u\\r\\l(https://example.com/w.png)} @\\i\\m\\p\\o\\r\\t "https://example.com/v.css";</style>
      <section data-explain-anchor="state"><h2>still here</h2></section>`,
  });
  await expect(section(page, 'state').locator('h2')).toHaveText('still here', { timeout: 1000 });
  const css = await frame(page).locator('body').evaluate((body) => [...body.ownerDocument.querySelectorAll('style')].map((s) => s.textContent).join('\n'));
  expect(css).not.toContain('example.com/x.png');
  expect(css).not.toMatch(/@import/i);
  expect(css).toContain('cx-blocked(');
});

// ---- moving between explainers ----

const OVERVIEW = `<section data-explain-anchor="interface"><h2>Interface</h2><p>Top level.</p>
  <div data-explain-detail="retry-backoff"><p>The retry logic has its own walkthrough.</p></div></section>
  <section data-explain-anchor="state"><h2>State</h2><p>More.</p><div data-explain-detail="no-such-thing"></div></section>`;

test('a detail can be peeked at in place or dived into', async ({ page }) => {
  await open(page, { html: OVERVIEW });
  await expect.poll(() => posted(page)).toContainEqual({ type: 'describe', names: ['retry-backoff', 'no-such-thing'] });
  await send(page, {
    type: 'details',
    items: [
      { name: 'retry-backoff', found: true, title: 'Retry with backoff', summary: 'Waits longer after each failure.', steps: 4 },
      { name: 'no-such-thing', found: false, title: '', summary: '', steps: 0 },
    ],
  });
  const detail = frame(page).locator('[data-explain-detail="retry-backoff"] .cx-detail');
  const peek = detail.locator('.cx-peek');
  await expect(peek).toHaveText('▸ Retry with backoff in brief');
  await expect(detail.locator('.cx-detail-steps')).toHaveText('4 steps');
  await expect(detail.locator('.cx-peek-body')).toBeHidden();
  await peek.click();
  await expect(peek).toHaveAttribute('aria-expanded', 'true');
  await expect(detail.locator('.cx-peek-body')).toHaveText('Waits longer after each failure.');
  // Peeking is local: it doesn't move the reader or the editor.
  await expect(page.locator('.cx-position')).toHaveText('Step 1 of 2');
  // An edit to the explainer keeps the peek open.
  await send(page, { type: 'content', title: MANIFEST.title, html: OVERVIEW.replace('Top level.', 'Top level, edited.') });
  await expect(frame(page).getByText('Top level, edited.')).toBeVisible();
  await expect(detail.locator('.cx-peek-body')).toBeVisible();
  await expect(frame(page).locator('[data-explain-detail="no-such-thing"] .cx-dive')).toBeDisabled();
  await clearPosted(page);
  await detail.locator('.cx-dive').click();
  expect(await posted(page)).toContainEqual({ type: 'dive', name: 'retry-backoff' });
});

test('the trail shows where the reader is and leads back up', async ({ page }) => {
  await open(page);
  await expect(page.locator('.cx-trail')).toBeHidden();
  await expect(page.locator('.cx-back')).toBeHidden();
  await send(page, {
    type: 'init',
    title: 'Retry with backoff',
    html: '<section data-explain-anchor="loop"><h2>Loop</h2></section>',
    anchors: [],
    dir: 'file:///ws/.explain/retry-backoff',
    base: await base(page, 'retry-backoff'),
    trail: [...ROOT_TRAIL, { name: 'retry-backoff', title: 'Retry with backoff' }],
  });
  const trail = page.getByRole('navigation', { name: 'Explainer path' });
  await expect(trail).toBeVisible();
  await expect(trail.locator('[aria-current="page"]')).toHaveText('Retry with backoff');
  await clearPosted(page);
  await trail.getByRole('button', { name: MANIFEST.title }).click();
  await page.locator('.cx-back').click();
  await page.locator('.cx-scroll').focus();
  await page.keyboard.press('Escape');
  expect(await posted(page)).toEqual([
    { type: 'goTo', depth: 0 },
    { type: 'goTo', depth: 0 },
    { type: 'goTo', depth: 0 },
  ]);
});

test('going back returns to the place the reader left', async ({ page }) => {
  await open(page);
  await page.locator('.cx-step', { hasText: 'Handshakes' }).click();
  await expect(page.locator('.cx-position')).toHaveText('Step 3 of 5');
  const child = { anchors: [], dir: 'file:///ws/.explain/retry-backoff', base: await base(page, 'retry-backoff') };
  await send(page, { type: 'init', title: 'Child', html: '<section data-explain-anchor="a"><h2>A</h2></section><section data-explain-anchor="b"><h2>B</h2></section>', ...child, trail: [...ROOT_TRAIL, { name: 'retry-backoff', title: 'Child' }] });
  await expect(page.locator('.cx-title')).toHaveText('Child');
  await expect(page.locator('.cx-position')).toHaveText('Step 1 of 2');
  // Coming back, assets resolve against the parent's folder again.
  await send(page, { type: 'init', title: MANIFEST.title, html: HTML + '<img alt="" src="assets/dot.svg">', anchors: anchors(), dir: DIR, base: await base(page), trail: ROOT_TRAIL });
  await expect(page.locator('.cx-position')).toHaveText('Step 3 of 5');
  await expect(page.locator('.cx-trail')).toBeHidden();
  await expect(frame(page).locator('img').first()).toHaveAttribute('src', /^blob:/);
});

test('the cursor in code a detail covers offers to dive into it', async ({ page }) => {
  await open(page);
  await send(page, { type: 'childHint', name: 'retry-backoff', title: 'Retry with backoff' });
  await expect(page.locator('.cx-pill-show')).toHaveText('Cursor is in Retry with backoff · Dive');
  await clearPosted(page);
  await page.locator('.cx-pill-show').click();
  expect(await posted(page)).toEqual([{ type: 'dive', name: 'retry-backoff' }]);
  await expect(page.locator('.cx-pill')).toBeHidden();
});

// ---- user-testing fixes ----

test('switches, tabs and open details survive an edit elsewhere in the explainer', async ({ page }) => {
  const doc = (word: string, checked = '') => `
    <section data-explain-anchor="interface"><h2>Interface ${word}</h2></section>
    <section data-explain-anchor="state"><h2>State</h2>
      <input type="checkbox" id="sw" ${checked}><label for="sw">lead</label>
      <input type="radio" name="t" id="t1" checked><input type="radio" name="t" id="t2">
      <input type="text" id="tx" value="">
      <details id="d"><summary>Q</summary>A</details></section>`;
  await open(page, { html: doc('one') });
  const f = frame(page);
  await f.locator('#sw').check();
  await f.locator('#t2').check();
  await f.locator('#tx').fill('typed');
  await f.locator('#d summary').click();
  await page.locator('.cx-step').first().focus(); // nothing in the content has focus
  await send(page, { type: 'content', title: 't', html: doc('two') });
  await expect(f.getByText('Interface two')).toBeVisible();
  await expect(f.locator('#sw')).toBeChecked();
  await expect(f.locator('#t2')).toBeChecked();
  await expect(f.locator('#tx')).toHaveValue('typed');
  await expect(f.locator('#d')).toHaveAttribute('open', '');
  // The author changing that control's own default still wins.
  await f.locator('#sw').uncheck();
  await page.locator('.cx-step').first().focus(); // a focused control keeps what the reader set
  await send(page, { type: 'content', title: 't', html: doc('three', 'checked') });
  await expect(f.getByText('Interface three')).toBeVisible();
  await expect(f.locator('#sw')).toBeChecked();
  // An open <details> doesn't count as an edit to its section.
  await expect(section(page, 'state')).not.toHaveClass(/cx-updated/);
});

test('in-page links make CSS :target work', async ({ page }) => {
  await open(page, {
    html: `<style>.pop{display:none}.pop:target{display:block}</style>
      <section data-explain-anchor="interface"><h2>I</h2><a href="#p2">show</a><div class="pop" id="p2">popped</div></section>`,
  });
  await expect(frame(page).getByText('popped')).toBeHidden();
  await frame(page).getByRole('link', { name: 'show' }).click();
  await expect(frame(page).getByText('popped')).toBeVisible();
  await expect(page.locator('.cx-content-frame')).toBeAttached(); // the frame wasn't navigated away
});

test('many steps in a narrow panel use the picker rather than one-letter tabs', async ({ page }) => {
  const html = Array.from({ length: 10 }, (_, i) => `<section data-explain-anchor="s${i}"><h2>Section number ${i}</h2></section>`).join('');
  await page.setViewportSize({ width: 640, height: 700 });
  await open(page, { html });
  await expect(page.locator('.cx-step-select')).toBeVisible();
  await expect(page.locator('.cx-steps')).toBeHidden();
  await page.setViewportSize({ width: 1600, height: 700 });
  await expect(page.locator('.cx-steps')).toBeVisible();
});

test('the step bar is one Tab stop; arrow keys move along it', async ({ page }) => {
  await open(page);
  await page.locator('.cx-step').nth(0).focus();
  await expect(page.locator('.cx-step[tabindex="0"]')).toHaveCount(1);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.cx-step').nth(1)).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.locator('.cx-step').nth(4)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('.cx-step:focus')).toHaveCount(0);
});

test('a detail naming an explainer already on the trail goes back up to it', async ({ page }) => {
  await page.goto('/test/webview/harness.html');
  await expect.poll(() => posted(page)).toContainEqual({ type: 'ready' });
  await send(page, {
    type: 'init',
    title: 'Child',
    html: '<section data-explain-anchor="a"><h2>A</h2><div data-explain-detail="bit-reader"></div><div data-explain-detail="retry-backoff"></div></section>',
    anchors: [],
    dir: 'file:///ws/.explain/retry-backoff',
    base: await base(page, 'retry-backoff'),
    trail: [...ROOT_TRAIL, { name: 'retry-backoff', title: 'Child' }],
  });
  await send(page, { type: 'details', items: [{ name: 'bit-reader', found: true, title: 'Root', summary: '', steps: 5 }, { name: 'retry-backoff', found: true, title: 'Child', summary: '', steps: 1 }] });
  const up = frame(page).locator('[data-explain-detail="bit-reader"] .cx-dive');
  await expect(up).toHaveText('‹ Back to Root');
  await expect(frame(page).locator('[data-explain-detail="retry-backoff"] .cx-dive')).toBeDisabled();
  await clearPosted(page);
  await up.click();
  expect(await posted(page)).toEqual([{ type: 'goTo', depth: 0 }]);
});

test('author look-alike detail controls neither break rendering nor dive', async ({ page }) => {
  await open(page, { html: '<section data-explain-anchor="interface"><h2>I</h2><div data-explain-detail="retry-backoff"><div class="cx-detail"><button class="cx-dive">fake</button></div></div></section>' });
  await expect(page.locator('.cx-position')).toHaveText('Step 1 of 1');
  await clearPosted(page);
  await frame(page).getByRole('button', { name: 'fake' }).click();
  expect((await posted(page)).filter((m) => m.type === 'dive')).toEqual([]);
});

test('CSS the rewriter passes on loads no remote url(), as the browser itself parses it', async ({ page }) => {
  await page.goto('/test/webview/harness.html');
  await expect.poll(() => posted(page)).toContainEqual({ type: 'ready' });
  const cases = [
    "/* ' */ a{background-image:url(https://evil.example/a.png)} /* ' */",
    "\\/* ' */ a{background:url(https://evil.example/c.png)} /* ' */",
    "a{x:/\\* ' */ url(https://evil.example/c.png) /* ' */}",
    "/ /**/* ' */ a{background:url(https://evil.example/d.png)} /* ' */",
    'a{background:url("x\\") ;background:url(https://evil.example/e.png) ")}',
    "a{content:'x\f;background-image:url(https://evil.example/b.png)} b{content:'}",
  ];
  for (const css of cases) {
    await send(page, { type: 'init', title: css, html: `<style>${css}</style><section data-explain-anchor="state"><h2>S</h2></section>`, anchors: anchors(), dir: DIR, base: await base(page), trail: ROOT_TRAIL });
    await expect(page.locator('.cx-title')).toHaveText(css);
    const urls = await frame(page).locator('body').evaluate((b) =>
      [...b.ownerDocument.styleSheets].flatMap((s) => [...s.cssRules].map((r) => r.cssText)).join('\n').match(/url\([^)]*/g) ?? [],
    );
    for (const u of urls) expect(u, css).not.toMatch(/^url\("?https?:\/\/(?!localhost)/);
  }
});

test('tabbing into a section makes it the current step; J/K work from a switch', async ({ page }) => {
  await open(page, { html: `<section data-explain-anchor="interface"><h2>I</h2><p style="height:900px">long</p></section>
    <section data-explain-anchor="state"><h2>S</h2><input type="checkbox" id="sw"><label for="sw">x</label></section>
    <section data-explain-anchor="refill"><h2>R</h2></section>` });
  await expect(page.locator('.cx-position')).toHaveText('Step 1 of 3');
  await frame(page).locator('#sw').focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(page.locator('.cx-position')).toHaveText('Step 2 of 3');
  await page.keyboard.press('j');
  await expect(page.locator('.cx-position')).toHaveText('Step 3 of 3');
});

test('a section with no usable anchor is counted in the header', async ({ page }) => {
  await open(page, { html: '<section data-explain-anchor="interface"><h2>I</h2></section><section data-explain-anchor="nope"><h2>N</h2></section>' });
  await expect(page.locator('.cx-status')).toHaveText('1 not linked');
});

test('animations far off screen are paused', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 500 });
  await open(page, { html: `<style>@keyframes s{to{opacity:.2}} .spin{animation:s 1s infinite}</style>
    <section data-explain-anchor="interface"><h2>I</h2><div class="spin">a</div><p style="height:3000px"></p></section>
    <section data-explain-anchor="refill"><h2>R</h2><div class="spin" id="far">b</div></section>` });
  const state = (sel: string) => frame(page).locator(sel).evaluate((el) => getComputedStyle(el).animationPlayState);
  await expect.poll(() => state('#far')).toBe('paused');
  await expect.poll(() => state('.spin >> nth=0')).toBe('running');
  await page.locator('.cx-step', { hasText: 'R' }).click();
  await expect.poll(() => state('#far')).toBe('running');
});

test('a section whose code is gone offers to re-anchor it; a manifest error offers to open it', async ({ page }) => {
  await open(page);
  await send(page, { type: 'anchors', anchors: anchors({ refill: 'lost', consume: 'changed' }) });
  await expect(section(page, 'consume').locator('.cx-reanchor')).toHaveCount(0);
  await clearPosted(page);
  await section(page, 'refill').getByRole('button', { name: 'Re-anchor to the selected code' }).click();
  expect(await posted(page)).toEqual([{ type: 'reanchor', anchorId: 'refill' }]);
  // Found again: the control goes, and doesn't count as a change to the section.
  await send(page, { type: 'anchors', anchors: anchors() });
  await expect(section(page, 'refill').locator('.cx-reanchor')).toHaveCount(0);
  await send(page, { type: 'error', message: 'manifest.json is not valid JSON (line 3, column 5).' });
  await clearPosted(page);
  await page.getByRole('button', { name: 'Open manifest.json' }).click();
  expect(await posted(page)).toEqual([{ type: 'openFile', path: 'manifest.json' }]);
});

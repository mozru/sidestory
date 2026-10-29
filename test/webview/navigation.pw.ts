// The panel's side of navigation (docs/NAVIGATION-PLAN.md §12.2): opening at a step, sync while hidden, the
// preview bar, and no "Explainer" left in the panel's chrome.
import { expect, type Page, test } from '@playwright/test';
import type { FromWebview, ToWebview } from '../../src/shared/protocol.ts';

const HTML = `
<section data-explain-anchor="one"><h2>One</h2><p>First.</p></section>
<section data-explain-anchor="two"><h2>Two</h2><p>Second.</p>
  <div data-explain-anchor="inner"><h3>Inner</h3><p>Nested inside two.</p></div>
  ${'<p>filler</p>'.repeat(60)}
</section>
<section data-explain-anchor="three"><h2>Three</h2><p>Third.</p>${'<p>filler</p>'.repeat(60)}</section>`;
const ANCHORS = ['one', 'two', 'inner', 'three'].map((id, i) => ({ id, file: 'x.ts', range: { start: i * 10 + 1, end: i * 10 + 5 }, state: 'exact' as const }));

const send = (page: Page, m: ToWebview) => page.evaluate((msg) => (window as unknown as { __send(m: unknown): void }).__send(msg), m);
const posted = (page: Page) => page.evaluate(() => (window as unknown as { __posted: FromWebview[] }).__posted);

async function open(page: Page, active?: string, dir = 'file:///ws/.sidestory/nav'): Promise<void> {
  await page.goto('/test/webview/harness.html');
  await expect.poll(() => posted(page)).toContainEqual({ type: 'ready' });
  const base = await page.evaluate(() => `${location.origin}/fixtures/sample-workspace/.sidestory/bit-reader/`);
  await send(page, { type: 'init', title: 'Nav', html: HTML, anchors: ANCHORS, active, dir, base, trail: [{ name: 'nav', title: 'Nav' }] });
  await expect(page.locator('.cx-title')).toHaveText('Nav');
}

test('init with a nested anchor as active lands on its step', async ({ page }) => {
  await open(page, 'inner');
  await expect(page.locator('.cx-position')).toHaveText('Step 2 of 3');
});

test('a section the extension asks for wins over the place saved for that sidestory', async ({ page }) => {
  await open(page, 'three');
  await expect(page.locator('.cx-position')).toHaveText('Step 3 of 3');
  // Re-entering the same sidestory (after another) at a different step: the requested one, not the saved one.
  await send(page, { type: 'init', title: 'Other', html: '<section data-explain-anchor="a"><h2>A</h2></section>', anchors: [{ id: 'a', file: 'y.ts', range: { start: 1, end: 2 }, state: 'exact' }], dir: 'file:///ws/.sidestory/other', base: 'http://x/', trail: [{ name: 'other', title: 'Other' }] });
  await expect(page.locator('.cx-title')).toHaveText('Other');
  const base = await page.evaluate(() => `${location.origin}/fixtures/sample-workspace/.sidestory/bit-reader/`);
  await send(page, { type: 'init', title: 'Nav', html: HTML, anchors: ANCHORS, active: 'one', dir: 'file:///ws/.sidestory/nav', base, trail: [{ name: 'nav', title: 'Nav' }] });
  await expect(page.locator('.cx-position')).toHaveText('Step 1 of 3');
  // Scrolled to it, not to where the reader was (step 3, far down).
  await expect.poll(() => page.locator('.cx-scroll').evaluate((e) => e.scrollTop)).toBeLessThan(100);
});

test('a jump from the editor (Go to Step) moves the panel to the step', async ({ page }) => {
  await open(page);
  await send(page, { type: 'syncTo', anchorId: 'three', jump: true });
  await expect(page.locator('.cx-position')).toHaveText('Step 3 of 3');
});

test('a preview panel says so, and Keep Open tells the extension', async ({ page }) => {
  await open(page);
  await expect(page.locator('.cx-preview')).toBeHidden();
  await send(page, { type: 'preview', on: true });
  await expect(page.locator('.cx-preview')).toContainText('Preview: the next sidestory you open from code or a list replaces this one.');
  await page.getByRole('button', { name: 'Keep Open' }).click();
  await expect(page.locator('.cx-preview')).toBeHidden();
  expect(await posted(page)).toContainEqual({ type: 'keepOpen' });
});

test('no "Explainer" in the panel’s accessible names or chrome', async ({ page }) => {
  await open(page);
  await send(page, { type: 'preview', on: true });
  const chrome = await page.evaluate(() => {
    const names = [...document.querySelectorAll('[aria-label], [title]')].map((e) => `${e.getAttribute('aria-label') ?? ''} ${e.getAttribute('title') ?? ''}`);
    const text = [...document.querySelectorAll('header, footer, .cx-banner, .cx-consent, .cx-pill, .cx-preview')].map((e) => e.textContent ?? '');
    return [...names, ...text, document.title].join('\n');
  });
  expect(chrome).not.toMatch(/explainer/i);
});

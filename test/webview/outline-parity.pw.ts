// Outline parity (docs/NAVIGATION-PLAN.md §12.2): the steps the panel shows (ids and labels) equal the ones the
// workspace index outlines without a DOM (src/core/html-scan.ts), for every fixture and example sidestory.
import { expect, type Page, test } from '@playwright/test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { outlineHtml } from '../../src/core/html-scan.ts';
import type { FromWebview, ToWebview } from '../../src/shared/protocol.ts';

const FOLDERS = ['fixtures/sample-workspace/.sidestory', 'examples/stream-dma/.sidestory', 'examples/tiny-lsm/.sidestory'];
const PAGES = FOLDERS.flatMap((f) => readdirSync(f).filter((n) => !n.startsWith('.') && readdirSync(join(f, n)).includes('sidestory.html')).map((n) => join(f, n)));

const send = (page: Page, m: ToWebview) => page.evaluate((msg) => (window as unknown as { __send(m: unknown): void }).__send(msg), m);
const posted = (page: Page) => page.evaluate(() => (window as unknown as { __posted: FromWebview[] }).__posted);
const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

async function render(page: Page, dir: string, html: string): Promise<void> {
  await page.goto('/test/webview/harness.html');
  await expect.poll(() => posted(page)).toContainEqual({ type: 'ready' });
  const base = await page.evaluate((d) => `${location.origin}/${d}/`, dir);
  const name = dir.split('/').at(-1)!;
  await send(page, { type: 'init', title: name, html, anchors: [], dir: `file:///ws/${dir}`, base, trail: [{ name, title: name }] });
  await expect(page.locator('.cx-position')).not.toHaveText('');
}

/** The panel's steps: the navigator buttons, in order. */
const panelSteps = (page: Page) =>
  page.locator('.cx-step').evaluateAll((els) => els.map((b) => ({ id: (b as HTMLElement).dataset.anchor!, label: b.querySelector('.cx-step-label')!.textContent ?? '' })));

test('there are sidestories to compare', () => {
  expect(PAGES.length).toBeGreaterThanOrEqual(18);
});

for (const dir of PAGES) {
  test(`the panel's steps equal the outline: ${dir}`, async ({ page }) => {
    const html = readFileSync(join(dir, 'sidestory.html'), 'utf8');
    const outline = outlineHtml(html);
    expect(outline.truncated).toBe(false);
    await render(page, dir, html);
    const shown = await panelSteps(page);
    expect(shown.map((s) => ({ id: s.id, label: collapse(s.label) }))).toEqual(outline.steps.map((s) => ({ id: s.id, label: collapse(s.title) })));
  });
}

test('an empty data-explain-title falls through to the heading, then the id, in the panel and the outline', async ({ page }) => {
  const html = [
    '<section data-explain-anchor="a" data-explain-title=""><h2>From  the heading</h2><p>x</p></section>',
    '<section data-explain-anchor="b" data-explain-title=" "><p>no heading</p></section>',
    '<section data-explain-anchor="c" data-explain-title="Given"><h2>Ignored</h2></section>',
  ].join('\n');
  await render(page, 'fixtures/sample-workspace/.sidestory/bit-reader', html);
  const shown = (await panelSteps(page)).map((s) => collapse(s.label));
  expect(shown).toEqual(['From the heading', 'b', 'Given']);
  expect(outlineHtml(html).steps.map((s) => s.title)).toEqual(shown);
});

test('a step inside SVG animation is no step, in the panel and the outline (animation renders no children)', async ({ page }) => {
  const html = [
    '<section data-explain-anchor="a"><h2>A</h2></section>',
    '<svg><set attributeName="x" to="1"><g data-explain-anchor="ghost"><text>Ghost</text></g></set></svg>',
    '<section data-explain-anchor="b"><h2>B</h2></section>',
  ].join('\n');
  await render(page, 'fixtures/sample-workspace/.sidestory/bit-reader', html);
  const shown = (await panelSteps(page)).map((s) => s.id);
  expect(shown).toEqual(['a', 'b']);
  expect(outlineHtml(html).steps.map((s) => s.id)).toEqual(shown);
});

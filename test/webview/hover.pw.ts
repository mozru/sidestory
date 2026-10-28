// The hover preview (`sidestory.hoverPreview`): resting on a linked element shows a card with its code, in the panel's
// own chrome, and never posts anything that moves the editor, the cursor or the step.
import { expect, type Page, test } from '@playwright/test';
import type { AnchorView, CodePreview, FromWebview, HoverPreview, ToWebview } from '../../src/shared/protocol.ts';
import { THEMES, themeCss } from './themes.ts';

const DIR = 'file:///ws/.sidestory/bit-reader';
const ANCHORS: AnchorView[] = [
  { id: 'interface', file: 'rtl/bit_reader.sv', range: { start: 1, end: 15 }, state: 'exact' },
  { id: 'state', file: 'rtl/bit_reader.sv', range: { start: 16, end: 17 }, state: 'exact' },
];
const HTML = `<section data-explain-anchor="interface"><h2>Interface</h2>
  <p>Read <span id="code" data-explain-code="rtl/bit_reader.sv#L3-L16">the ports</span> and <a id="ref" data-explain-ref="state">the state</a>.</p>
  <svg viewBox="0 0 100 40" style="width: 200px; height: 80px"><g id="box" data-explain-code="rtl/bit_reader.sv#L1"><rect id="box-rect" width="40" height="30" fill="gray"/><text id="box-text" y="38">box</text></g></svg>
  <p id="plain">Plain text, far from any link.</p>
  <div style="height: 1200px"></div>
</section>`;

const send = (page: Page, m: ToWebview) => page.evaluate((msg) => (window as unknown as { __send(m: unknown): void }).__send(msg), m);
const posted = (page: Page) => page.evaluate(() => (window as unknown as { __posted: FromWebview[] }).__posted);
const clearPosted = (page: Page) => page.evaluate(() => ((window as unknown as { __posted: FromWebview[] }).__posted = []));
const el = (page: Page, id: string) => page.frameLocator('iframe.cx-content-frame').locator(`#${id}`);
const card = (page: Page) => page.locator('.cx-hovercard');
/** Messages that would move the editor, the cursor or the step. */
const moving = async (page: Page) => (await posted(page)).filter((m) => ['openRef', 'openCode', 'focusAnchor', 'openFile', 'goTo', 'dive'].includes(m.type));

async function open(page: Page, mode: HoverPreview): Promise<void> {
  await page.goto('/test/webview/harness.html');
  await page.evaluate(([css, cls]) => {
    document.documentElement.setAttribute('style', css);
    document.body.className = cls;
  }, [themeCss('dark'), THEMES.dark.bodyClass] as const);
  await expect.poll(() => posted(page)).toContainEqual({ type: 'ready' });
  const base = await page.evaluate(() => `${location.origin}/fixtures/sample-workspace/.sidestory/bit-reader/`);
  await send(page, { type: 'init', title: 'Hover', html: HTML, anchors: ANCHORS, active: 'interface', dir: DIR, base, trail: [{ name: 'bit-reader', title: 'Hover' }] });
  await send(page, { type: 'settings', hoverPreview: mode });
  await expect(page.locator('.cx-title')).toHaveText('Hover');
  await clearPosted(page);
}

const answered = new WeakMap<Page, Set<number>>();
/** Plays the extension: answers the next preview request with this preview (null: not found). */
async function answer(page: Page, preview: CodePreview | null, note?: string): Promise<FromWebview> {
  const done = answered.get(page) ?? new Set<number>();
  answered.set(page, done);
  let ask: Extract<FromWebview, { id: number }> | undefined;
  const next = async () => (await posted(page)).find((m): m is Extract<FromWebview, { id: number }> => (m.type === 'previewCode' || m.type === 'previewRef') && !done.has(m.id));
  await expect.poll(async () => (ask = await next())).toBeTruthy();
  done.add(ask!.id);
  await send(page, { type: 'codePreview', id: ask!.id, preview, ...(note ? { note } : {}) });
  return ask!;
}

const PORTS: CodePreview = {
  path: 'rtl/bit_reader.sv',
  start: 3,
  end: 16,
  lines: [') (', '  input  logic clk,', '  input  logic rst_n,', '', 'a', 'b', 'c', 'd', 'e', 'f', 'g', `h ${'x'.repeat(190)}`],
  more: 2,
  languageId: 'systemverilog',
};

test('resting on a code link shows its code after a moment; leaving hides it; nothing moves the editor', async ({ page }) => {
  await open(page, 'card');
  await el(page, 'code').hover();
  await expect(card(page)).toBeHidden();
  const ask = await answer(page, PORTS);
  expect(ask).toEqual({ type: 'previewCode', id: expect.any(Number), path: 'rtl/bit_reader.sv', target: 'L3-L16' });
  await expect(card(page)).toBeVisible();
  await expect(card(page)).toHaveAttribute('role', 'tooltip');
  await expect(card(page).locator('.cx-hovercard-head')).toHaveText('rtl/bit_reader.sv · L3–16');
  await expect(card(page).locator('.cx-hovercard-line')).toHaveCount(12);
  await expect(card(page).locator('.cx-hovercard-line').first()).toHaveText(') (');
  await expect(card(page).locator('.cx-hovercard-more')).toHaveText('… 2 more lines');
  await expect(card(page).locator('.cx-hovercard-code')).toHaveCSS('font-family', /Menlo/);
  await expect(card(page)).toHaveCSS('pointer-events', 'none');
  // Below the link, inside the panel; long lines are clipped, never wrapped.
  const link = await el(page, 'code').boundingBox();
  const box = (await card(page).boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(link!.y + link!.height);
  expect(box.x + box.width).toBeLessThanOrEqual(600);
  await expect(card(page).locator('.cx-hovercard-line').last()).toHaveCSS('white-space', 'pre');

  await el(page, 'plain').hover();
  await expect(card(page)).toBeHidden();
  await expect.poll(async () => (await posted(page)).filter((m) => m.type === 'previewEnd')).toHaveLength(1);
  expect(await moving(page)).toEqual([]);
});

test('a ref, a diagram box (moving over its parts keeps the card), not found, colors', async ({ page }) => {
  await open(page, 'card');
  await el(page, 'ref').hover();
  expect(await answer(page, null)).toMatchObject({ type: 'previewRef', anchorId: 'state' });
  await expect(card(page)).toHaveText('Code not found');

  await el(page, 'box-rect').hover();
  const colored: CodePreview = { path: 'rtl/bit_reader.sv', start: 1, end: 1, lines: ['module x'], more: 0, languageId: 'systemverilog', palette: [{}, { color: '#ff0000' }], runs: [6, 1, 2, 0] };
  await answer(page, colored);
  await expect(card(page).locator('.cx-hovercard-head')).toHaveText('rtl/bit_reader.sv · L1');
  await expect(card(page).locator('.cx-hovercard-line span')).toHaveText('module');
  await expect(card(page).locator('.cx-hovercard-line span')).toHaveCSS('color', 'rgb(255, 0, 0)');
  const asks = (await posted(page)).filter((m) => m.type === 'previewCode').length;
  await el(page, 'box-text').hover();
  await page.waitForTimeout(300);
  await expect(card(page)).toBeVisible();
  expect((await posted(page)).filter((m) => m.type === 'previewCode').length).toBe(asks);
  expect(await moving(page)).toEqual([]);
});

test('Escape and scrolling hide the card; a click hides it and opens the code as before', async ({ page }) => {
  await open(page, 'card');
  await el(page, 'code').hover();
  await answer(page, PORTS);
  await expect(card(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(card(page)).toBeHidden();

  await el(page, 'plain').hover();
  await el(page, 'code').hover();
  await answer(page, PORTS);
  await expect(card(page)).toBeVisible();
  await page.mouse.wheel(0, 200);
  await expect(card(page)).toBeHidden();

  await el(page, 'code').hover();
  await answer(page, PORTS);
  await expect(card(page)).toBeVisible();
  await el(page, 'code').click();
  await expect(card(page)).toBeHidden();
  expect(await moving(page)).toEqual([{ type: 'openCode', path: 'rtl/bit_reader.sv', target: 'L3-L16' }]);
});

test('tabbing to a link shows its card and describes the link; leaving it hides the card', async ({ page }) => {
  await open(page, 'card');
  await el(page, 'code').focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(el(page, 'code')).toBeFocused();
  await answer(page, PORTS);
  await expect(card(page)).toBeVisible();
  const described = await el(page, 'code').getAttribute('aria-describedby');
  expect(described).toMatch(/^cx-hover-/);
  await expect(page.frameLocator('iframe.cx-content-frame').locator(`[id="${described}"]`)).toContainText('rtl/bit_reader.sv · L3–16');
  await page.keyboard.press('Tab');
  await expect(card(page)).toBeHidden();
  await expect(el(page, 'code')).not.toHaveAttribute('aria-describedby', /.*/);
  expect(await moving(page)).toEqual([]);
});

test('`off` shows and asks nothing; `editor` asks (for the editor mark) but shows no card', async ({ page }) => {
  await open(page, 'off');
  await el(page, 'code').hover();
  await page.waitForTimeout(800);
  await expect(card(page)).toBeHidden();
  expect(await posted(page)).toEqual([]);

  await send(page, { type: 'settings', hoverPreview: 'editor' });
  await el(page, 'plain').hover();
  await el(page, 'code').hover();
  await answer(page, PORTS);
  await page.waitForTimeout(600);
  await expect(card(page)).toBeHidden();
  await el(page, 'plain').hover();
  await expect.poll(async () => (await posted(page)).map((m) => m.type)).toEqual(['previewCode', 'previewShow', 'previewEnd']);
});

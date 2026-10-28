// Back / Forward in the panel (src/webview/history.ts), and VS Code's shortcuts from inside the content frame
// (src/webview/keys.ts). The harness plays the extension: it answers `openHistory` and `goTo` with an `init`.
import { expect, type Page, test } from '@playwright/test';
import type { FromWebview, ToWebview } from '../../src/shared/protocol.ts';

const filler = '<p>filler</p>'.repeat(40);
const HTML = ['one', 'two', 'three', 'four', 'five'].map((id) => `<section data-explain-anchor="${id}"><h2>${id[0]!.toUpperCase()}${id.slice(1)}</h2><p>About ${id}.</p>${filler}</section>`).join('\n');
const ANCHORS = ['one', 'two', 'three', 'four', 'five'].map((id, i) => ({ id, file: 'x.ts', range: { start: i * 10 + 1, end: i * 10 + 5 }, state: 'exact' as const }));
const CHILD_HTML = `<section data-explain-anchor="a"><h2>A</h2>${filler}</section><section data-explain-anchor="b"><h2>B</h2>${filler}</section>`;
const CHILD_ANCHORS = [{ id: 'a', file: 'y.ts', range: { start: 1, end: 2 }, state: 'exact' as const }, { id: 'b', file: 'y.ts', range: { start: 3, end: 4 }, state: 'exact' as const }];
const ROOT = 'file:///ws/.sidestory/tour';
const CHILD = 'file:///ws/.sidestory/detail';

const send = (page: Page, m: ToWebview) => page.evaluate((msg) => (window as unknown as { __send(m: unknown): void }).__send(msg), m);
const posted = (page: Page) => page.evaluate(() => (window as unknown as { __posted: FromWebview[] }).__posted);
const clearPosted = (page: Page) => page.evaluate(() => ((window as unknown as { __posted: FromWebview[] }).__posted = []));
const frame = (page: Page) => page.frameLocator('iframe.cx-content-frame');
const scrollTop = (page: Page) => page.locator('.cx-scroll').evaluate((e) => e.scrollTop);
/** Within a pixel of `y`. */
const near = async (page: Page, y: number) => Math.abs((await scrollTop(page)) - y) < 1.5;
const isMac = (page: Page) => page.evaluate(() => /Mac/.test(navigator.platform));
const back = (page: Page) => page.locator('.cx-hist[data-delta="-1"]');
const forward = (page: Page) => page.locator('.cx-hist[data-delta="1"]');
const position = (page: Page) => page.locator('.cx-position');

async function base(page: Page): Promise<string> {
  return page.evaluate(() => `${location.origin}/fixtures/sample-workspace/.sidestory/bit-reader/`);
}

async function initRoot(page: Page, active?: string): Promise<void> {
  await send(page, { type: 'init', title: 'Tour', html: HTML, anchors: ANCHORS, active, dir: ROOT, base: await base(page), trail: [{ name: 'tour', title: 'Tour' }] });
  await expect(page.locator('.cx-title')).toHaveText('Tour');
}

async function initChild(page: Page, active?: string, trail = [{ name: 'tour', title: 'Tour' }, { name: 'detail', title: 'Detail' }]): Promise<void> {
  await send(page, { type: 'init', title: 'Detail', html: CHILD_HTML, anchors: CHILD_ANCHORS, active, dir: CHILD, base: await base(page), trail });
  await expect(page.locator('.cx-title')).toHaveText('Detail');
}

async function open(page: Page): Promise<void> {
  await page.goto('/test/webview/harness.html');
  await page.emulateMedia({ reducedMotion: 'reduce' }); // scrolls land at once: positions can be compared
  await expect.poll(() => posted(page)).toContainEqual({ type: 'ready' });
  await initRoot(page);
}

/** Key events VS Code's webview host would get: those reaching the panel's window. */
async function listen(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __keys: string[] };
    w.__keys = [];
    for (const type of ['keydown', 'keyup']) {
      window.addEventListener(type, (e) => {
        const k = e as KeyboardEvent;
        w.__keys.push(`${k.type}:${k.ctrlKey ? 'C' : ''}${k.metaKey ? 'M' : ''}${k.altKey ? 'A' : ''}${k.shiftKey ? 'S' : ''}+${k.key}/${k.code}/${k.keyCode}`);
      });
    }
  });
}
const keys = (page: Page) => page.evaluate(() => (window as unknown as { __keys: string[] }).__keys);
const resetKeys = (page: Page) => page.evaluate(() => ((window as unknown as { __keys: string[] }).__keys = []));

/** Waits until the panel stopped scrolling and its place was recorded. */
async function settle(page: Page): Promise<void> {
  await expect.poll(() => page.locator('.cx-scroll').evaluate((s) => new Promise<number>((r) => { const a = s.scrollTop; setTimeout(() => r(s.scrollTop - a), 150); }))).toBe(0);
  await page.waitForTimeout(300);
}

test('a step chosen from the tabs is an entry: Back and Forward return to its step and scroll position', async ({ page }) => {
  await open(page);
  await expect(back(page)).toBeDisabled();
  await expect(forward(page)).toBeDisabled();
  await expect(back(page)).toHaveAttribute('title', 'Back');
  // The reader scrolls a little into step 1, then picks step 4.
  await page.locator('.cx-scroll').evaluate((e) => (e.scrollTop = 120));
  await settle(page);
  const before = await scrollTop(page);
  await page.locator('.cx-step', { hasText: 'Four' }).click();
  await expect(position(page)).toHaveText('Step 4 of 5');
  await settle(page);
  await expect(back(page)).toBeEnabled();
  await expect(back(page)).toHaveAttribute('title', 'Back to Tour · step 1');
  await expect(back(page)).toHaveAccessibleName('Back to Tour · step 1');
  const at4 = await scrollTop(page);
  await clearPosted(page);
  await back(page).click();
  await expect(position(page)).toHaveText('Step 1 of 5');
  await expect.poll(() => near(page, before)).toBe(true);
  // The editor follows, as for any step the reader chooses.
  expect(await posted(page)).toContainEqual({ type: 'focusAnchor', anchorId: 'one', source: 'step' });
  await expect(back(page)).toBeDisabled();
  await expect(forward(page)).toHaveAttribute('title', 'Forward to Tour · step 4');
  await forward(page).click();
  await expect(position(page)).toHaveText('Step 4 of 5');
  await expect.poll(() => near(page, at4)).toBe(true);
  await expect(forward(page)).toBeDisabled();
});

test('a run of J/K steps is one entry; a new jump drops what was ahead', async ({ page }) => {
  await open(page);
  await page.locator('.cx-scroll').focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press('j');
  await expect(position(page)).toHaveText('Step 4 of 5');
  await back(page).click();
  await expect(position(page)).toHaveText('Step 1 of 5');
  await expect(back(page)).toBeDisabled();
  await forward(page).click();
  await expect(position(page)).toHaveText('Step 4 of 5');
  // Back, then a new jump: Forward has nothing left.
  await back(page).click();
  await page.locator('.cx-step-select').selectOption('three', { force: true }); // the picker (narrow panels)
  await expect(position(page)).toHaveText('Step 3 of 5');
  await expect(forward(page)).toBeDisabled();
  await back(page).click();
  await expect(position(page)).toHaveText('Step 1 of 5');
  // Stepping back to where a run started undoes it: no entry for it.
  await forward(page).click();
  await page.locator('.cx-scroll').focus();
  await page.keyboard.press('j');
  await page.keyboard.press('k');
  await expect(position(page)).toHaveText('Step 3 of 5');
  await back(page).click();
  await expect(position(page)).toHaveText('Step 1 of 5');
});

test('Back to another sidestory asks the extension for it, then lands on its step and scroll position', async ({ page }) => {
  await open(page);
  await page.locator('.cx-step', { hasText: 'Three' }).click();
  await settle(page);
  const at3 = await scrollTop(page);
  // A dive: the extension answers with the detail.
  await initChild(page);
  await expect(back(page)).toHaveAttribute('title', 'Back to Tour · step 3');
  await clearPosted(page);
  await send(page, { type: 'history', delta: -1 }); // Sidestory: Back
  await expect.poll(() => posted(page)).toContainEqual({ type: 'openHistory', dir: ROOT, trail: ['tour'], active: 'three' });
  await initRoot(page, 'three');
  await expect(position(page)).toHaveText('Step 3 of 5');
  await expect.poll(() => near(page, at3)).toBe(true);
  await expect(forward(page)).toHaveAttribute('title', 'Forward to Detail · step 1');
  await clearPosted(page);
  await forward(page).click();
  await expect.poll(() => posted(page)).toContainEqual({ type: 'openHistory', dir: CHILD, trail: ['tour', 'detail'], active: 'a' });
  await initChild(page, 'a');
  await expect(forward(page)).toBeDisabled();
  await expect(back(page)).toBeEnabled();
});

test('the trail’s way up is Back when that is where the reader came from, so Forward dives again', async ({ page }) => {
  await open(page);
  await initChild(page);
  await clearPosted(page);
  await page.locator('.cx-back').click();
  expect(await posted(page)).toContainEqual({ type: 'goTo', depth: 0 });
  await initRoot(page);
  await expect(back(page)).toBeDisabled();
  await expect(forward(page)).toBeEnabled();
  // Diving into it again is Forward: nothing ahead is dropped, and Back still leads up.
  await clearPosted(page);
  await forward(page).click();
  await expect.poll(() => posted(page)).toContainEqual(expect.objectContaining({ type: 'openHistory', dir: CHILD }));
  await initChild(page);
  await expect(back(page)).toBeEnabled();
  await expect(forward(page)).toBeDisabled();
  // Escape still goes up the trail.
  await clearPosted(page);
  await page.locator('.cx-scroll').focus();
  await page.keyboard.press('Escape');
  expect(await posted(page)).toContainEqual({ type: 'goTo', depth: 0 });
});

test('a sidestory opened into the panel is a new entry; the history survives the panel being rebuilt', async ({ page }) => {
  await open(page);
  await page.locator('.cx-step', { hasText: 'Two' }).click();
  await initChild(page, 'b', [{ name: 'detail', title: 'Detail' }]);
  await expect(back(page)).toHaveAttribute('title', 'Back to Tour · step 2');
  await page.waitForTimeout(400);
  const saved = await page.evaluate(() => (window as unknown as { __state: unknown }).__state);
  // Rebuilt, as VS Code does for a hidden panel shown again: a new page with the saved state, then `init` again.
  await page.addInitScript((s) => {
    let v = s;
    // The harness starts with no state: keep this instead.
    Object.defineProperty(window, '__state', { configurable: true, get: () => v, set: (x) => { if (x !== undefined) v = x; } });
  }, saved);
  await page.goto('/test/webview/harness.html');
  await expect.poll(() => posted(page)).toContainEqual({ type: 'ready' });
  await initChild(page, 'b', [{ name: 'detail', title: 'Detail' }]);
  await expect(back(page)).toHaveAttribute('title', 'Back to Tour · step 2');
  await expect(forward(page)).toBeDisabled();
  await back(page).click();
  await expect.poll(() => posted(page)).toContainEqual({ type: 'openHistory', dir: ROOT, trail: ['tour'], active: 'two' });
});

test('shortcuts: the page’s own on macOS, VS Code’s through it, the mouse’s back and forward buttons, Sidestory: Back / Forward', async ({ page }) => {
  await open(page);
  await listen(page);
  await page.locator('.cx-step', { hasText: 'Five' }).click();
  await expect(position(page)).toHaveText('Step 5 of 5');
  await frame(page).locator('h2', { hasText: 'Five' }).click();
  if (await isMac(page)) {
    // Alt+Left / Right and Cmd+[ / ]: VS Code binds them to nothing here, so the page takes them, in the content too.
    await page.keyboard.press('Alt+ArrowLeft');
    await expect(position(page)).toHaveText('Step 1 of 5');
    await page.keyboard.press('Alt+ArrowRight');
    await expect(position(page)).toHaveText('Step 5 of 5');
    await page.keyboard.press('Meta+BracketLeft');
    await expect(position(page)).toHaveText('Step 1 of 5');
    await page.keyboard.press('Meta+BracketRight');
    await expect(position(page)).toHaveText('Step 5 of 5');
  }
  // VS Code's own (Ctrl+- on macOS, Alt+Left elsewhere) go to VS Code, which runs Sidestory: Back: every key of the chord.
  await resetKeys(page);
  const vsBack = (await isMac(page)) ? 'Control+Minus' : 'Alt+ArrowLeft';
  await page.keyboard.press(vsBack);
  await expect.poll(() => keys(page)).toContain((await isMac(page)) ? 'keydown:C+-/Minus/189' : 'keydown:A+ArrowLeft/ArrowLeft/37');
  await expect(position(page)).toHaveText('Step 5 of 5');
  // Mouse buttons 3 and 4, in the content and on the panel's chrome.
  const mouse = (target: 'frame' | 'panel', button: number) =>
    page.evaluate(([t, b]) => {
      const doc = t === 'frame' ? document.querySelector<HTMLIFrameElement>('iframe.cx-content-frame')!.contentDocument! : document;
      const el = t === 'frame' ? doc.querySelector('h2')! : document.querySelector('.cx-title')!;
      for (const type of ['mousedown', 'mouseup']) el.dispatchEvent(new MouseEvent(type, { button: b, bubbles: true, cancelable: true }));
    }, [target, button] as const);
  await mouse('frame', 3);
  await expect(position(page)).toHaveText('Step 1 of 5');
  await mouse('panel', 4);
  await expect(position(page)).toHaveText('Step 5 of 5');
  // The commands, from VS Code.
  await send(page, { type: 'history', delta: -1 });
  await expect(position(page)).toHaveText('Step 1 of 5');
  await send(page, { type: 'history', delta: 1 });
  await expect(position(page)).toHaveText('Step 5 of 5');
});

test('Go to Step from the extension is an entry; the editor’s cursor moving is not', async ({ page }) => {
  await open(page);
  await send(page, { type: 'syncTo', anchorId: 'two' });
  await expect(position(page)).toHaveText('Step 2 of 5');
  await expect(back(page)).toBeDisabled();
  await send(page, { type: 'syncTo', anchorId: 'four', jump: true });
  await expect(position(page)).toHaveText('Step 4 of 5');
  await expect(back(page)).toHaveAttribute('title', 'Back to Tour · step 2');
});

test('narrow panels fit the buttons beside the status, the title below', async ({ page }) => {
  await page.setViewportSize({ width: 300, height: 600 });
  await open(page);
  const b = await back(page).boundingBox();
  const f = await forward(page).boundingBox();
  const t = await page.locator('.cx-title').boundingBox();
  expect(b && f && t).toBeTruthy();
  expect(f!.x).toBeGreaterThan(b!.x);
  expect(t!.y).toBeGreaterThan(b!.y + b!.height - 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test.describe('VS Code’s shortcuts from inside the content', () => {
  test('Ctrl+Shift+P pressed in the content reaches the panel’s window, once, as VS Code reads it', async ({ page }) => {
    await open(page);
    await listen(page);
    await frame(page).locator('h2', { hasText: 'One' }).click();
    await page.keyboard.press('Control+Shift+KeyP');
    await expect.poll(() => keys(page)).toEqual(['keydown:C+Control/ControlLeft/17', 'keydown:CS+Shift/ShiftLeft/16', 'keydown:CS+P/KeyP/80', 'keyup:CS+P/KeyP/80', 'keyup:C+Shift/ShiftLeft/16', 'keyup:+Control/ControlLeft/17']);
  });

  test('F-keys pass; the page’s own keys and typing don’t', async ({ page }) => {
    await open(page);
    await send(page, { type: 'content', title: 'Tour', html: `<section data-explain-anchor="one"><h2>One</h2><input id="t" aria-label="t"></section>${HTML.replace(/^<section data-explain-anchor="one">[^\n]*\n/, '')}` });
    await expect(frame(page).locator('#t')).toBeVisible();
    await listen(page);
    await frame(page).locator('h2', { hasText: 'One' }).click();
    await page.keyboard.press('F1');
    await expect.poll(() => keys(page)).toEqual(['keydown:+F1/F1/112', 'keyup:+F1/F1/112']);
    await resetKeys(page);
    // J steps, Escape and Ctrl+C are the page's; text typed into a field is the field's.
    await page.keyboard.press('j');
    await expect(position(page)).toHaveText('Step 2 of 5');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+KeyC');
    await frame(page).locator('#t').focus();
    await page.keyboard.press('Control+Shift+KeyP');
    await page.keyboard.type('hi');
    await page.waitForTimeout(100);
    // Only the modifier itself got through (it carries no command on its own).
    expect(await keys(page)).toEqual(['keydown:C+Control/ControlLeft/17', 'keyup:+Control/ControlLeft/17']);
    if (await isMac(page)) {
      // Back on macOS is the page's: the key isn't passed on, only Alt itself.
      await frame(page).locator('h2', { hasText: 'One' }).click();
      await page.keyboard.press('j');
      await expect(position(page)).toHaveText('Step 2 of 5');
      await resetKeys(page);
      await page.keyboard.press('Alt+ArrowLeft');
      await expect(position(page)).toHaveText('Step 1 of 5');
      expect(await keys(page)).toEqual(['keydown:A+Alt/AltLeft/18', 'keyup:+Alt/AltLeft/18']);
    }
  });
});

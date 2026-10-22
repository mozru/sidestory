// End to end: the extension in a Linux container, VS Code and the panel in the browser.
import { expect, test } from '@playwright/test';
import { WORKSPACE } from './setup.ts';
import { activeTab, chooseStep, codeEditor, command, content, editorLines, inContainer, openExplainer, resetWorkbench } from './helpers.ts';

test.beforeEach(async ({ page }) => resetWorkbench(page));

test('opens beside the editor, styled by the theme', async ({ page }) => {
  const panel = await openExplainer(page, 'bit-reader');
  await expect(panel.locator('.cx-title')).toHaveText('A backward bit reader in five moves');
  await expect(panel.locator('.cx-status')).toContainText('Linked');
  const style = await content(panel).locator('.cx-content').evaluate((el) => {
    const s = getComputedStyle(el);
    return { font: s.fontFamily, padding: s.paddingLeft, color: s.color };
  });
  expect(style.font).not.toMatch(/^"?Times/);
  expect(parseFloat(style.padding)).toBeGreaterThan(8);
});

test('stepping through the explainer reveals and highlights the code', async ({ page }) => {
  const panel = await openExplainer(page, 'bit-reader');
  await chooseStep(panel, 'refill');
  await expect(activeTab(page, 'bit_reader.sv')).toBeVisible();
  await expect(editorLines(page)).toContainText('refill below valid bits');
  await expect(panel.locator('.cx-position')).toHaveText('Step 5 of 5');
});

test('moving the cursor in the code moves the explainer', async ({ page }) => {
  const panel = await openExplainer(page, 'bit-reader');
  await chooseStep(panel, 'interface');
  await expect(activeTab(page, 'bit_reader.sv')).toBeVisible();
  await editorLines(page).click();
  await command(page, 'Go to Line/Column', true);
  await page.keyboard.type('32');
  await page.keyboard.press('Enter');
  await expect(panel.locator('.cx-position')).toHaveText('Step 4 of 5');
});

test('edits to the explainer file appear live, without a reload', async ({ page }) => {
  const panel = await openExplainer(page, 'bit-reader');
  await chooseStep(panel, 'handshakes');
  inContainer(`sed -i 's/Three one-line rules/Three tiny rules/' ${WORKSPACE}/.explain/bit-reader/explainer.html`);
  await expect(content(panel).locator('[data-explain-anchor="handshakes"] h2')).toHaveText('Three tiny rules');
  await expect(panel.locator('.cx-position')).toHaveText('Step 3 of 5');
});

test('unsaved code edits keep sections linked and following the code', async ({ page }) => {
  const panel = await openExplainer(page, 'bit-reader');
  await chooseStep(panel, 'interface');
  await editorLines(page).click();
  await command(page, 'Go to Line/Column', true);
  await page.keyboard.type('1');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Home');
  await page.keyboard.insertText('// a new header line\n// and another\n');
  await expect(panel.locator('.cx-status')).toContainText('Linked');
  await chooseStep(panel, 'refill');
  await expect(editorLines(page)).toContainText('refill below valid bits');
  // Two lines were added at the top, so the State registers (lines 16–17) are now 18–19.
  await command(page, 'Go to Line/Column', true);
  await page.keyboard.type('19');
  await page.keyboard.press('Enter');
  await expect(panel.locator('.cx-position')).toHaveText('Step 2 of 5');
});

test('images in an explainer load inside the sandboxed frame', async ({ page }) => {
  const panel = await openExplainer(page, 'retry-backoff');
  const img = content(panel).locator('img[alt^="Waits grow"]');
  await expect(img).toHaveAttribute('src', /^blob:/);
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
});

const THEMES = [
  ['Default Dark Modern', 'vscode-dark'],
  ['Default Light Modern', 'vscode-light'],
  ['Default High Contrast', 'vscode-high-contrast'],
] as const;

for (const [theme, bodyClass] of THEMES) {
  test(`follows the color theme live: ${theme}`, async ({ page }, info) => {
    const panel = await openExplainer(page, 'bit-reader');
    await chooseStep(panel, 'state');
    // Change the setting on the server, as a user (or settings sync) would; VS Code applies it live.
    await command(page, 'Preferences: Color Theme');
    await page.keyboard.type(theme);
    await page.locator('.quick-input-list .monaco-list-row', { hasText: theme }).first().click();
    await expect(panel.locator('body')).toHaveClass(new RegExp(`(^| )${bodyClass}( |$)`));
    // The content frame follows too.
    await expect(content(panel).locator('body')).toHaveClass(new RegExp(`(^| )${bodyClass}( |$)`));
    await page.waitForTimeout(800);
    await page.screenshot({ path: info.outputPath(`${theme.replace(/\W+/g, '-')}.png`) });
  });
}

test('two explainers open at once both keep working', async ({ page }) => {
  const first = await openExplainer(page, 'bit-reader');
  const second = await openExplainer(page, 'retry-backoff');
  await expect(second.locator('.cx-title')).toHaveText('Retry with full-jitter backoff');
  await page.locator('.tab', { hasText: 'A backward bit reader' }).click();
  await chooseStep(first, 'refill');
  await expect(editorLines(page)).toContainText('refill below valid bits');
  await expect(first.locator('.cx-position')).toHaveText('Step 5 of 5');
});

test('diving into a detail and coming back keeps the reader’s place', async ({ page }) => {
  const panel = await openExplainer(page, 'overview');
  await expect(panel.locator('.cx-title')).toHaveText('Sample workspace tour');
  await chooseStep(panel, 'retry');
  const detail = content(panel).locator('[data-explain-detail="bit-reader"] .cx-detail');
  // Peek: the summary, in place.
  await detail.locator('.cx-peek').click();
  await expect(detail.locator('.cx-peek-body')).toContainText('A 64-bit window');
  await expect(detail.locator('.cx-detail-steps')).toHaveText('5 steps');
  // Dive: the same panel shows the detail, with a trail back.
  await detail.locator('.cx-dive').click();
  await expect(panel.locator('.cx-title')).toHaveText('A backward bit reader in five moves');
  await expect(panel.getByRole('navigation', { name: 'Explainer path' })).toContainText('Sample workspace tour');
  await chooseStep(panel, 'refill');
  await expect(activeTab(page, 'bit_reader.sv')).toBeVisible();
  await expect(editorLines(page)).toContainText('refill below valid bits');
  // Back: the overview again, at the step the reader left.
  await panel.locator('.cx-back').click();
  await expect(panel.locator('.cx-title')).toHaveText('Sample workspace tour');
  await expect(panel.locator('.cx-position')).toHaveText('Step 2 of 2');
  await expect(panel.locator('.cx-trail')).toBeHidden();
  // The cursor in code a detail covers offers to dive into it.
  await codeEditor(page, 'bit_reader.sv').locator('.view-line', { hasText: 'refill below valid bits' }).click();
  await expect(panel.locator('.cx-pill-show')).toContainText('Dive');
});

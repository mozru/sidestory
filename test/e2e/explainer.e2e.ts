// End to end: the extension in a Linux container, VS Code and the panel in the browser.
import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { CONTAINER, WORKSPACE } from './setup.ts';
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

test('a reference or a step shows the start of its lines: an editor scrolled sideways (a long line) scrolls back', async ({ page }) => {
  inContainer(`printf '// %0400d\\n' 0 >> ${WORKSPACE}/rtl/bit_reader.sv && sed -i '17s|$|  // ${'x'.repeat(300)}|' ${WORKSPACE}/rtl/bit_reader.sv`);
  const panel = await openExplainer(page, 'bit-reader');
  await chooseStep(panel, 'interface');
  await expect(activeTab(page, 'bit_reader.sv')).toBeVisible();
  // To the end of the long last line: the editor scrolls sideways.
  await editorLines(page).click();
  await command(page, 'Go to Line/Column', true);
  await page.keyboard.type('44'); // the long line just added (45 is the empty one after it)
  await page.keyboard.press('Enter');
  await page.keyboard.press('End');
  const scrolled = () => codeEditor(page, 'bit_reader.sv').locator('.lines-content').evaluate((el) => parseFloat(getComputedStyle(el).left) || 0);
  await expect.poll(scrolled).toBeLessThan(-100);
  // A reference that puts the cursor there (as a widget's reveal() does).
  await content(panel).locator('[data-explain-ref="state"]').first().click();
  await expect(page.locator('.statusbar')).toContainText('Ln 16');
  await expect.poll(scrolled).toBe(0);
  // And a step.
  await editorLines(page).click();
  await command(page, 'Go to Line/Column', true);
  await page.keyboard.type('44');
  await page.keyboard.press('Enter');
  await page.keyboard.press('End');
  await expect.poll(scrolled).toBeLessThan(-100);
  await chooseStep(panel, 'refill');
  await expect(editorLines(page)).toContainText('refill below valid bits');
  await expect.poll(scrolled).toBe(0);
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

test('a file reopening with its old cursor (view state restored) does not pull the explainer back: only the reader’s own cursor moves do', async ({ page }) => {
  // The stream DMA example: step 1's dma_ctrl card references dma_ctrl.sv, step 2 is in dma_top.sv, step 3 is
  // back in dma_ctrl.sv. Reopening it for step 3 restores the cursor the reference left in step 1's code.
  const tar = execFileSync('tar', ['--no-xattrs', '-C', 'examples/stream-dma', '-cf', '-', 'rtl', '.explain']);
  execFileSync('docker', ['exec', '-i', CONTAINER, 'tar', '-C', WORKSPACE, '-xf', '-'], { input: tar });
  const panel = await openExplainer(page, 'dma-overview');
  await expect(panel.locator('.cx-position')).toHaveText('Step 1 of 7');
  await content(panel).locator('[data-explain-ref="m-ctrl"]').first().click();
  await expect(activeTab(page, 'dma_ctrl.sv')).toBeVisible();
  await expect(page.locator('.statusbar')).toContainText('Ln 10');
  const next = panel.getByRole('button', { name: 'Next step' });
  await page.waitForTimeout(700); // a reader's pace
  await next.click();
  await expect(activeTab(page, 'dma_top.sv')).toBeVisible();
  await expect(panel.locator('.cx-position')).toHaveText('Step 2 of 7');
  await page.waitForTimeout(700);
  await next.click();
  await expect(activeTab(page, 'dma_ctrl.sv')).toBeVisible();
  await expect(panel.locator('.cx-position')).toHaveText('Step 3 of 7');
  // A cursor-follow would land a moment later (debounced): still on step 3.
  await page.waitForTimeout(1_000);
  await expect(panel.locator('.cx-position')).toHaveText('Step 3 of 7');
  await next.click();
  await expect(panel.locator('.cx-position')).toHaveText('Step 4 of 7');
});

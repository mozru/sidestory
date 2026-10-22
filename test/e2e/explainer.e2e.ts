// End to end: the extension in a Linux container, VS Code and the panel in the browser.
import { expect, type FrameLocator, type Page, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { CONTAINER, WORKSPACE } from './setup.ts';

/** Runs a shell command inside the container, as the VS Code server's user. */
const inContainer = (script: string) => execFileSync('docker', ['exec', CONTAINER, 'sh', '-c', script], { encoding: 'utf8' });

async function command(page: Page, title: string): Promise<void> {
  await page.keyboard.press('F1');
  const input = page.locator('.quick-input-widget input');
  await expect(input).toBeVisible();
  await input.fill(`>${title}`);
  await page.locator('.quick-input-list .monaco-list-row').first().waitFor();
  await page.keyboard.press('Enter');
}

async function openWorkbench(page: Page): Promise<void> {
  await page.goto(`/?folder=${WORKSPACE}`);
  await page.locator('.monaco-workbench').waitFor({ timeout: 60_000 });
  // Stay in Restricted Mode: the extension declares it is safe there.
  const no = page.getByRole('button', { name: "No, I don't trust the authors" });
  if (await no.isVisible({ timeout: 5_000 }).catch(() => false)) await no.click();
  await page.locator('.tab .codicon-close').first().click({ timeout: 3_000 }).catch(() => {});
  await page.locator('.explorer-folders-view').first().click();
}

async function openExplainer(page: Page, name: string): Promise<FrameLocator> {
  await command(page, 'Code Explainer: Open Explainer');
  await page.locator('.quick-input-widget input').fill(name);
  await page.keyboard.press('Enter');
  const panel = page.frameLocator('iframe.webview.ready').last().frameLocator('#active-frame');
  await expect(panel.locator('.cx-title')).toBeVisible({ timeout: 30_000 });
  return panel;
}

const content = (panel: FrameLocator) => panel.frameLocator('iframe.cx-content-frame');
const editorLines = (page: Page) => page.locator('.editor-group-container .monaco-editor .view-lines');

test.beforeEach(async ({ page }) => {
  // A fresh copy of the fixture for every test.
  inContainer(`rm -rf ${WORKSPACE} && cp -r /home/workspace/.fixture ${WORKSPACE} 2>/dev/null || true`);
  await openWorkbench(page);
});

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
  await panel.getByRole('button', { name: /Step 5: Refill/ }).click();
  await expect(page.locator('.tab.active')).toContainText('bit_reader.sv');
  await expect(editorLines(page)).toContainText('refill below valid bits');
  await expect(panel.locator('.cx-position')).toHaveText('Step 5 of 5');
});

test('moving the cursor in the code moves the explainer', async ({ page }) => {
  const panel = await openExplainer(page, 'bit-reader');
  await panel.getByRole('button', { name: /Step 1: Interface/ }).click();
  await expect(page.locator('.tab.active')).toContainText('bit_reader.sv');
  await page.locator('.editor-group-container .monaco-editor').first().click();
  await command(page, 'Go to Line/Column');
  await page.keyboard.type('32');
  await page.keyboard.press('Enter');
  await expect(panel.getByRole('button', { name: /Step 4: Consume/ })).toHaveAttribute('aria-current', 'step');
});

test('edits to the explainer file appear live, without a reload', async ({ page }) => {
  const panel = await openExplainer(page, 'bit-reader');
  await panel.getByRole('button', { name: /Step 3: Handshakes/ }).click();
  inContainer(`sed -i 's/Three one-line rules/Three tiny rules/' ${WORKSPACE}/.explain/bit-reader/explainer.html`);
  await expect(content(panel).locator('[data-explain-anchor="handshakes"] h2')).toHaveText('Three tiny rules');
  await expect(panel.locator('.cx-position')).toHaveText('Step 3 of 5');
});

test('unsaved code edits keep sections linked and following the code', async ({ page }) => {
  const panel = await openExplainer(page, 'bit-reader');
  await panel.getByRole('button', { name: /Step 1: Interface/ }).click();
  await page.locator('.editor-group-container .monaco-editor').first().click();
  await command(page, 'Go to Line/Column');
  await page.keyboard.type('1');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Home');
  await page.keyboard.type('// a new header line\n// and another\n');
  await expect(panel.locator('.cx-status')).toContainText('Linked');
  await panel.getByRole('button', { name: /Step 5: Refill/ }).click();
  await expect(editorLines(page)).toContainText('refill below valid bits');
  // The refill block now starts on line 37: the cursor there selects Refill.
  await command(page, 'Go to Line/Column');
  await page.keyboard.type('20');
  await page.keyboard.press('Enter');
  await expect(panel.getByRole('button', { name: /Step 2: State/ })).toHaveAttribute('aria-current', 'step');
});

test('images in an explainer load inside the sandboxed frame', async ({ page }) => {
  const panel = await openExplainer(page, 'retry-backoff');
  const img = content(panel).locator('img[src*="backoff.svg"]');
  await expect(img).toBeAttached();
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
});

for (const theme of ['Default Dark Modern', 'Default Light Modern', 'Default High Contrast']) {
  test(`screenshot: ${theme}`, async ({ page }, info) => {
    const panel = await openExplainer(page, 'bit-reader');
    await command(page, 'Preferences: Color Theme');
    await page.locator('.quick-input-widget input').fill(theme);
    await page.keyboard.press('Enter');
    await panel.getByRole('button', { name: /Step 2: State/ }).click();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: info.outputPath(`${theme.replace(/\W+/g, '-')}.png`) });
  });
}

// End to end: the extension in a Linux container, VS Code and the panel in the browser.
import { expect, type FrameLocator, type Page, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { CONTAINER, WORKSPACE } from './setup.ts';

/** Runs a shell command inside the container, as the VS Code server's user. */
const inContainer = (script: string) => execFileSync('docker', ['exec', CONTAINER, 'sh', '-c', script], { encoding: 'utf8' });

async function command(page: Page, title: string, keepFocus = false): Promise<void> {
  // Webviews (the walkthrough, our panel) swallow keystrokes when focused: move focus to the workbench.
  if (!keepFocus) await page.locator('.part.sidebar .composite.title').click();
  await page.keyboard.press('F1');
  await expect(page.locator('.quick-input-widget')).toBeVisible();
  await page.keyboard.type(title);
  // Pick the exact command, not whatever the fuzzy match ranks first.
  const row = page.locator('.quick-input-list .monaco-list-row', { has: page.locator('.label-name', { hasText: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(\\.\\.\\.|…)?$`) }) }).first();
  await row.click();
}

async function openWorkbench(page: Page): Promise<void> {
  await page.goto(`/?folder=${WORKSPACE}`);
  await page.locator('.monaco-workbench').waitFor({ timeout: 60_000 });
  // Stay in Restricted Mode: the extension declares it is safe there.
  const no = page.getByRole('button', { name: "No, I don't trust the authors" });
  await no.waitFor({ timeout: 15_000 }).then(() => no.click(), () => {});
  await page.locator('.explorer-folders-view').first().click();
  // Start clean: VS Code restores the previous test's editors, and opens a walkthrough a moment
  // after load. Close everything until nothing comes back for a couple of seconds.
  await expect(async () => {
    for (const tab of await page.locator('.tab').all()) {
      await tab.hover();
      await tab.locator('.codicon-close').click({ timeout: 2_000 }).catch(() => {});
    }
    await page.waitForTimeout(2_000);
    expect(await page.locator('.tab').count()).toBe(0);
  }).toPass({ timeout: 45_000 });
}

async function openExplainer(page: Page, name: string): Promise<FrameLocator> {
  // Each panel is its own webview frame; remember which one is new.
  const index = await page.locator('iframe.webview.ready').count();
  await command(page, 'Code Explainer: Open Explainer');
  await expect(page.locator('.quick-input-widget')).toContainText('retry-backoff');
  await page.keyboard.type(name);
  await page.keyboard.press('Enter');
  await expect(page.locator('iframe.webview.ready')).toHaveCount(index + 1, { timeout: 30_000 });
  const panel = page.frameLocator('iframe.webview.ready').nth(index).frameLocator('#active-frame');
  await expect(panel.locator('.cx-title')).toBeVisible({ timeout: 30_000 });
  return panel;
}

/** Picks a step whether the panel shows tabs or (when narrow) a picker. */
async function chooseStep(panel: FrameLocator, id: string): Promise<void> {
  const tab = panel.locator(`.cx-step[data-anchor="${id}"]`);
  if (await tab.isVisible()) await tab.click();
  else await panel.locator('.cx-step-select').selectOption(id);
}

const content = (panel: FrameLocator) => panel.frameLocator('iframe.cx-content-frame');
const codeEditor = (page: Page, file: string) => page.locator(`.monaco-editor[data-uri$="${file}"]`);
const editorLines = (page: Page) => codeEditor(page, 'bit_reader.sv').locator('.view-lines');
const activeTab = (page: Page, name: string) => page.locator('.tab.active', { hasText: name });

test.beforeEach(async ({ page }) => {
  // A fresh copy of the fixture for every test.
  // Also forget restored editors and panels from earlier tests (VS Code keeps them per workspace on the server).
  inContainer(
    `rm -rf ${WORKSPACE} ~/.openvscode-server/data/User/workspaceStorage && cp -r /home/workspace/.fixture ${WORKSPACE} && cp /home/workspace/.settings.json ~/.openvscode-server/data/User/settings.json`,
  );
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

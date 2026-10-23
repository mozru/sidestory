// Helpers shared by the end-to-end specs: driving browser VS Code in the test container.
import { expect, type FrameLocator, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { CONTAINER, WORKSPACE } from './setup.ts';

/** Runs a shell command inside the container, as the VS Code server's user. */
export const inContainer = (script: string) => execFileSync('docker', ['exec', CONTAINER, 'sh', '-c', script], { encoding: 'utf8' });

export async function command(page: Page, title: string, keepFocus = false): Promise<void> {
  // Webviews (the walkthrough, our panel) swallow keystrokes when focused: move focus to the workbench.
  if (!keepFocus) await page.locator('.part.sidebar .composite.title').click();
  await page.keyboard.press('F1');
  await expect(page.locator('.quick-input-widget')).toBeVisible();
  await page.keyboard.type(title);
  // Pick the exact command, not whatever the fuzzy match ranks first.
  const row = page.locator('.quick-input-list .monaco-list-row', { has: page.locator('.label-name', { hasText: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(\\.\\.\\.|…)?$`) }) }).first();
  await row.click();
}

export async function openWorkbench(page: Page): Promise<void> {
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
  // The Chat side bar can open despite workbench.secondarySideBar.defaultVisibility; it narrows the
  // panel enough to reflow the step tabs while a test clicks them.
  if (await page.locator('.part.auxiliarybar').isVisible()) {
    await command(page, 'View: Toggle Secondary Side Bar Visibility');
    await expect(page.locator('.part.auxiliarybar')).toBeHidden();
  }
}

export async function openExplainer(page: Page, name: string): Promise<FrameLocator> {
  // Each panel is its own webview frame; remember which one is new.
  const index = await page.locator('iframe.webview.ready').count();
  await command(page, 'Sidestory: Open Sidestory');
  await expect(page.locator('.quick-input-widget')).toContainText('retry-backoff');
  await page.keyboard.type(name);
  await page.keyboard.press('Enter');
  await expect(page.locator('iframe.webview.ready')).toHaveCount(index + 1, { timeout: 30_000 });
  const panel = page.frameLocator('iframe.webview.ready').nth(index).frameLocator('#active-frame');
  await expect(panel.locator('.cx-title')).toBeVisible({ timeout: 30_000 });
  return panel;
}

/** Picks a step whether the panel shows tabs or (when narrow) a picker. */
export async function chooseStep(panel: FrameLocator, id: string): Promise<void> {
  const tab = panel.locator(`.cx-step[data-anchor="${id}"]`);
  if (await tab.isVisible()) await tab.click();
  else await panel.locator('.cx-step-select').selectOption(id);
}

export const content = (panel: FrameLocator) => panel.frameLocator('iframe.cx-content-frame');
export const codeEditor = (page: Page, file: string) => page.locator(`.monaco-editor[data-uri$="${file}"]`);
export const editorLines = (page: Page) => codeEditor(page, 'bit_reader.sv').locator('.view-lines');
export const activeTab = (page: Page, name: string) => page.locator('.tab.active', { hasText: name });

/** A fresh copy of the fixture workspace and settings, then a clean workbench. */
export async function resetWorkbench(page: Page): Promise<void> {
  // A fresh copy of the fixture for every test.
  // Also forget restored editors and panels from earlier tests (VS Code keeps them per workspace on the server).
  inContainer(
    `rm -rf ${WORKSPACE} ~/.openvscode-server/data/User/workspaceStorage && cp -r /home/workspace/.fixture ${WORKSPACE} && cp /home/workspace/.settings.json ~/.openvscode-server/data/User/settings.json`,
  );
  await openWorkbench(page);
}

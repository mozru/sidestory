// Explained here (docs/NAVIGATION-PLAN.md §7, §12.3): CodeLens and the status bar item, in stream-dma's RTL.
import { expect, test } from '@playwright/test';
import { command, resetWorkbench } from './helpers.ts';
import { lenses, openFile } from './nav-helpers.ts';

const TOP = 'A stream DMA engine, block by block';
const CTRL = 'dma_ctrl: the control FSM';

test.beforeEach(async ({ page }) => {
  await resetWorkbench(page);
});

test('dma_ctrl.sv shows lenses naming the path and step; opening one hides that sidestory’s lenses', async ({ page }, info) => {
  await openFile(page, 'stream-dma/rtl/dma_ctrl.sv');
  const ctrlLens = lenses(page, 'dma_ctrl.sv').filter({ hasText: `${TOP} › ${CTRL} · step` });
  await expect(ctrlLens.first()).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: info.outputPath('codelens.png') });
  // Two regions start on line 10 (the overview's and dma_ctrl's): one lens, "and 1 more", which asks which.
  const first = ctrlLens.first();
  const text = (await first.textContent()) ?? '';
  const step = /step (\d+)/.exec(text)?.[1];
  await first.locator('a').first().click();
  if (text.includes('more')) {
    await expect(page.locator('.quick-input-widget')).toBeVisible();
    await page.keyboard.type('control FSM');
    await page.keyboard.press('Enter');
  }
  const panel = page.frameLocator('iframe.webview.ready').last().frameLocator('#active-frame');
  await expect(panel.locator('.cx-title')).toHaveText(CTRL, { timeout: 30_000 });
  await expect(panel.locator('.cx-position')).toHaveText(new RegExp(`^Step ${step} of`));
  // Every lens for the open sidestory is gone, and stepping doesn't bring any back.
  await expect(lenses(page, 'dma_ctrl.sv').filter({ hasText: `› ${CTRL} ·`, visible: true })).toHaveCount(0);
  await expect(lenses(page, 'dma_ctrl.sv').filter({ visible: true }).first()).toContainText('block by block · step 1');
  await panel.locator('.cx-footer').getByRole('button', { name: 'Next step' }).click();
  await page.waitForTimeout(800);
  await expect(lenses(page, 'dma_ctrl.sv').filter({ hasText: `› ${CTRL} ·`, visible: true })).toHaveCount(0);
});

test('the status bar names the sidestory for the cursor’s line, on the right, only when no panel shows it', async ({ page }) => {
  await openFile(page, 'stream-dma/rtl/dma_ctrl.sv');
  await expect(lenses(page, 'dma_ctrl.sv').first()).toBeVisible({ timeout: 30_000 });
  // Put the cursor on a line a lens sits above (the line right below the lens).
  await command(page, 'Go to Line/Column...');
  await page.keyboard.type('20');
  await page.keyboard.press('Enter');
  const item = page.locator('.statusbar .statusbar-item.right', { hasText: /A stream DMA|dma_/ }).first();
  await expect(item).toBeVisible({ timeout: 15_000 });
});

test('typing above a region moves its lens; turning the setting off removes lenses', async ({ page }) => {
  await openFile(page, 'stream-dma/rtl/dma_ctrl.sv');
  const first = lenses(page, 'dma_ctrl.sv').first();
  await expect(first).toBeVisible({ timeout: 30_000 });
  const before = await first.boundingBox();
  await page.locator('.monaco-editor[data-uri$="dma_ctrl.sv"] .view-line').first().click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await lenses(page, 'dma_ctrl.sv').first().boundingBox())?.y ?? 0, { timeout: 10_000 }).toBeGreaterThan((before?.y ?? 0) + 20);
  // Through the Settings UI: the setting by id.
  await command(page, 'Preferences: Open Settings (UI)');
  await page.keyboard.type('sidestory.codeLens.enabled');
  const box = page.locator('.setting-item-bool', { hasText: 'Code Lens' }).locator('.setting-value-checkbox').first();
  await box.click();
  await page.locator('.tab', { hasText: 'dma_ctrl.sv' }).click();
  await expect(lenses(page, 'dma_ctrl.sv')).toHaveCount(0, { timeout: 15_000 });
});

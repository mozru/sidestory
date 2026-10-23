// Go to Step (docs/NAVIGATION-PLAN.md §9, §12.3).
import { expect, test } from '@playwright/test';
import { command, resetWorkbench } from './helpers.ts';
import { openFile } from './nav-helpers.ts';

test.beforeEach(async ({ page }) => {
  await resetWorkbench(page);
});

test('"backpressure" finds the step, the scope toggles, and Enter opens at the step', async ({ page }, info) => {
  await openFile(page, 'stream-dma/rtl/dma_wr_port.sv');
  await command(page, 'Sidestory: Go to Step');
  const qp = page.locator('.quick-input-widget');
  // This package by default (more than one package, and the file belongs to one).
  await expect(qp.locator('.quick-input-title')).toContainText('Go to Step: stream-dma');
  await page.keyboard.type('backpressure');
  const first = qp.locator('.quick-input-list .monaco-list-row').first();
  await expect(first).toContainText('Backpressure');
  await page.screenshot({ path: info.outputPath('go-to-step.png') });
  // The toggle: all packages.
  await qp.locator('.quick-input-titlebar .action-label, .quick-input-header .action-label').first().click();
  await expect(qp.locator('.quick-input-title')).toContainText('All packages');
  await page.keyboard.press('Enter');
  const panel = page.frameLocator('iframe.webview.ready').last().frameLocator('#active-frame');
  await expect(panel.locator('.cx-title')).toHaveText(/backpressure|block by block/i, { timeout: 30_000 });
  await expect(panel.locator('.cx-step.cx-active, .cx-step[aria-current="step"]').first()).toContainText(/Backpressure/i);
});

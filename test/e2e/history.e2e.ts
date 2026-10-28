// Back / Forward and VS Code's own shortcuts while the panel has focus, in real VS Code: keys pressed in the content
// frame reach the workbench (src/webview/keys.ts), and VS Code's navigate keys run Sidestory: Back / Forward.
import { expect, test } from '@playwright/test';
import { chooseStep, content, openExplainer, resetWorkbench } from './helpers.ts';

test.beforeEach(async ({ page }) => resetWorkbench(page));

// VS Code's keybindings follow the browser's platform.
const mac = process.platform === 'darwin';
const BACK = mac ? 'Control+Minus' : process.platform === 'linux' ? 'Control+Alt+Minus' : 'Alt+ArrowLeft';
const FORWARD = process.platform === 'win32' ? 'Alt+ArrowRight' : 'Control+Shift+Minus';

test('F1 pressed in the content opens the Command Palette', async ({ page }) => {
  const panel = await openExplainer(page, 'bit-reader');
  await content(panel).locator('[data-explain-anchor] h2').first().click();
  await page.keyboard.press('F1');
  await expect(page.locator('.quick-input-widget')).toBeVisible();
  await page.keyboard.press('Escape');
});

test('VS Code’s Back and Forward keys move through the panel’s history, from the content and from the panel', async ({ page }) => {
  const panel = await openExplainer(page, 'bit-reader');
  const back = panel.locator('.cx-hist[data-delta="-1"]');
  await expect(back).toHaveAttribute('aria-disabled', 'true');
  await chooseStep(panel, 'refill');
  await expect(panel.locator('.cx-position')).toHaveText('Step 5 of 5');
  await expect(back).toHaveAttribute('aria-disabled', 'false');
  await content(panel).locator('[data-explain-anchor="refill"] h2').first().click();
  await page.keyboard.press(BACK);
  await expect(panel.locator('.cx-position')).toHaveText('Step 1 of 5');
  // From the panel's own chrome too (VS Code's webview host passes these on itself).
  await panel.locator('.cx-title').click();
  await page.keyboard.press(FORWARD);
  await expect(panel.locator('.cx-position')).toHaveText('Step 5 of 5');
  // The button.
  await back.click();
  await expect(panel.locator('.cx-position')).toHaveText('Step 1 of 5');
});

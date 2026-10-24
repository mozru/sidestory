// End to end: diagrams that follow the steps (data-explain-on), in the stream-dma overview (docs/AUTHORING-PLAN.md §2).
import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { CONTAINER, WORKSPACE } from './setup.ts';
import { activeTab, chooseStep, content, openExplainer, resetWorkbench } from './helpers.ts';

test.beforeEach(async ({ page }) => resetWorkbench(page));

test('stepping with Alt+] lights the overview’s block diagram, and a diagram box opens its code', async ({ page }) => {
  const tar = execFileSync('tar', ['--no-xattrs', '-C', 'examples/stream-dma', '-cf', '-', 'rtl', '.sidestory']);
  execFileSync('docker', ['exec', '-i', CONTAINER, 'tar', '-C', WORKSPACE, '-xf', '-'], { input: tar });
  const panel = await openExplainer(page, 'dma-overview');
  const dia = content(panel).locator('figure[data-explain-diagram]').first();
  const block = (id: string) => dia.locator(`[data-block="${id}"]`);
  // Step 1 is about the whole engine: nothing is lit, nothing fades.
  await expect(panel.locator('.cx-position')).toHaveText('Step 1 of 7');
  await expect(dia).not.toHaveClass(/cx-dimming/);
  await expect(content(panel).locator('figure[data-explain-diagram] .cx-dim')).toHaveCount(0);

  await chooseStep(panel, 'control');
  await expect(activeTab(page, 'dma_top.sv')).toBeVisible();
  await expect(dia).toHaveClass(/cx-dimming/);
  await expect(block('ctrl')).toHaveClass(/cx-on/);
  await expect(block('fifo')).toHaveClass(/cx-dim/);
  await expect(block('ctrl')).toHaveCSS('opacity', '1');
  await expect(block('fifo')).toHaveCSS('opacity', '0.28');

  // Alt+] from the editor (Ctrl+Option+] on macOS, where the browser's VS Code takes the mac binding): the data path.
  await page.locator('.monaco-editor .view-lines').first().click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Control+Alt+BracketRight' : 'Alt+BracketRight');
  await expect(panel.locator('.cx-position')).toHaveText('Step 5 of 7');
  await expect(block('fifo')).toHaveClass(/cx-on/);
  await expect(block('csr')).toHaveClass(/cx-dim/);
  await expect(dia.locator('[data-wire="fifo_rdata"]')).toHaveClass(/cx-on/);
  await expect(dia.locator('[data-wire="start"]')).toHaveClass(/cx-dim/);
  // The legend never fades.
  await expect(dia.locator('[data-explain-keep] .cx-dim, [data-explain-keep].cx-dim')).toHaveCount(0);

  // A box in the diagram is a link to its module.
  await block('fifo').click();
  await expect(activeTab(page, 'dma_fifo.sv')).toBeVisible();
  await expect(panel.locator('.cx-position')).toHaveText('Step 5 of 7');
});

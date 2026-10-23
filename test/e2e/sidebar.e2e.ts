// The Sidestories view (docs/NAVIGATION-PLAN.md §8, §12.3). The workspace has three packages: the sample's own
// .sidestory/, services/auth/.sidestory/ (a grouped detail) and stream-dma/.sidestory/.
import { expect, test } from '@playwright/test';
import { inContainer, openWorkbench, resetWorkbench } from './helpers.ts';
import { expand, openSidebar, rows, sidebar, treeRow, viewAction } from './nav-helpers.ts';
import { WORKSPACE } from './setup.ts';

test.beforeEach(async ({ page }) => {
  await resetWorkbench(page);
});

test('the activity bar icon opens the Sidestories view: packages, Start here, details in HTML order', async ({ page }, info) => {
  await openSidebar(page);
  await expect(treeRow(page, 'stream-dma')).toBeVisible({ timeout: 30_000 });
  await expect(treeRow(page, 'services/auth')).toBeVisible();
  // Start here: dma-overview, by the *-overview rule, pinned first in its package.
  const top = treeRow(page, 'A stream DMA engine, block by block');
  await expect(top).toBeVisible();
  await expect(top.locator('.label-description')).toContainText('Start here');
  await expand(top);
  const detailsOf = async () => {
    const all = await rows(page);
    const at = all.findIndex((r) => r.label === 'A stream DMA engine, block by block');
    const level = all[at]!.level;
    const after = all.slice(at + 1);
    const end = after.findIndex((r) => r.level <= level);
    return (end < 0 ? after : after.slice(0, end)).filter((r) => r.level === level + 1).map((r) => r.label);
  };
  await expect.poll(detailsOf).toEqual([
    'dma_csr: the registers software sees',
    'dma_ctrl: the control FSM',
    'dma_addr_gen: bursts that never cross 4 KB',
    'dma_rd_port: one read burst at a time',
    'dma_fifo: slack between read and write',
    'dma_packer: realigning bytes',
    'dma_wr_port: write bursts and backpressure',
  ]);
  // A grouped sidestory that is also a detail: under its group, saying where else it is.
  const grouped = treeRow(page, 'Session tokens');
  await expect(grouped.locator('.label-description')).toContainText('also under Auth overview');
  await page.screenshot({ path: info.outputPath('sidebar.png') });
});

test('expansion is kept across a refresh', async ({ page }) => {
  await openSidebar(page);
  const top = treeRow(page, 'A stream DMA engine, block by block');
  await expand(top);
  await viewAction(page, 'Refresh');
  await page.waitForTimeout(1500);
  await expect(treeRow(page, 'dma_fifo: slack between read and write')).toBeVisible();
});

test('clicking a detail opens it with its top on the trail, and Back returns to the top', async ({ page }) => {
  await openSidebar(page);
  await expand(treeRow(page, 'A stream DMA engine, block by block'));
  await treeRow(page, 'dma_fifo: slack between read and write').click();
  const panel = page.frameLocator('iframe.webview.ready').last().frameLocator('#active-frame');
  await expect(panel.locator('.cx-title')).toHaveText('dma_fifo: slack between read and write', { timeout: 30_000 });
  await expect(panel.getByRole('navigation', { name: 'Sidestory path' })).toContainText('A stream DMA engine, block by block');
  await panel.locator('.cx-back').click();
  await expect(panel.locator('.cx-title')).toHaveText('A stream DMA engine, block by block');
});

test('the filter shows each match once under its path; Clear restores everything; no match shows a message', async ({ page }) => {
  await openSidebar(page);
  await viewAction(page, 'Filter');
  await expect(page.locator('.quick-input-widget')).toContainText('Matches titles');
  await page.locator('.quick-input-widget input').fill('fifo');
  await page.keyboard.press('Enter');
  await expect(page.locator('.quick-input-widget')).toBeHidden();
  await expect(sidebar(page).locator('.pane-body')).toContainText('Filtered by "fifo": 3 sidestories');
  await expect(treeRow(page, 'dma_fifo: slack between read and write')).toBeVisible();
  const labels = (await rows(page)).map((r) => r.label);
  // Matches in summaries too (the read port and the overview mention the FIFO); each shown once, on its path.
  expect(labels.filter((l) => l.startsWith('dma_fifo'))).toHaveLength(1);
  expect(labels.filter((l) => l.startsWith('dma_rd_port'))).toHaveLength(1);
  expect(labels).not.toContain('Auth overview');
  await viewAction(page, 'Clear Filter');
  await expect(treeRow(page, 'Auth overview')).toBeVisible();
  await expect(sidebar(page).locator('.pane-body')).not.toContainText('Filtered by');
  await viewAction(page, 'Filter');
  await expect(page.locator('.quick-input-widget')).toContainText('Matches titles');
  await page.locator('.quick-input-widget input').fill('zzzz-nothing');
  await page.keyboard.press('Enter');
  await expect(page.locator('.quick-input-widget')).toBeHidden();
  await expect(sidebar(page).locator('.pane-body')).toContainText('Filtered by "zzzz-nothing": 0 sidestories');
  await expect(sidebar(page).locator('.welcome-view')).toHaveCount(0);
  await viewAction(page, 'Clear Filter');
});

test('tooltips are plain text', async ({ page }) => {
  await openSidebar(page);
  // A plain-string tooltip becomes part of the row's accessible name; a MarkdownString would render links.
  await expect(treeRow(page, 'Auth overview')).toHaveAttribute('aria-label', /\.sidestory\/auth-overview/);
  await treeRow(page, 'Auth overview').hover();
  await page.waitForTimeout(1500);
  await expect(page.locator('.monaco-hover a, .workbench-hover a')).toHaveCount(0);
});

test('a drift badge appears after a heavy edit to anchored code', async ({ page }) => {
  await openSidebar(page);
  await expect(treeRow(page, 'Session tokens')).toBeVisible();
  inContainer(`printf '// rewritten\\nexport const nothing = 0;\\n' > ${WORKSPACE}/services/auth/src/tokens.ts`);
  await viewAction(page, 'Refresh');
  await expect(treeRow(page, 'Session tokens').locator('.label-description')).toContainText('lost', { timeout: 30_000 });
});

test('a title with icon syntax shows literally in the picker, and without a backslash in the tree', async ({ page }) => {
  inContainer(
    `mkdir -p ${WORKSPACE}/.sidestory/alert && printf '%s' '{"version":2,"title":"Alert $(alert) here","anchors":{}}' > ${WORKSPACE}/.sidestory/alert/manifest.json && printf '<p>x</p>' > ${WORKSPACE}/.sidestory/alert/sidestory.html`,
  );
  await openWorkbench(page);
  await openSidebar(page);
  await expect(treeRow(page, 'Alert $(alert) here')).toBeVisible({ timeout: 30_000 });
  const { command } = await import('./helpers.ts');
  await command(page, 'Sidestory: Open Sidestory');
  await expect(page.locator('.quick-input-widget input')).toHaveAttribute('placeholder', /Open which sidestory/);
  await page.keyboard.type('alert');
  await expect(page.locator('.quick-input-list .monaco-list-row').first()).toContainText('Alert $(alert) here');
  await page.keyboard.press('Escape');
});

test('the welcome view in a folder with no sidestories, through Show Sidestories', async ({ page }, info) => {
  inContainer('rm -rf /home/workspace/empty && mkdir -p /home/workspace/empty && echo hi > /home/workspace/empty/readme.txt');
  await page.goto('/?folder=/home/workspace/empty');
  await page.locator('.monaco-workbench').waitFor({ timeout: 60_000 });
  const no = page.getByRole('button', { name: "No, I don't trust the authors" });
  await no.waitFor({ timeout: 15_000 }).then(() => no.click(), () => {});
  const { command } = await import('./helpers.ts');
  await command(page, 'Sidestory: Show Sidestories');
  await expect(sidebar(page)).toContainText('No sidestories in this workspace yet', { timeout: 30_000 });
  await expect(sidebar(page).getByRole('button', { name: 'Copy a Prompt for Your Agent' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('welcome.png') });
});

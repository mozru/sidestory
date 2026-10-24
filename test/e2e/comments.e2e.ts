// docs/COMMENTS-PLAN.md §13.4: comments in browser VS Code, with the real MCP server and a scripted Claude.
import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { command, inContainer, openExplainer, resetWorkbench } from './helpers.ts';
import { CONTAINER, WORKSPACE } from './setup.ts';

const STATE = '~/.local/state/sidestory';
const shots = 'test-results/screenshots';
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

test.beforeEach(async ({ page }) => {
  inContainer(`(pkill -f '[f]ake-claude' || true); rm -rf ${STATE}`);
  await resetWorkbench(page);
  mkdirSync(shots, { recursive: true });
});

test('a step comment lands in the local tier; Ask Claude goes through a chosen session and the reply shows', async ({ page }) => {
  const panel = await openExplainer(page, 'bit-reader');
  await panel.locator('.cx-scroll').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('c');
  await panel.locator('.cx-c-composer textarea').fill('A plain note for later.');
  await page.keyboard.press(`${mod}+Enter`);
  await expect(panel.locator('.cx-c-card')).toHaveCount(1, { timeout: 20_000 });
  expect(inContainer(`cat ${WORKSPACE}/.sidestory/.local/.gitignore`)).toBe('*\n');
  expect(inContainer(`ls ${WORKSPACE}/.sidestory/.local/bit-reader/threads/*/ | wc -l`).trim()).toBe('1');

  // A scripted Claude: the real server, an undetected channel (its parent isn't claude), so the reader picks it.
  execFileSync('docker', ['cp', 'test/e2e/fake-claude.cjs', `${CONTAINER}:/tmp/fake-claude.cjs`]);
  execFileSync('docker', ['exec', '-d', CONTAINER, 'sh', '-c', `"$OPENVSCODE_SERVER_ROOT/node" /tmp/fake-claude.cjs "$(ls -d ~/.openvscode-server/extensions/paperkite.sidestory-*/dist/mcp.cjs | tail -n 1)" ${WORKSPACE} > /tmp/fake.log 2>&1`]);
  await expect.poll(() => inContainer(`ls ${STATE}/sessions 2>/dev/null | wc -l`).trim(), { timeout: 20_000 }).toBe('1');

  await panel.locator('.cx-scroll').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('a');
  await panel.locator('.cx-c-composer textarea').fill('Why does ready drop for one cycle?');
  await page.keyboard.press(`${mod}+Enter`);
  const delivery = panel.locator('.cx-c-delivery');
  await expect(delivery).toContainText("No Claude session with Sidestory's channel is running here", { timeout: 20_000 });
  await delivery.getByRole('button', { name: 'Choose a Session…' }).click();
  const pick = page.locator('.quick-input-widget');
  await expect(pick).toContainText('channel not detected');
  await page.keyboard.press('Enter');
  await expect(panel.locator('.cx-c-comment.cx-claude')).toContainText('Equal jitter keeps half of the delay fixed', { timeout: 30_000 });
  await expect(panel.locator('.cx-c-comment.cx-claude .cx-c-author')).toHaveText(/^Claude/);
  await expect(panel.locator('.cx-c-suggest')).toContainText('Claude thinks this is done');
  await page.screenshot({ path: `${shots}/comments-claude-reply.png` });
  // The session that answered is confirmed now: it becomes the send button's target.
  expect(inContainer(`cat ${STATE}/sessions/*.json`)).toContain('"channel":"confirmed"');
  expect(inContainer('cat /tmp/fake.log')).toMatch(/reply \{.*"event/);

  // The Comments view lists both threads.
  await command(page, 'Sidestory: Focus on Comments View');
  const view = page.locator('.pane', { has: page.locator('.pane-header', { hasText: 'Comments' }) });
  await expect(view.locator('.monaco-list-row')).not.toHaveCount(0, { timeout: 20_000 });
  await expect(view).toContainText('For you (1)');
  await expect(view).toContainText('A backward bit reader in five moves › interface');
  await page.screenshot({ path: `${shots}/comments-view.png` });
});

test('Copy Prompt with no session: fixed text, a data block, the comment last', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const panel = await openExplainer(page, 'bit-reader');
  await panel.locator('.cx-scroll').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('a');
  await panel.locator('.cx-c-composer textarea').fill('What is cnt_q for?');
  await page.keyboard.press(`${mod}+Enter`);
  const delivery = panel.locator('.cx-c-delivery');
  await expect(delivery).toContainText('No Claude session', { timeout: 20_000 });
  await delivery.getByRole('button', { name: 'Copy Prompt' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 10_000 }).toContain('My comment:\n\nWhat is cnt_q for?');
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text.startsWith('Answer my comment in the Sidestory thread below.')).toBe(true);
  expect(text).toContain('sidestory: bit-reader');
});

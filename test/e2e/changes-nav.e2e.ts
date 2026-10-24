// The Changes view as a navigator (docs/CHANGES-PLAN.md §9.1–§9.9, §16.3 changes-nav), on a git fixture with no
// sidestory: `feature` adds, modifies, deletes and renames files in three commits, and `main` moved on after the
// fork, so only the three-dot merge diff leaves main-only.ts and docs/notes.md out.
import { expect, type Locator, type Page, test } from '@playwright/test';
import { command, inContainer } from './helpers.ts';
import { viewAction } from './nav-helpers.ts';

const REPO = '/home/workspace/chg';
const mac = process.platform === 'darwin';
const NEXT = mac ? 'Control+Meta+ArrowDown' : 'Control+Alt+PageDown';
const PREV = mac ? 'Control+Meta+ArrowUp' : 'Control+Alt+PageUp';
const gitIn = (args: string) => inContainer(`cd ${REPO} && git -c user.name=E2E -c user.email=e2e@example.com ${args}`);

const changes = (page: Page) => page.locator('.pane', { has: page.locator('.pane-header', { hasText: /^Changes/ }) }).first();
const row = (page: Page, label: string) => changes(page).locator('.monaco-list-row', { has: page.locator('.label-name', { hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) }).first();
const labels = (page: Page) => changes(page).locator('.monaco-list-row .label-name').allTextContents();
const description = (page: Page) => changes(page).locator('.pane-header .description').textContent();

async function openRepo(page: Page): Promise<void> {
  inContainer(`rm -rf ${REPO} ~/.openvscode-server/data/User/workspaceStorage && cp -r /home/workspace/.chg-fixture ${REPO} && cp /home/workspace/.settings.json ~/.openvscode-server/data/User/settings.json`);
  await page.goto(`/?folder=${REPO}`);
  await page.locator('.monaco-workbench').waitFor({ timeout: 60_000 });
  // A trusted workspace: VS Code's git extension doesn't run in Restricted Mode (§16.3's trusted project).
  const yes = page.getByRole('button', { name: 'Yes, I trust the authors' });
  await yes.waitFor({ timeout: 15_000 }).then(() => yes.click(), () => {});
  // Close whatever the workbench restores or opens on its own.
  await expect(async () => {
    for (const tab of await page.locator('.tab').all()) {
      await tab.hover();
      await tab.locator('.codicon-close').click({ timeout: 2_000 }).catch(() => {});
    }
    await page.waitForTimeout(1_000);
    expect(await page.locator('.tab').count()).toBe(0);
  }).toPass({ timeout: 45_000 });
  if (await page.locator('.part.auxiliarybar').isVisible()) await command(page, 'View: Toggle Secondary Side Bar Visibility');
  // No sidestory here: the container appears because the branch has commits of its own (§9.1).
  const icon = page.locator('.activitybar .action-item a[aria-label^="Sidestory"]').first();
  await expect(icon).toBeVisible({ timeout: 60_000 });
  if (!(await changes(page).isVisible())) await icon.click();
  await expect(changes(page)).toBeVisible();
  await expect(row(page, 'retry.ts')).toBeVisible({ timeout: 30_000 });
}

/** A row's description and its status letter (our file decoration). */
const rowInfo = async (r: Locator) => ({
  description: (await r.locator('.label-description').textContent())?.trim(),
  // The badge is drawn by CSS (::after), as in the Explorer.
  letter: await r.locator('.monaco-icon-label').first().evaluate((el) => getComputedStyle(el, '::after').content.replace(/"/g, '')),
});

test.beforeEach(async ({ page }) => {
  await openRepo(page);
});

test('a branch with no sidestory: the container, the merge diff as compact folders, letters and counts', async ({ page }, info) => {
  // Changes is first, Sidestories below it.
  const headers = await page.locator('.part.sidebar .pane-header .title').allTextContents();
  expect(headers.slice(0, 2).map((h) => h.trim())).toEqual(['Changes', 'Sidestories']);
  const mb = inContainer(`cd ${REPO} && git merge-base main feature`).trim().slice(0, 7);
  await expect.poll(() => description(page)).toBe(`vs main @ ${mb} · 3 commits · uncommitted`);
  expect(await labels(page)).toEqual(['legacy', 'sleep.ts', 'src/retry', 'backoff.ts', 'jitter.ts', 'retry.ts', 'test', 'retry.test.ts']);
  // Exact with numstat against the working tree (newer VS Code); counted file by file before, where a rename stays uncounted.
  await expect.poll(async () => (await rowInfo(row(page, 'src/retry'))).description).toMatch(/^3 files · \+(25 −3|23 −1 · 1 uncounted)$/);
  await expect.poll(() => rowInfo(row(page, 'retry.ts'))).toEqual({ description: '+4 −1', letter: 'M' });
  await expect.poll(() => rowInfo(row(page, 'jitter.ts'))).toEqual({ description: '+19', letter: 'A' });
  await expect.poll(() => rowInfo(row(page, 'sleep.ts'))).toEqual({ description: '−24', letter: 'D' });
  await expect.poll(() => rowInfo(row(page, 'backoff.ts'))).toMatchObject({ description: expect.stringMatching(/^← old\/backoff\.ts( · \+2 −2)?$/), letter: 'R' });
  // main's commits after the fork aren't in the merge diff.
  expect(await labels(page)).not.toContain('main-only.ts');
  expect(await labels(page)).not.toContain('notes.md');
  await page.screenshot({ path: info.outputPath('changes-tree.png') });
});

test('list mode and sort by size; the filter narrows live and Clear restores', async ({ page }, info) => {
  await viewAction(page, 'View as List', changes(page));
  await expect(row(page, 'src/retry')).toBeHidden();
  await expect(row(page, 'retry.ts').locator('.label-description')).toHaveText('src/retry · +4 −1');
  await command(page, 'Sidestory: Sort Changed Files…');
  await page.locator('.quick-input-list .monaco-list-row', { hasText: 'By Size of Change' }).click();
  await expect.poll(() => labels(page)).toEqual(['retry.test.ts', 'sleep.ts', 'jitter.ts', 'retry.ts', 'backoff.ts']);
  await page.screenshot({ path: info.outputPath('changes-list.png') });

  await viewAction(page, 'Filter Changed Files', changes(page));
  await expect(page.locator('.quick-input-widget')).toContainText('Filter Changed Files');
  await page.keyboard.type('src/**/*.ts !jitter');
  await expect.poll(() => labels(page)).toEqual(['retry.ts', 'backoff.ts']);
  await page.keyboard.press('Enter');
  await expect(changes(page).locator('.message')).toContainText('Filtered by “src/**/*.ts !jitter”: 2 of 5 files');
  await viewAction(page, 'Clear Changes Filter', changes(page));
  await expect.poll(async () => (await labels(page)).length).toBe(5);
  await viewAction(page, 'View as Tree', changes(page));
  await expect(row(page, 'src/retry')).toBeVisible();
});

test('a click opens the merge diff, read-only on the left; Next/Previous walk the files and wrap; inline Open File', async ({ page }, info) => {
  await row(page, 'retry.ts').click();
  await expect(page.locator('.tab.active')).toContainText('retry.ts (main ↔ working tree)');
  const diff = page.locator('.monaco-diff-editor').first();
  await expect(diff).toBeVisible();
  await expect(diff.locator('.editor.original .monaco-editor')).toHaveAttribute('data-uri', /^sidestory-git:\/\/[0-9a-f]{16}\/src\/retry\/retry\.ts\?[0-9a-f]{40}$/);
  await expect(diff.locator('.editor.modified .monaco-editor')).toHaveAttribute('data-uri', /^(file|vscode-remote):\/\/.*\/home\/workspace\/chg\/src\/retry\/retry\.ts$/);
  await expect(diff.locator('.editor.modified .view-lines')).toContainText('export const retryWithJitter = 1;');
  await page.screenshot({ path: info.outputPath('merge-diff.png') });

  // From the active diff: the next file in tree order, then the wrap to the first.
  await diff.locator('.editor.modified .view-lines').click();
  await page.waitForTimeout(500);
  await page.keyboard.press(NEXT);
  await expect(page.locator('.tab.active')).toContainText('retry.test.ts (main ↔ working tree)');
  await expect(row(page, 'retry.test.ts')).toHaveClass(/selected/);
  await page.keyboard.press(NEXT);
  await expect(page.locator('.tab.active')).toContainText('sleep.ts (main ↔ working tree)');
  await expect(page.locator('.part.statusbar')).toContainText('Back to the first changed file');
  await page.keyboard.press(PREV);
  await expect(page.locator('.tab.active')).toContainText('retry.test.ts');
  // The rename's diff names both sides; the added file's left side is empty.
  await row(page, 'backoff.ts').click();
  await expect(page.locator('.tab.active')).toContainText('backoff.ts → backoff.ts (main ↔ working tree)');
  await expect(page.locator('.monaco-diff-editor .editor.original .monaco-editor').first()).toHaveAttribute('data-uri', /\/old\/backoff\.ts\?/);
  await row(page, 'jitter.ts').click();
  await expect(page.locator('.monaco-diff-editor .editor.original .monaco-editor').first()).toHaveAttribute('data-uri', /^sidestory-empty:/);

  await row(page, 'retry.ts').hover();
  await row(page, 'retry.ts').locator('.actions a[aria-label="Open File"]').click();
  await expect(page.locator('.tab.active')).toHaveText(/^retry\.ts/);
  await expect(page.locator('.monaco-diff-editor:visible')).toHaveCount(0);
});

test('Open All Changes opens one multi-diff editor', async ({ page }) => {
  await command(page, 'Sidestory: Open All Changes');
  await expect(page.locator('.tab.active')).toHaveText(/Changes vs main \(5 files\)/);
  await expect(page.locator('.multiDiffEditor, .monaco-multi-diff-editor').first()).toBeVisible();
});

test('uncommitted edits and untracked files show up without Refresh; Committed Only leaves them out; a commit updates the view', async ({ page }) => {
  inContainer(`cd ${REPO} && printf 'new\\nfile\\n' > notes.txt && printf '# Fixture\\n\\nEdited.\\n' > README.md`);
  await expect(row(page, 'notes.txt')).toBeVisible({ timeout: 20_000 });
  await expect(row(page, 'notes.txt').locator('.label-description')).toHaveText('+2 · untracked');
  await expect(row(page, 'README.md').locator('.label-description')).toHaveText('+2');
  await command(page, 'Sidestory: Committed Changes Only');
  await expect(row(page, 'notes.txt')).toBeHidden();
  await expect(row(page, 'README.md')).toBeHidden();
  await expect.poll(() => description(page)).toMatch(/ · 3 commits$/);
  // The right side is now HEAD's blob, read-only.
  await row(page, 'retry.ts').click();
  await expect(page.locator('.tab.active')).toContainText('retry.ts (main ↔ HEAD)');
  await expect(page.locator('.monaco-diff-editor .editor.modified .monaco-editor').first()).toHaveAttribute('data-uri', /^sidestory-git:/);
  gitIn('commit -qam "Edit the readme"');
  await expect(row(page, 'README.md')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => description(page)).toMatch(/ · 4 commits$/);
  await command(page, 'Sidestory: Include Uncommitted Changes');
  await expect(row(page, 'notes.txt')).toBeVisible();
});

test('the base picker: a commit on the branch narrows the diff; an unknown base says so', async ({ page }) => {
  const first = inContainer(`cd ${REPO} && git rev-list --reverse main..feature | head -1`).trim();
  await viewAction(page, 'Change Base', changes(page));
  await page.locator('.quick-input-list .monaco-list-row', { hasText: 'Commit…' }).click();
  await expect(page.locator('.quick-input-widget')).toContainText('Compare with a commit');
  await page.keyboard.type(first.slice(0, 8));
  await page.keyboard.press('Enter');
  await expect.poll(() => description(page)).toContain(`@ ${first.slice(0, 7)} · 2 commits`);
  await expect(row(page, 'jitter.ts')).toBeHidden();
  await expect(row(page, 'sleep.ts')).toBeVisible();
  // Back to the default.
  await viewAction(page, 'Change Base', changes(page));
  await page.locator('.quick-input-list .monaco-list-row', { hasText: 'Merge-base with main' }).click();
  await expect(row(page, 'jitter.ts')).toBeVisible();
  // On main with nothing changed: the welcome says there is nothing to compare.
  gitIn('checkout -q main');
  await expect(changes(page)).toContainText("You're on the base branch", { timeout: 20_000 });
});

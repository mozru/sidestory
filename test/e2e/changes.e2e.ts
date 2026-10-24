// A sidestory that explains part of a branch (docs/CHANGES-PLAN.md §16.3, release 1b), with no Changes view of its
// own, on the git fixture's `--explained` copy: `.sidestory/retry-jitter/` (base main) explains retry.ts and
// jitter.ts by head-side steps, the deleted legacy/sleep.ts by a base-side step, marks backoff.ts's renamed lines
// trivial, and leaves test/retry.test.ts unexplained. Coverage shows as decorations on the files (Explorer, Source
// Control), the "This branch" group of Sidestories, Next Unexplained Change, steps opening the merge diff, This File.
import { expect, type FrameLocator, type Locator, type Page, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { command, inContainer } from './helpers.ts';

const REPO = '/home/workspace/chgx';
const SHOTS = process.env.CX_SHOTS;

const pane = (page: Page, name: string) => page.locator('.pane', { has: page.locator('.pane-header', { hasText: new RegExp(`^${name}`) }) }).first();
const sidestories = (page: Page) => pane(page, 'Sidestories');
const exact = (s: string) => new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
const row = (scope: Locator, label: string) => scope.locator('.monaco-list-row', { has: scope.page().locator('.label-name', { hasText: exact(label) }) }).first();
const desc = async (r: Locator) => (await r.locator('.label-description').first().textContent())?.trim();
const diff = (page: Page) => page.locator('.monaco-diff-editor:visible').first();
const activeTab = (page: Page, text: string) => expect(page.locator('.tab.active', { hasText: text })).toBeVisible();
/** Our whole-line decorations in an editor (the extension's decoration classes start with "ced-"). */
const decorated = (editor: Locator) => editor.locator('.view-overlays [class*="ced-"]').count();
/** A row's file decoration badges, as VS Code draws them (the label's ::after content). */
const badge = (r: Locator) => r.locator('.monaco-icon-label').first().evaluate((el) => getComputedStyle(el, '::after').content);

// On a failure, the server's recent logs (the Sidestory and Git output channels, the extension hosts) and the
// fixture's git state go with the test's results: CI's container is gone by the time anyone looks.
test.afterEach(async ({}, info) => {
  if (info.status === info.expectedStatus) return;
  try {
    const logs = inContainer(
      `cd ~/.openvscode-server/data/logs 2>/dev/null && for f in $(find . -type f -name '*.log' -mmin -3 | grep -Ei 'sidestory|git|exthost|remoteagent' | head -40); do echo "=== $f"; tail -c 30000 "$f"; done; echo "=== git"; cd ${REPO} && git status --short --branch && git log --oneline -3 --all; ls -la .git; echo "=== ps"; ps -eo pid,etimes,args | grep -E '[e]xtensionHost|[g]it ' | cut -c1-200`,
    );
    writeFileSync(info.outputPath('server-logs.txt'), logs);
  } catch (e) {
    writeFileSync(info.outputPath('server-logs.txt'), String(e));
  }
  await info.attach('server-logs', { path: info.outputPath('server-logs.txt'), contentType: 'text/plain' });
});

async function openRepo(page: Page, prepare = ''): Promise<void> {
  // Side-by-side diffs beside the panel (the README's tip), so the left side has an editor.
  const settings = { ...JSON.parse(inContainer('cat /home/workspace/.settings.json')), 'diffEditor.useInlineViewWhenSpaceIsLimited': false };
  inContainer(`rm -rf ${REPO} ~/.openvscode-server/data/User/workspaceStorage && cp -r /home/workspace/.chg-explained ${REPO} && echo '${JSON.stringify(settings)}' > ~/.openvscode-server/data/User/settings.json${prepare ? ` && cd ${REPO} && ${prepare}` : ''}`);
  await page.goto(`/?folder=${REPO}`);
  await page.locator('.monaco-workbench').waitFor({ timeout: 60_000 });
  const yes = page.getByRole('button', { name: 'Yes, I trust the authors' });
  await yes.waitFor({ timeout: 15_000 }).then(() => yes.click(), () => {});
  await expect(async () => {
    for (const tab of await page.locator('.tab').all()) {
      await tab.hover();
      await tab.locator('.codicon-close').click({ timeout: 2_000 }).catch(() => {});
    }
    await page.waitForTimeout(1_000);
    expect(await page.locator('.tab').count()).toBe(0);
  }).toPass({ timeout: 45_000 });
  if (await page.locator('.part.auxiliarybar').isVisible()) await command(page, 'View: Toggle Secondary Side Bar Visibility');
}

async function showSidestories(page: Page): Promise<void> {
  const icon = page.locator('.activitybar .action-item a[aria-label^="Sidestory"]').first();
  await expect(icon).toBeVisible({ timeout: 60_000 });
  if (!(await sidestories(page).isVisible())) await icon.click();
  await expect(row(sidestories(page), 'This branch')).toBeVisible({ timeout: 45_000 });
}

/** The panel of the sidestory opened last. */
async function panelFrame(page: Page): Promise<FrameLocator> {
  await expect(page.locator('iframe.webview.ready')).toHaveCount(1, { timeout: 30_000 });
  const panel = page.frameLocator('iframe.webview.ready').first().frameLocator('#active-frame');
  await expect(panel.locator('.cx-title')).toBeVisible({ timeout: 30_000 });
  return panel;
}
const activeStep = (panel: FrameLocator) => panel.locator('.cx-step.cx-active, .cx-step[aria-current="step"]').first();

test('coverage marks show on the files in the Explorer and Source Control', async ({ page }) => {
  // An uncommitted edit, so Source Control lists a file too.
  await openRepo(page, "echo '// more' >> test/retry.test.ts");
  await command(page, 'View: Show Explorer');
  const explorer = page.locator('.explorer-folders-view');
  for (const folder of ['src', 'retry', 'test']) {
    const r = row(explorer, folder);
    await expect(r).toBeVisible({ timeout: 30_000 });
    if ((await r.getAttribute('aria-expanded')) !== 'true') await r.click();
  }
  await expect.poll(() => badge(row(explorer, 'retry.ts')), { timeout: 45_000 }).toContain('✓');
  await expect.poll(() => badge(row(explorer, 'jitter.ts'))).toContain('✓');
  await expect.poll(() => badge(row(explorer, 'backoff.ts'))).toContain('–');
  await expect.poll(() => badge(row(explorer, 'retry.test.ts'))).toContain('○');
  // Folders don't inherit them.
  expect(await badge(row(explorer, 'test'))).not.toContain('○');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/1b-decorations-explorer.png` });

  await page.locator('.activitybar .action-item:has([aria-label*="Source Control"])').first().click();
  const scm = page.locator('.scm-view');
  await expect(row(scm, 'retry.test.ts')).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => badge(row(scm, 'retry.test.ts'))).toContain('○');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/1b-decorations-scm.png` });
});

test('"This branch" lists the sidestory with its coverage and the update prompt', async ({ page }) => {
  await openRepo(page);
  await showSidestories(page);
  const s = sidestories(page);
  const labels = await s.locator('.monaco-list-row .label-name').allTextContents();
  expect(labels.slice(0, 3)).toEqual(['This branch', 'Retry with jitter', 'Copy Prompt: Update the Sidestory for New Changes']);
  await expect.poll(() => desc(row(s, 'This branch'))).toMatch(/^feature vs main/);
  await expect.poll(() => desc(row(s, 'Retry with jitter'))).toBe('vs main · 3 explained · 2 trivial · 1 left');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/1b-this-branch.png` });
});

test('Next Unexplained Change opens the diff at the change', async ({ page }) => {
  await openRepo(page);
  await showSidestories(page);
  await command(page, 'Sidestory: Next Unexplained Change');
  await activeTab(page, 'retry.test.ts (main ↔ working tree)');
  await expect(page.locator('.part.statusbar')).toContainText('Ln 11');
  // Next Changed File goes on in path order from there.
  await command(page, 'Sidestory: Previous Changed File');
  await activeTab(page, '(main ↔ working tree)');
});

test.describe('side by side', () => {
  // Wide enough for side-by-side diffs beside the panel: the left side then has an editor (§7.5).
  test.use({ viewport: { width: 2400, height: 1000 } });

  test('steps open the merge diff: the right side highlighted, a base-side step the left; the left-side cursor moves the panel', async ({ page }) => {
    await openRepo(page);
    await showSidestories(page);
    await row(sidestories(page), 'Retry with jitter').click();
    const panel = await panelFrame(page);
    await expect(activeStep(panel)).toContainText('The retry loop');
    // Step 1's file changed: the merge diff.
    await activeTab(page, 'retry.ts (main ↔ working tree)');
    const right = diff(page).locator('.editor.modified .monaco-editor');
    await expect.poll(() => decorated(right)).toBeGreaterThan(0);

    // The base-side step: the deleted file's diff, highlighted on the left.
    await panel.locator('.cx-step', { hasText: 'No more sleep' }).first().click();
    await activeTab(page, 'sleep.ts (main ↔ working tree)');
    const left = diff(page).locator('.editor.original .monaco-editor');
    await expect(left).toHaveAttribute('data-uri', /^sidestory-git:.*\/legacy\/sleep\.ts\?/);
    await expect.poll(() => decorated(left)).toBeGreaterThan(0);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/1b-diff-step.png` });

    // Back on retry.ts's diff, a click on unchanged context on the left follows the step about the matching new lines.
    await panel.locator('.cx-step', { hasText: 'Jitter' }).first().click();
    await activeTab(page, 'jitter.ts');
    await expect(activeStep(panel)).toContainText('Jitter');
    // From jitter.ts, the next changed file in path order is retry.ts: its diff, without moving the panel.
    await command(page, 'Sidestory: Next Changed File');
    await activeTab(page, 'retry.ts (main ↔ working tree)');
    await diff(page).locator('.editor.original .view-line', { hasText: 'export const retry line 4;' }).first().click();
    await expect(activeStep(panel)).toContainText('The retry loop');
  });
});

test('This File lists the steps covering a diff side, marks the one at the cursor, and the changes not explained yet', async ({ page }) => {
  await openRepo(page);
  await showSidestories(page);
  const tf = pane(page, 'This File');
  const header = tf.locator('.pane-header');
  if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click();
  await row(sidestories(page), 'Retry with jitter').click();
  await panelFrame(page);
  await activeTab(page, 'retry.ts (main ↔ working tree)');
  // A diff side maps to its repository path: the same steps as the plain editor.
  await expect(row(tf, 'Retry with jitter')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => desc(row(tf, 'Retry with jitter'))).toBe('vs main');
  await diff(page).locator('.editor.modified .view-line', { hasText: 'export const jitter = 2;' }).first().click();
  await expect(tf.locator('.monaco-list-row .label-name', { hasText: /^● 1\s+The retry loop$/ })).toBeVisible({ timeout: 10_000 });
  // The unexplained file: its open change, with the prompt and Mark as Trivial on its menu.
  await command(page, 'Sidestory: Next Unexplained Change');
  await activeTab(page, 'retry.test.ts (main ↔ working tree)');
  await expect(row(tf, 'Not explained yet')).toBeVisible({ timeout: 20_000 });
  await expect(row(tf, 'L11–40')).toBeVisible();
  await expect.poll(() => desc(row(tf, 'L11–40'))).toBe('not explained');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/1b-this-file.png` });
});

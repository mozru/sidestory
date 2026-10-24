// The Changes view with a sidestory that explains part of the branch (docs/CHANGES-PLAN.md §16.3 changes and
// diff-steps, release 1b), on the git fixture's `--explained` copy: `.sidestory/retry-jitter/` (base main) explains
// retry.ts and jitter.ts by head-side steps, the deleted legacy/sleep.ts by a base-side step, marks backoff.ts's
// renamed lines trivial, and leaves test/retry.test.ts unexplained.
import { expect, type FrameLocator, type Locator, type Page, test } from '@playwright/test';
import { command, inContainer } from './helpers.ts';
import { openFile } from './nav-helpers.ts';

const REPO = '/home/workspace/chgx';
const SHOTS = process.env.CX_SHOTS;

const pane = (page: Page, name: string) => page.locator('.pane', { has: page.locator('.pane-header', { hasText: new RegExp(`^${name}`) }) }).first();
const changes = (page: Page) => pane(page, 'Changes');
const exact = (s: string) => new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
const row = (scope: Locator, label: string) => scope.locator('.monaco-list-row', { has: scope.page().locator('.label-name', { hasText: exact(label) }) }).first();
const desc = async (r: Locator) => (await r.locator('.label-description').textContent())?.trim();
const description = (page: Page) => changes(page).locator('.pane-header .description').textContent();
const diff = (page: Page) => page.locator('.monaco-diff-editor:visible').first();
const activeTab = (page: Page, text: string) => expect(page.locator('.tab.active', { hasText: text })).toBeVisible();
/** Our whole-line decorations in an editor (the extension's decoration classes start with "ced-"). */
const decorated = (editor: Locator) => editor.locator('.view-overlays [class*="ced-"]').count();

async function openRepo(page: Page): Promise<void> {
  // Side-by-side diffs beside the panel (the README's tip), so the left side has an editor.
  const settings = { ...JSON.parse(inContainer('cat /home/workspace/.settings.json')), 'diffEditor.useInlineViewWhenSpaceIsLimited': false };
  inContainer(`rm -rf ${REPO} ~/.openvscode-server/data/User/workspaceStorage && cp -r /home/workspace/.chg-explained ${REPO} && echo '${JSON.stringify(settings)}' > ~/.openvscode-server/data/User/settings.json`);
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
  const icon = page.locator('.activitybar .action-item a[aria-label^="Sidestory"]').first();
  await expect(icon).toBeVisible({ timeout: 60_000 });
  if (!(await changes(page).isVisible())) await icon.click();
  await expect(row(changes(page), 'Retry with jitter')).toBeVisible({ timeout: 45_000 });
}

/** The panel of the sidestory opened last. */
async function panelFrame(page: Page): Promise<FrameLocator> {
  await expect(page.locator('iframe.webview.ready')).toHaveCount(1, { timeout: 30_000 });
  const panel = page.frameLocator('iframe.webview.ready').first().frameLocator('#active-frame');
  await expect(panel.locator('.cx-title')).toBeVisible({ timeout: 30_000 });
  return panel;
}
const activeStep = (panel: FrameLocator) => panel.locator('.cx-step.cx-active, .cx-step[aria-current="step"]').first();

test.beforeEach(async ({ page }) => {
  await openRepo(page);
});

test('the sidestory row with its coverage, coverage marks on files, change items, the badge', async ({ page }) => {
  const c = changes(page);
  const labels = await c.locator('.monaco-list-row .label-name').allTextContents();
  expect(labels.slice(0, 2)).toEqual(['Retry with jitter', 'Copy Prompt: Update the Sidestory for New Changes']);
  await expect.poll(() => desc(row(c, 'Retry with jitter'))).toBe('3 explained · 1 trivial · 1 left · 3 steps');
  await expect.poll(() => description(page)).toMatch(/ · 4 commits · 3 explained · 1 trivial · 1 left$/);
  await expect.poll(() => desc(row(c, 'retry.ts'))).toBe('+4 −1 · ✓');
  await expect.poll(() => desc(row(c, 'jitter.ts'))).toBe('+19 · ✓');
  await expect.poll(() => desc(row(c, 'sleep.ts'))).toBe('−24 · ✓');
  await expect.poll(() => desc(row(c, 'backoff.ts'))).toBe('← old/backoff.ts · +2 −2 · – trivial');
  await expect.poll(() => desc(row(c, 'retry.test.ts'))).toBe('+30 · ○');
  await expect.poll(() => desc(row(c, 'test'))).toBe('1 file · +30 · 1 left');
  // The mark is text; screen readers hear it in words.
  await expect(row(c, 'retry.test.ts')).toHaveAttribute('aria-label', /0 of 1 change explained/);
  await expect(row(c, 'backoff.ts')).toHaveAttribute('aria-label', /0 of 1 change explained, 1 marked trivial/);
  // The container's badge: changes not done.
  await expect(page.locator('.activitybar .action-item:has(a[aria-label^="Sidestory"]) .badge-content')).toHaveText('1');
  // Change items: expand a file to see its changes and what explains them.
  await row(c, 'retry.ts').locator('.monaco-tl-twistie').click();
  await expect(row(c, 'L5–8')).toBeVisible();
  await expect.poll(() => desc(row(c, 'L5–8'))).toBe('+4 −1 · Retry with jitter › The retry loop');
  await row(c, 'retry.test.ts').locator('.monaco-tl-twistie').click();
  await expect(row(c, 'L11–40')).toHaveAttribute('aria-label', /not explained/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/changes-coverage.png` });
});

test('Next Unexplained Change opens the diff at the change; Show Only Unexplained narrows the tree', async ({ page }) => {
  await command(page, 'Sidestory: Next Unexplained Change');
  await activeTab(page, 'retry.test.ts (main ↔ working tree)');
  await expect(page.locator('.part.statusbar')).toContainText('Ln 11');
  await command(page, 'Sidestory: Show Only Unexplained Changes');
  await expect.poll(() => changes(page).locator('.monaco-list-row .label-name').allTextContents()).toContain('retry.test.ts');
  await expect(row(changes(page), 'retry.ts')).toBeHidden();
  await command(page, 'Sidestory: Show All Changes');
  await expect(row(changes(page), 'retry.ts')).toBeVisible();
});

test.describe('side by side', () => {
  // Wide enough for side-by-side diffs beside the panel: the left side then has an editor (§7.5).
  test.use({ viewport: { width: 2400, height: 1000 } });

  test('steps open the merge diff: the right side highlighted, a base-side step the left; the left-side cursor moves the panel', async ({ page }) => {
    await row(changes(page), 'Retry with jitter').click();
    const panel = await panelFrame(page);
    await expect(activeStep(panel)).toContainText('The retry loop');
    // Step 1's file changed: the merge diff, the same tab the Changes view opens.
    await activeTab(page, 'retry.ts (main ↔ working tree)');
    const right = diff(page).locator('.editor.modified .monaco-editor');
    await expect.poll(() => decorated(right)).toBeGreaterThan(0);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/diff-step-right.png` });

    // The base-side step: the deleted file's diff, highlighted on the left.
    await panel.locator('.cx-step', { hasText: 'No more sleep' }).first().click();
    await activeTab(page, 'sleep.ts (main ↔ working tree)');
    const left = diff(page).locator('.editor.original .monaco-editor');
    await expect(left).toHaveAttribute('data-uri', /^sidestory-git:.*\/legacy\/sleep\.ts\?/);
    await expect.poll(() => decorated(left)).toBeGreaterThan(0);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/diff-step-left.png` });

    // Back on retry.ts's diff, a click on unchanged context on the left follows the step about the matching new lines.
    await panel.locator('.cx-step', { hasText: 'Jitter' }).first().click();
    await activeTab(page, 'jitter.ts');
    await row(changes(page), 'retry.ts').click();
    await activeTab(page, 'retry.ts (main ↔ working tree)');
    await diff(page).locator('.editor.original .view-line', { hasText: 'export const retry line 4;' }).first().click();
    await expect(activeStep(panel)).toContainText('The retry loop');
  });
});

test('This File lists the steps covering the active file, marks the one at the cursor, and offers a prompt otherwise', async ({ page }) => {
  // Collapsed by default; expand it.
  const tf = pane(page, 'This File');
  const header = tf.locator('.pane-header');
  if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click();
  await row(changes(page), 'retry.ts').click();
  await activeTab(page, 'retry.ts (main ↔ working tree)');
  // A diff side maps to its repository path: the same steps as the plain editor.
  await expect(row(tf, 'Retry with jitter')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => desc(row(tf, 'Retry with jitter'))).toBe('vs main');
  await expect(tf.locator('.monaco-list-row .label-name', { hasText: 'The retry loop' })).toBeVisible();
  // The cursor in the step's lines marks it.
  await diff(page).locator('.editor.modified .view-line', { hasText: 'export const jitter = 2;' }).first().click();
  await expect(tf.locator('.monaco-list-row .label-name', { hasText: /^● 1\s+The retry loop$/ })).toBeVisible({ timeout: 10_000 });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/this-file.png` });
  // A file nothing covers: the welcome with the prompt.
  await openFile(page, 'README.md');
  await expect(tf).toContainText('No sidestory explains this file yet.', { timeout: 10_000 });
  await expect(tf.getByRole('button', { name: 'Copy Prompt: Explain This File' })).toBeVisible();
});

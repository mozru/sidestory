// A sidestory that explains part of a branch (docs/CHANGES-PLAN.md §16.3, release 1b), with no Changes view of its
// own, on the git fixture's `--explained` copy: `.sidestory/retry-jitter/` (base main) explains retry.ts and
// jitter.ts by head-side steps, the deleted legacy/sleep.ts by a base-side step, marks backoff.ts's renamed lines
// trivial, and leaves test/retry.test.ts unexplained. Coverage shows as decorations on the files (Explorer, Source
// Control), the "This branch" group of Sidestories, Next Unexplained Change, steps opening the merge diff, This File.
import { expect, type FrameLocator, type Locator, type Page, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { command, inContainer } from './helpers.ts';
import { openFile } from './nav-helpers.ts';

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
/** An action in an editor title bar, by its title (VS Code shows them for the focused editor). */
const titleAction = (page: Page, title: string) => page.locator(`.editor-group-container .editor-actions .action-label[aria-label^="${title}"]`);
/** The editor of a document whose URI ends with `suffix`. */
const codeEditor = (page: Page, suffix: string) => page.locator(`.editor-group-container .monaco-editor[data-uri$="${suffix}"]`).first();
/** Whether the step is drawn as the diff frame in an editor: one of our whole-line decorations has a 4px left bar. */
const framed = (editor: Locator) => editor.locator('.view-overlays [class*="ced-"]').evaluateAll((els) => els.some((el) => getComputedStyle(el).borderLeftWidth === '4px'));
/** The text decorations draw after lines in an editor (CSS `content`), joined: where the step's label shows. */
const labelOf = (editor: Locator) =>
  editor.locator('.view-lines span').evaluateAll((els) => els.map((el) => getComputedStyle(el, '::after').content).filter((c) => c && c !== 'none' && c !== 'normal').join(' '));
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

async function openRepo(page: Page, prepare = '', extra: Record<string, unknown> = {}): Promise<void> {
  // Side-by-side diffs beside the panel (the README's tip), so the left side has an editor.
  const settings = { ...JSON.parse(inContainer('cat /home/workspace/.settings.json')), 'diffEditor.useInlineViewWhenSpaceIsLimited': false, ...extra };
  inContainer(`rm -rf ${REPO} ~/.openvscode-server/data/User/workspaceStorage && cp -r /home/workspace/.chg-explained ${REPO} && echo '${JSON.stringify(settings)}' > ~/.openvscode-server/data/User/settings.json && echo '${JSON.stringify(settings)}' > ~/.openvscode-server/data/Machine/settings.json${prepare ? ` && cd ${REPO} && ${prepare}` : ''}`);
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

  test('steps open plain editors; Open Changes with Base (modified files only) switches to the diff at the same line, the panel follows there, Open File goes back', async ({ page }) => {
    await openRepo(page);
    await showSidestories(page);
    await row(sidestories(page), 'Retry with jitter').click();
    const panel = await panelFrame(page);
    await expect(activeStep(panel)).toContainText('The retry loop');
    // Step 1's file changed, but it opens as itself, highlighted.
    await activeTab(page, 'retry.ts');
    await expect(page.locator('.tab.active', { hasText: '↔' })).toHaveCount(0);
    const plain = codeEditor(page, '/src/retry/retry.ts');
    await expect.poll(() => decorated(plain)).toBeGreaterThan(0);
    // The title bar's actions follow the focused editor (as the git extension's Open Changes does): in the editor, the button.
    await plain.locator('.view-line', { hasText: 'export const retry line 20;' }).first().click();
    await expect(titleAction(page, 'Open Changes with Base')).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/plain-step.png` });

    // A file the branch added: plain, no button (its diff would be all green).
    await panel.locator('.cx-step', { hasText: 'Jitter' }).first().click();
    await activeTab(page, 'jitter.ts');
    await expect(page.locator('.tab.active', { hasText: '↔' })).toHaveCount(0);
    await codeEditor(page, '/src/retry/jitter.ts').locator('.view-line').first().click();
    await page.waitForTimeout(500); // the title bar updates with the focus
    await expect(titleAction(page, 'Open Changes with Base')).toHaveCount(0);
    // Removed code: the old file, read-only, no button either (the file is deleted).
    await panel.locator('.cx-step', { hasText: 'No more sleep' }).first().click();
    const old = page.locator('.editor-group-container .monaco-editor[data-uri^="sidestory-git:"][data-uri*="/legacy/sleep.ts"]').first();
    await expect(old).toBeVisible();
    await old.locator('.view-line').first().click();
    await page.waitForTimeout(500); // the title bar updates with the focus
    await expect(titleAction(page, 'Open Changes with Base')).toHaveCount(0);
    // An unchanged file: none.
    await openFile(page, 'README.md');
    await codeEditor(page, '/README.md').locator('.view-line').first().click();
    await page.waitForTimeout(500); // the title bar updates with the focus
    await expect(titleAction(page, 'Open Changes with Base')).toHaveCount(0);

    // Back on retry.ts, below the step: the panel stays on the removed-code step.
    await openFile(page, 'src/retry/retry.ts');
    await page.locator('.editor-group-container .monaco-editor[data-uri$="/src/retry/retry.ts"] .view-line', { hasText: 'export const retry line 12;' }).first().click();
    await expect(page.locator('.part.statusbar')).toContainText('Ln 15');
    await titleAction(page, 'Open Changes with Base').click();
    await activeTab(page, 'retry.ts (main ↔ working tree)');
    await expect(page.locator('.part.statusbar')).toContainText('Ln 15');
    await expect(activeStep(panel)).toContainText('No more sleep');
    // In the diff: no Open Changes with Base, but the git extension's Open File.
    await expect(titleAction(page, 'Open Changes with Base')).toHaveCount(0);
    // A click in the diff's unchanged context on the left follows the step about the matching new lines.
    await diff(page).locator('.editor.original .view-line', { hasText: 'export const retry line 4;' }).first().click();
    await expect(activeStep(panel)).toContainText('The retry loop');
    // The step is framed there (a 4px bar, not the plain editor's tint).
    const right = diff(page).locator('.editor.modified .monaco-editor');
    await expect.poll(() => framed(right)).toBe(true);
    // Back to the file (the title bar has the git extension's Open File for a working tree file; the palette has
    // Sidestory's for any diff): from the left side, at the matching new line.
    await command(page, 'Sidestory: Open File', true);
    await activeTab(page, 'retry.ts');
    await expect(page.locator('.tab.active', { hasText: '↔' })).toHaveCount(0);
    await expect(page.locator('.part.statusbar')).toContainText('Ln 4,');
  });

  test('with openStepsIn "diff", steps open the merge diff: the right side highlighted, a base-side step the left; the left-side cursor moves the panel', async ({ page }) => {
    await openRepo(page, '', { 'sidestory.changes.openStepsIn': 'diff' });
    await showSidestories(page);
    await row(sidestories(page), 'Retry with jitter').click();
    const panel = await panelFrame(page);
    await expect(activeStep(panel)).toContainText('The retry loop');
    // Step 1's file changed: the merge diff.
    await activeTab(page, 'retry.ts (main ↔ working tree)');
    const right = diff(page).locator('.editor.modified .monaco-editor');
    await expect.poll(() => decorated(right)).toBeGreaterThan(0);
    await expect.poll(() => framed(right)).toBe(true);
    // The focus is in the panel: the diff's title bar still offers no Open Changes with Base (it is the diff).
    await expect(titleAction(page, 'Open Changes with Base')).toHaveCount(0);

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

  // A diff full of red and green around the step (lines changed right above and below it, more added after): the
  // step's frame and label must still stand out, in dark, light and high contrast themes.
  const HEAVY = "sed -i -e '1,3s/retry line/retry LINE (edited)/' -e '10,23s/;$/ + 1;/' -e '12d;16d' src/retry/retry.ts && for i in $(seq 1 25); do echo \"export const more$i = $i;\" >> src/retry/retry.ts; done";
  for (const [theme, shot] of [['Default Dark Modern', 'dark'], ['Default Light Modern', 'light'], ['Default High Contrast', 'hc']] as const) {
    test(`a step stands out in a heavily changed diff (${theme})`, async ({ page }) => {
      await openRepo(page, HEAVY);
      await command(page, 'Preferences: Color Theme');
      await page.keyboard.type(theme);
      await page.locator('.quick-input-list .monaco-list-row', { hasText: theme }).first().click();
      await showSidestories(page);
      await row(sidestories(page), 'Retry with jitter').click();
      const panel = await panelFrame(page);
      await expect(activeStep(panel)).toContainText('The retry loop');
      await activeTab(page, 'retry.ts');
      await codeEditor(page, '/src/retry/retry.ts').locator('.view-line', { hasText: 'export const retry line 6;' }).first().click();
      await expect(titleAction(page, 'Open Changes with Base')).toBeVisible();
      if (shot === 'dark' && SHOTS) {
        // The title bar around the button, with its tooltip.
        const button = titleAction(page, 'Open Changes with Base');
        await button.hover();
        await page.waitForTimeout(1200);
        const box = (await button.boundingBox())!;
        await page.screenshot({ path: `${SHOTS}/open-changes-button.png`, clip: { x: Math.max(0, box.x - 700), y: Math.max(0, box.y - 12), width: 900, height: 110 } });
      }
      await titleAction(page, 'Open Changes with Base').click();
      await activeTab(page, 'retry.ts (main ↔ working tree)');
      const right = diff(page).locator('.editor.modified .monaco-editor');
      await expect.poll(() => framed(right)).toBe(true);
      await expect.poll(() => labelOf(right)).toMatch(/◀\s*Step\s*1\s*·\s*The\s*retry\s*loop/);
      // Lots of diff around it.
      expect(await diff(page).locator('.line-insert, .line-delete').count()).toBeGreaterThan(10);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/diff-step-${shot}.png` });
    });
  }
});

test('This File lists the steps covering a diff side, marks the one at the cursor, and the changes not explained yet', async ({ page }) => {
  await openRepo(page, '', { 'sidestory.changes.openStepsIn': 'diff' });
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

test('trust granted after the window opened: "This branch" still comes, once the git extension starts', async ({ page }) => {
  // A folder never trusted before. In Restricted Mode the git extension doesn't run; trusting the folder starts it a
  // moment after the trust event, which the comparison and the probe must wait for (CI saw this order at random).
  const repo = `/home/workspace/chg-late-${Date.now()}`;
  inContainer(`rm -rf /home/workspace/chg-late-* && cp -r /home/workspace/.chg-explained ${repo}`);
  await page.goto(`/?folder=${repo}`);
  await page.locator('.monaco-workbench').waitFor({ timeout: 60_000 });
  const no = page.getByRole('button', { name: "No, I don't trust the authors" });
  await no.waitFor({ timeout: 15_000 }).then(() => no.click(), () => {});
  const icon = page.locator('.activitybar .action-item a[aria-label^="Sidestory"]').first();
  await expect(icon).toBeVisible({ timeout: 60_000 });
  if (!(await sidestories(page).isVisible())) await icon.click();
  await expect(row(sidestories(page), 'Retry with jitter')).toBeVisible({ timeout: 30_000 });
  await expect(row(sidestories(page), 'This branch')).toBeHidden();
  await command(page, 'Workspaces: Manage Workspace Trust');
  await page.getByRole('button', { name: /^Trust$/ }).first().click();
  await expect(row(sidestories(page), 'This branch')).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => desc(row(sidestories(page), 'Retry with jitter')), { timeout: 30_000 }).toBe('vs main · 3 explained · 2 trivial · 1 left');
});

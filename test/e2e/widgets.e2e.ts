// Widgets end to end (docs/WIDGETS-PLAN.md §11 "End to end"): the extension in the container, VS Code and
// the panel in the browser. The sample workspace's retry-backoff explainer has one widget
// (.explain/retry-backoff/widgets/backoff.tsx). The workspace is copied without .git, so consent is per workspace,
// and opens in Restricted Mode (helpers.ts declines trust): each test grants trust from the panel's bar.
import { expect, type FrameLocator, type Page, test } from '@playwright/test';
import { activeTab, chooseStep, codeEditor, command, inContainer, openExplainer, openWorkbench, resetWorkbench } from './helpers.ts';
import { WORKSPACE } from './setup.ts';

const widget = (panel: FrameLocator) => panel.frameLocator('iframe.cx-widget-frame').first();

/** The bar offers VS Code's own trust flow in Restricted Mode; widgets wait for it without reopening the panel. */
async function trust(page: Page, panel: FrameLocator): Promise<void> {
  await panel.locator('.cx-consent').getByRole('button', { name: 'Trust workspace…' }).click();
  await page.locator('.workspace-trust-buttons a.monaco-button', { hasText: /^Trust$/ }).click();
  await expect(page.locator('.workspace-trust-header.workspace-trust-trusted')).toBeVisible();
  await page.locator('.tab', { hasText: 'Explainer: Retry' }).first().click();
}

/** Trust, then the consent bar's button, then the native modal's. */
async function runWidgets(page: Page, panel: FrameLocator): Promise<void> {
  await expect(panel.locator('.cx-consent')).toContainText('This explainer has 1 interactive widget');
  if (await panel.locator('.cx-consent').getByRole('button', { name: 'Trust workspace…' }).isVisible()) await trust(page, panel);
  await panel.locator('.cx-consent').getByRole('button', { name: 'Run widgets…' }).click();
  const dialog = page.locator('.monaco-dialog-box');
  await expect(dialog).toContainText('Widgets are code from this repository');
  await expect(dialog).toContainText('may be able to reach the network');
  await dialog.getByRole('button', { name: 'Run Widgets', exact: true }).click();
  await expect(panel.locator('.cx-consent')).not.toContainText('Run widgets…');
  await expect(widget(panel).getByTestId('backoff')).toBeVisible({ timeout: 20_000 });
}

test.describe('widgets', () => {
  test.beforeEach(async ({ page }) => resetWorkbench(page));

  test('the consent modal runs the sample widget; steps drive it, a click reveals code, highlight decorates', async ({ page }) => {
    const panel = await openExplainer(page, 'retry-backoff');
    // Before consent: the fallback, and no widget frame.
    await expect(panel.frameLocator('iframe.cx-content-frame').locator('explain-widget')).toContainText('Each attempt waits a random time');
    await expect(panel.locator('iframe.cx-widget-frame')).toHaveCount(0);
    await runWidgets(page, panel);
    // It names an anchor whose quote nobody confirmed (no git here, so not "committed at HEAD"): until the reader
    // confirms in a native modal, it gets nothing and shows its own placeholder text.
    await expect(widget(panel).getByTestId('formula')).toHaveText('ceiling = min(maxMs, baseMs × 2^attempt)');
    await panel.locator('.cx-consent').getByRole('button', { name: /Let widgets read 1 anchor \(src\/retry\.ts, 5 lines\)/ }).click();
    const dialog = page.locator('.monaco-dialog-box');
    await expect(dialog).toContainText('src/retry.ts: lines 14–18 (delay)');
    await dialog.getByRole('button', { name: 'Let Widgets Read' }).click();
    await expect(widget(panel).getByTestId('formula')).toHaveText('const ceiling = Math.min(opts.maxMs, opts.baseMs * 2 ** attempt);');
    await expect(panel.locator('.cx-consent')).toBeHidden();
    // Steps drive it.
    await chooseStep(panel, 'delay');
    await expect(widget(panel).getByTestId('total')).toContainText('6 attempts');
    await chooseStep(panel, 'loop');
    await expect(widget(panel).getByTestId('total')).toContainText('3 attempts');
    await chooseStep(panel, 'delay');
    await expect(activeTab(page, 'retry.ts')).toBeVisible();
    // A click in the widget reveals code.
    await page.locator('.part.sidebar .composite.title').click(); // focus elsewhere first
    await widget(panel).getByTestId('show-code').click();
    await expect(codeEditor(page, 'retry.ts').locator('.view-lines')).toContainText('const ceiling');
    // highlight() decorates lines of the step's anchor, without a click on anything but the chart.
    const decorated = () => codeEditor(page, 'retry.ts').locator('.view-overlays [class*="ced-"]').count();
    const before = await decorated();
    const bar = widget(panel).locator('.recharts-bar-rectangle path').first();
    await bar.click();
    await expect.poll(decorated).toBeGreaterThan(before);
  });

  test('editing the widget file updates it live, keeping what the reader set', async ({ page }) => {
    const panel = await openExplainer(page, 'retry-backoff');
    await runWidgets(page, panel);
    await widget(panel).getByTestId('roll').click();
    const total = await widget(panel).getByTestId('total').textContent();
    inContainer(`sed -i 's/>Roll again</>Roll once more</' ${WORKSPACE}/.explain/retry-backoff/widgets/backoff.tsx`);
    await expect(widget(panel).getByTestId('roll')).toHaveText('Roll once more', { timeout: 20_000 });
    // The roll (useWidgetState) survived the reload.
    await expect(widget(panel).getByTestId('total')).toHaveText(total!);
  });

  test('compile errors in widget files reach the Problems panel', async ({ page }) => {
    const panel = await openExplainer(page, 'retry-backoff');
    await runWidgets(page, panel);
    inContainer(`sed -i "s|^import { useMemo } from 'react';|import { useMemo } from 'react';\\nimport * as THREE from 'three';\\nvoid THREE;|" ${WORKSPACE}/.explain/retry-backoff/widgets/backoff.tsx`);
    await expect(page.locator('#status\\.problems')).toContainText('1', { timeout: 20_000 });
    await command(page, 'View: Toggle Problems');
    await expect(page.locator('.markers-panel')).toContainText('Three.js is not available');
    // The last good version keeps running, with a badge.
    await expect(panel.frameLocator('iframe.cx-content-frame').locator('explain-widget .cx-widget-note')).toContainText('compile error');
    await expect(widget(panel).getByTestId('backoff')).toBeVisible();
  });

  test('consent is remembered in the workspace, and revoking it asks again', async ({ page }) => {
    const panel = await openExplainer(page, 'retry-backoff');
    await runWidgets(page, panel);
    await command(page, 'View: Close All Editors');
    const again = await openExplainer(page, 'retry-backoff');
    await expect(widget(again).getByTestId('backoff')).toBeVisible({ timeout: 20_000 });
    await command(page, 'Sidestory: Revoke Widget Consent');
    await expect(again.locator('.cx-consent')).toContainText('Run widgets…');
    await expect(again.locator('iframe.cx-widget-frame')).toHaveCount(0);
  });
});

test.describe('widgets in Restricted Mode', () => {
  test.afterEach(() => {
    inContainer('cp /home/workspace/.settings.json ~/.openvscode-server/data/User/settings.json');
  });

  test('show the fallback and the trust bar, never a frame', async ({ page }) => {
    inContainer(
      `rm -rf ${WORKSPACE} ~/.openvscode-server/data/User/workspaceStorage && cp -r /home/workspace/.fixture ${WORKSPACE} && ` +
        `sed 's/"security.workspace.trust.enabled": false/"security.workspace.trust.enabled": true/' /home/workspace/.settings.json > ~/.openvscode-server/data/User/settings.json`,
    );
    await openWorkbench(page);
    const panel = await openExplainer(page, 'retry-backoff');
    await expect(panel.locator('.cx-consent')).toContainText("Widgets don't run in Restricted Mode");
    await expect(panel.locator('.cx-consent').getByRole('button', { name: 'Trust workspace…' })).toBeVisible();
    await expect(panel.frameLocator('iframe.cx-content-frame').locator('explain-widget')).toContainText('Each attempt waits a random time');
    await page.waitForTimeout(1000);
    await expect(panel.locator('iframe.cx-widget-frame')).toHaveCount(0);
  });
});

test.describe('two panels (process model)', () => {
  test.skip(!process.env.CX_SITE_ISOLATION, 'set CX_SITE_ISOLATION=1 to model desktop process isolation');

  test('widgets in two panels: both run; whether they share a widget process is recorded', async ({ page, browser }, info) => {
    inContainer(`rm -rf ${WORKSPACE} ~/.openvscode-server/data/User/workspaceStorage && cp -r /home/workspace/.fixture ${WORKSPACE} && cp -r ${WORKSPACE}/.explain/retry-backoff ${WORKSPACE}/.explain/retry-copy && cp /home/workspace/.settings.json ~/.openvscode-server/data/User/settings.json`);
    await openWorkbench(page);
    const cdp = await browser.newBrowserCDPSession();
    const renderers = async () => (await cdp.send('SystemInfo.getProcessInfo')).processInfo.filter((p) => p.type === 'renderer').length;
    const first = await openExplainer(page, 'retry-backoff');
    await runWidgets(page, first);
    const one = await renderers();
    const second = await openExplainer(page, 'retry-copy');
    // A copied-in explainer asks the first time, like any explainer whose widgets never ran here.
    await runWidgets(page, second);
    const two = await renderers();
    const targets = (await cdp.send('Target.getTargets')).targetInfos.filter((t) => t.type === 'iframe').length;
    const record = { renderersWithOnePanel: one, renderersWithTwoPanels: two, iframeTargets: targets };
    console.log(`[widgets] two panels: ${JSON.stringify(record)}`);
    await info.attach('process-model.json', { body: JSON.stringify(record, null, 2), contentType: 'application/json' });
    // Both panels' widgets work, and the first panel is unaffected by the second.
    await widget(first).getByTestId('roll').click();
    await expect(widget(first).getByTestId('backoff')).toBeVisible();
    expect(two).toBeGreaterThanOrEqual(one);
  });

  test('a hung widget is turned off by the watchdog and the panel recovers', async ({ page }) => {
    test.setTimeout(150_000);
    inContainer(`rm -rf ${WORKSPACE} ~/.openvscode-server/data/User/workspaceStorage && cp -r /home/workspace/.fixture ${WORKSPACE} && cp /home/workspace/.settings.json ~/.openvscode-server/data/User/settings.json`);
    // A catastrophic regular expression: not a loop, so the loop guards can't stop it.
    inContainer(`sed -i 's|onClick={() => setSeed(seed + 1)}|onClick={() => { /^(a+)+$/.test("a".repeat(40) + "b"); setSeed(seed + 1); }}|' ${WORKSPACE}/.explain/retry-backoff/widgets/backoff.tsx`);
    await openWorkbench(page);
    const panel = await openExplainer(page, 'retry-backoff');
    await runWidgets(page, panel);
    await widget(panel).getByTestId('roll').click({ noWaitAfter: true, timeout: 5000 }).catch(() => {});
    const box = panel.frameLocator('iframe.cx-content-frame').locator('explain-widget .cx-widget-error');
    await expect(box).toContainText('stopped responding', { timeout: 60_000 });
    await expect(page.locator('.notifications-toasts')).toContainText('stopped responding');
    // The panel answers: stepping still works.
    await chooseStep(panel, 'loop');
    await expect(panel.locator('.cx-position')).toHaveText('Step 3 of 3');
  });
});

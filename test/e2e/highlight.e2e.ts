// End to end: code blocks colored by the extension host in the real VS Code theme (docs/HIGHLIGHT-PLAN.md).
import { expect, test } from '@playwright/test';
import { WORKSPACE } from './setup.ts';
import { command, content, inContainer, openExplainer, resetWorkbench } from './helpers.ts';

test.beforeEach(async ({ page }) => resetWorkbench(page));

const FILE = `${WORKSPACE}/.sidestory/retry-backoff/sidestory.html`;
const BLOCK = '<pre><code class="language-ts">const answer: number = 42; // the answer\nexport function ask() { return "why"; }</code></pre>';

test('code blocks get the editor theme’s token colors, and follow a theme change', async ({ page }) => {
  inContainer(`cp ${FILE} /tmp/sidestory.html.bak && printf '%s\\n' '${BLOCK}' >> ${FILE}`);
  try {
    const panel = await openExplainer(page, 'retry-backoff');
    const code = content(panel).locator('pre code.language-ts');
    const keyword = code.locator('span', { hasText: /^const/ });
    // settings.json sets "Default Dark Modern" (an old name VS Code migrates to Dark Modern): storage keywords are #569CD6.
    await expect(keyword).toHaveCSS('color', 'rgb(86, 156, 214)');
    await expect(code.locator('span', { hasText: '"why"' })).toHaveCSS('color', 'rgb(206, 145, 120)');
    expect(await code.textContent()).toBe('const answer: number = 42; // the answer\nexport function ask() { return "why"; }');
    // With the server's own grammar (vscode.typescript) and its own onig.wasm (docs/HIGHLIGHT-PLAN.md §10).
    const engineLog = () => inContainer(`find ~/.openvscode-server/data/logs -name '*Sidestory*.log' -exec grep -h 'regex engine' {} + 2>/dev/null | tail -1 || true`);
    await expect.poll(engineLog, { timeout: 10_000 }).toMatch(/using VS Code's Oniguruma regex engine/);
    if (process.env.CX_HL_SHOTS) await content(panel).locator('pre').last().screenshot({ path: `${process.env.CX_HL_SHOTS}/e2e-dark-modern.png` });
    // VS Code's own light/dark toggle, to its light theme: Light Modern colors storage keywords #0000FF, Light 2026
    // (the default in newer VS Code versions) #CF222E, and Light High Contrast (when an earlier test left the
    // workbench in high contrast) #0F4A85.
    await command(page, 'Preferences: Toggle between Light/Dark Themes');
    await expect.poll(() => keyword.evaluate((el) => getComputedStyle(el).color), { timeout: 20_000 }).toMatch(/^rgb\((0, 0, 255|207, 34, 46|15, 74, 133)\)$/);
    if (process.env.CX_HL_SHOTS) await content(panel).locator('pre').last().screenshot({ path: `${process.env.CX_HL_SHOTS}/e2e-light.png` });
    await command(page, 'Preferences: Toggle between Light/Dark Themes');
  } finally {
    inContainer(`cp /tmp/sidestory.html.bak ${FILE}`);
  }
});

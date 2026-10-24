// End to end: diagrams as a live code map (docs/AUTHORING-PLAN.md §8.1, §8.2, §0). Boxes with data-explain-code open
// SystemVerilog symbols; the editor cursor rings the box whose code it's in without changing the step; a ref-only
// anchor never holds the step against the section that covers the same code.
import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { CONTAINER, WORKSPACE } from './setup.ts';
import { activeTab, command, content, openExplainer, resetWorkbench } from './helpers.ts';

test.beforeEach(async ({ page }) => resetWorkbench(page));

const MANIFEST = JSON.stringify({
  version: 1,
  title: 'Code map',
  anchors: {
    overview: { file: 'rtl/dma_top.sv', range: [1, 8] },
    fifo: { file: 'rtl/dma_fifo.sv', range: [1, 66] },
    'fifo-ctrl': { file: 'rtl/dma_fifo.sv', range: [40, 59] },
  },
});
const box = (id: string, link: string, x: number, y: number) =>
  `<g data-box="${id}" ${link}><title>${id}</title><rect x="${x}" y="${y}" width="150" height="40" rx="4" fill="var(--cx-box-fill)" stroke="var(--cx-box-stroke)"/><text x="${x + 10}" y="${y + 25}" fill="var(--cx-box-text)">${id}</text></g>`;
const HTML = `<!doctype html>
<section data-explain-anchor="overview" data-explain-title="Overview">
<h2>The control FSM and the FIFO</h2>
<figure data-explain-diagram data-explain-code-file="rtl/dma_ctrl.sv">
<svg viewBox="0 0 680 120" width="680" height="120" role="group" aria-label="FSM states and the FIFO">
${box('IDLE', 'data-explain-code="#driver(state_d).case(IDLE)"', 10, 10)}
${box('WAIT_DATA', 'data-explain-code="#driver(state_d).case(WAIT_DATA)"', 180, 10)}
${box('fsm', 'data-explain-code="#driver(state_d)"', 350, 10)}
${box('fifo-ctrl', 'data-explain-ref="fifo-ctrl"', 10, 70)}
${box('full', 'data-explain-code="rtl/dma_fifo.sv#driver(full)"', 180, 70)}
${box('u_fifo', 'data-explain-code="rtl/dma_top.sv#u_fifo"', 350, 70)}
</svg>
</figure>
</section>
<section data-explain-anchor="fifo" data-explain-title="FIFO"><h2>The FIFO</h2><p>Pointers and occupancy.</p></section>
`;

async function goToLine(page: Page, line: number): Promise<void> {
  await command(page, 'Go to Line/Column');
  await page.keyboard.type(String(line));
  await page.keyboard.press('Enter');
  await expect(page.locator('.statusbar-item', { hasText: new RegExp(`^Ln ${line}, Col`) })).toBeVisible();
}

test('a box opens its symbol; the cursor rings the tightest box and leaves the step; a ref-only anchor never takes the step', async ({ page }) => {
  const tar = execFileSync('tar', ['--no-xattrs', '-C', 'examples/stream-dma', '-cf', '-', 'rtl'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  execFileSync('docker', ['exec', '-i', CONTAINER, 'tar', '-C', WORKSPACE, '-xf', '-'], { input: tar });
  execFileSync('docker', ['exec', '-i', CONTAINER, 'sh', '-c', `mkdir -p ${WORKSPACE}/.sidestory/codemap && cat > ${WORKSPACE}/.sidestory/codemap/manifest.json`], { input: MANIFEST });
  execFileSync('docker', ['exec', '-i', CONTAINER, 'sh', '-c', `cat > ${WORKSPACE}/.sidestory/codemap/sidestory.html`], { input: HTML });

  const panel = await openExplainer(page, 'codemap');
  const dia = content(panel).locator('figure[data-explain-diagram]');
  const b = (id: string) => dia.locator(`[data-box="${id}"]`);
  await expect(panel.locator('.cx-position')).toHaveText('Step 1 of 2');
  // No editor was open: the first step's code shows at once (not only after the first step change).
  await expect(activeTab(page, 'dma_top.sv')).toBeVisible();

  // A click opens the case arm at its first line, and rings the box it came from; the step stays.
  await b('WAIT_DATA').click();
  await expect(activeTab(page, 'dma_ctrl.sv')).toBeVisible();
  await expect(page.locator('.statusbar-item', { hasText: /^Ln 89, Col 1/ })).toBeVisible();
  await expect(b('WAIT_DATA')).toHaveClass(/cx-here/);
  await expect(panel.locator('.cx-position')).toHaveText('Step 1 of 2');

  // The cursor in another arm rings that bubble only; between the arms, the whole block's box.
  await goToLine(page, 71);
  await expect(b('IDLE')).toHaveClass(/cx-here/);
  await expect(b('WAIT_DATA')).not.toHaveClass(/cx-here/);
  await goToLine(page, 62);
  await expect(b('fsm')).toHaveClass(/cx-here/);
  await expect(b('IDLE')).not.toHaveClass(/cx-here/);
  await expect(panel.locator('.cx-position')).toHaveText('Step 1 of 2');
  await page.screenshot({ path: 'test-results/e2e/codemap-lit-from-cursor.png' });
  await dia.screenshot({ path: 'test-results/e2e/codemap-box-lit.png' });

  // Into the FIFO: the section that covers the line takes the step, not the tighter ref-only anchor, whose box rings.
  await b('full').click();
  await expect(activeTab(page, 'dma_fifo.sv')).toBeVisible();
  await expect(b('full')).toHaveClass(/cx-here/);
  await goToLine(page, 45);
  await expect(panel.locator('.cx-position')).toHaveText('Step 2 of 2');
  await expect(b('fifo-ctrl')).toHaveClass(/cx-here/);
  await expect(b('full')).not.toHaveClass(/cx-here/);
  await expect(dia.locator('.cx-here')).toHaveCount(1);

  // Code nothing links to: nothing lit.
  await goToLine(page, 2);
  await expect(dia.locator('.cx-here')).toHaveCount(0);
});

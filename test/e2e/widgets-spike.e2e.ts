// Phase 1 of docs/WIDGETS-PLAN.md: go/no-go measurements of a widget frame inside the real VS Code webview.
// Exploratory: it records what happens (test-results/widgets-spike.json) rather than asserting the design.
// Run with: CX_SPIKE=1 npm run test:e2e -- -g spike
import { expect, type Frame, type Page, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { WIDGET_BOOTSTRAP } from '../../src/shared/widget-bootstrap.ts';
import { chooseStep, command, openExplainer, resetWorkbench } from './helpers.ts';

test.skip(!process.env.CX_SPIKE, 'set CX_SPIKE=1 to run the widgets spike');
test.setTimeout(240_000);

const WIDGET_CSP = `default-src 'none'; script-src 'strict-dynamic' 'sha256-HASH'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; require-trusted-types-for 'script'; trusted-types default`;

// The widget's own code, delivered by the bootstrap's `load` message.
const PROBE = `
(() => {
  const post = (k, v) => parent.postMessage({ type: 'probe', k, v }, '*');
  post('origin', self.origin);
  post('parentDoc', (() => { try { return String(!!parent.document); } catch (e) { return 'blocked'; } })());
  post('rtc', typeof RTCPeerConnection + '/' + typeof webkitRTCPeerConnection);
  fetch('https://example.com/x').then(() => post('fetch', 'ok'), () => post('fetch', 'blocked'));
  const l = document.createElement('link'); l.rel = 'prefetch'; l.href = 'https://example.com/p'; document.head.append(l);
  post('prefetchRel', JSON.stringify(l.rel));
  const div = document.createElement('div'); div.innerHTML = '<b id="tt">trusted types default ok</b>'; document.body.append(div);
  post('ttDefault', String(!!document.getElementById('tt')));
  self.addEventListener('message', (e) => {
    if (e.source !== parent) return;
    const m = e.data;
    if (m.type === 'resource') { const img = new Image(); img.onload = () => post('resource', 'loaded'); img.onerror = () => post('resource', 'blocked'); img.src = m.url; }
    if (m.type === 'busy') { const end = Date.now() + m.ms; while (Date.now() < end) {} post('busyDone', m.ms); }
    if (m.type === 'steal') setTimeout(() => { document.getElementById('i').focus(); post('stole', document.activeElement && document.activeElement.id); }, m.after);
    if (m.type === 'hang') { post('hanging', 1); while (true) {} }
  });
  document.getElementById('i').addEventListener('keydown', (e) => post('key', (e.metaKey ? 'Meta+' : '') + (e.ctrlKey ? 'Ctrl+' : '') + e.key));
  post('ready', 1);
})();`;

async function panelFrame(page: Page): Promise<Frame> {
  for (let i = 0; i < 40; i++) {
    for (const f of page.frames()) {
      const ok = await f.evaluate(() => !!document.getElementById('app') && !!document.querySelector('.cx-title')).catch(() => false);
      if (ok) return f;
    }
    await page.waitForTimeout(250);
  }
  throw new Error('panel frame not found');
}

test('widgets spike: a sandboxed widget frame in the real webview', async ({ page }) => {
  await resetWorkbench(page);
  const results: Record<string, unknown> = {};
  const note = (k: string, v: unknown) => {
    results[k] = v;
    console.log(`SPIKE ${k}: ${JSON.stringify(v)}`);
  };
  const ui = await openExplainer(page, 'bit-reader');
  // Code beside the panel (as stepping does), so focusing it later doesn't hide the panel.
  await chooseStep(ui, 'refill');
  await page.locator('.monaco-editor[data-uri$="bit_reader.sv"]').first().waitFor();
  await chooseStep(ui, 'interface');
  const panel = await panelFrame(page);
  const hash = (await import('node:crypto')).createHash('sha256').update(WIDGET_BOOTSTRAP, 'utf8').digest('base64');

  // 1. Create the widget frame the way the panel will: srcdoc via a Trusted Types policy, bootstrap only.
  await panel.evaluate(
    ({ boot, csp, probe }) => {
      const w: { msgs: unknown[]; over: number; out: number; f?: HTMLIFrameElement } = { msgs: [], over: 0, out: 0 };
      (window as unknown as { __w: typeof w }).__w = w;
      const tt = (window as unknown as { trustedTypes: { createPolicy(n: string, r: object): { createHTML(s: string): string } } }).trustedTypes.createPolicy('cx-widget', { createHTML: (s: string) => s });
      const f = document.createElement('iframe');
      w.f = f;
      f.setAttribute('sandbox', 'allow-scripts');
      f.style.cssText = 'position:fixed;left:40px;top:160px;width:320px;height:180px;z-index:50;border:2px solid red;background:white';
      f.addEventListener('pointerover', () => w.over++);
      f.addEventListener('pointerout', () => w.out++);
      window.addEventListener('message', (e) => {
        if (e.source !== f.contentWindow) return;
        w.msgs.push(e.data);
        if ((e.data as { type?: string })?.type === 'boot') f.contentWindow!.postMessage({ type: 'load', scripts: [probe] }, '*');
      });
      f.srcdoc = tt.createHTML(`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><script>${boot}</script></head><body><input id="i" placeholder="widget input"></body></html>`);
      document.body.append(f);
    },
    { boot: WIDGET_BOOTSTRAP, csp: WIDGET_CSP.replace('HASH', hash), probe: PROBE },
  );
  const msgs = () => panel.evaluate(() => (window as unknown as { __w: { msgs: { type: string; k?: string; v?: unknown }[] } }).__w.msgs);
  const probe = async (k: string, timeout = 5000) => {
    await expect.poll(async () => (await msgs()).some((m) => m.type === 'probe' && m.k === k), { timeout }).toBe(true).catch(() => {});
    return (await msgs()).filter((m) => m.type === 'probe' && m.k === k).map((m) => m.v);
  };
  note('boot', (await probe('ready', 10_000)).length ? 'bootstrap ran, appended script ran' : `no ready; messages: ${JSON.stringify(await msgs())}`);
  for (const k of ['origin', 'parentDoc', 'rtc', 'prefetchRel', 'ttDefault', 'fetch']) note(k, await probe(k));

  // 2. vscode-resource URL from inside the widget (the panel's own base URL for the explainer folder).
  await panel.evaluate(() => {
    const w = (window as unknown as { __w: { f: HTMLIFrameElement } }).__w;
    w.f.contentWindow!.postMessage({ type: 'resource', url: `${document.getElementById('app')!.dataset.base}assets/dot.svg` }, '*');
  });
  note('resource', await probe('resource'));

  // 3. Pointer events on the iframe element, seen by the panel.
  const wbox = (await page.frameLocator('iframe.webview.ready').frameLocator('#active-frame').locator('iframe[sandbox="allow-scripts"]').boundingBox())!;
  await page.mouse.move(wbox.x - 30, wbox.y - 30);
  await page.mouse.move(wbox.x + 100, wbox.y + 60, { steps: 5 });
  await page.waitForTimeout(300);
  await page.mouse.move(wbox.x - 30, wbox.y - 30, { steps: 5 });
  await page.waitForTimeout(300);
  note('pointer', await panel.evaluate(() => { const w = (window as unknown as { __w: { over: number; out: number } }).__w; return { over: w.over, out: w.out }; }));

  // 4. Keyboard: focus the widget's input by clicking it, then a VS Code shortcut (Quick Open).
  await page.mouse.click(wbox.x + 20, wbox.y + 12);
  await page.keyboard.type('ab');
  await page.waitForTimeout(500);
  note('typedInWidget', (await msgs()).filter((m) => m.type === 'probe' && m.k === 'key').map((m) => m.v));
  await page.keyboard.press('ControlOrMeta+P');
  await page.waitForTimeout(800);
  note('quickOpenFromWidget', await page.locator('.quick-input-widget').isVisible());
  await page.keyboard.press('Escape');

  // 5. Focus theft from the editor: focus the code editor, then the widget focuses its input without a click.
  await page.keyboard.press('Escape');
  // Focus the code editor beside the panel (by coordinates: Playwright's actionability checks stall on workbench parts here).
  const ed = (await page.locator('.monaco-editor[data-uri$="bit_reader.sv"] .view-lines').first().boundingBox())!;
  await page.mouse.click(ed.x + 200, ed.y + 40);
  await page.waitForTimeout(300);
  const before = await page.evaluate(() => document.activeElement?.className ?? '');
  await panel.evaluate(() => (window as unknown as { __w: { f: HTMLIFrameElement } }).__w.f.contentWindow!.postMessage({ type: 'steal', after: 300 }, '*'));
  await page.waitForTimeout(1200);
  note('focusTheft', { before, after: await page.evaluate(() => `${document.activeElement?.tagName}.${document.activeElement?.className}`), widgetSays: await probe('stole', 1000) });

  // 6. Busy widget: does it stall the panel, and the workbench?
  const tick = (f: Frame | Page) => f.evaluate(() => { const w = window as unknown as { __ticks: number }; w.__ticks = 0; const id = setInterval(() => w.__ticks++, 100); setTimeout(() => clearInterval(id), 4000); });
  await tick(panel);
  await tick(page);
  await panel.evaluate(() => (window as unknown as { __w: { f: HTMLIFrameElement } }).__w.f.contentWindow!.postMessage({ type: 'busy', ms: 3000 }, '*'));
  await page.waitForTimeout(4500);
  note('busyTicks', {
    panel: await panel.evaluate(() => (window as unknown as { __ticks: number }).__ticks).catch((e) => String(e)),
    workbench: await page.evaluate(() => (window as unknown as { __ticks: number }).__ticks),
    expectedIfUnblocked: 40,
  });

  // 7. Hung widget: is the workbench still responsive, and does closing the panel recover?
  await panel.evaluate(() => (window as unknown as { __w: { f: HTMLIFrameElement } }).__w.f.contentWindow!.postMessage({ type: 'hang' }, '*'));
  await page.waitForTimeout(1500);
  const t0 = Date.now();
  const wbAlive = await Promise.race([page.evaluate(() => 1 + 1).then(() => Date.now() - t0), page.waitForTimeout(5000).then(() => 'timeout')]);
  note('workbenchResponsiveDuringHang', wbAlive);
  const panelAlive = await Promise.race([panel.evaluate(() => 1).then(() => 'alive'), page.waitForTimeout(3000).then(() => 'hung')]);
  note('panelDuringHang', panelAlive);
  await command(page, 'View: Close All Editors');
  await page.waitForTimeout(2000);
  note('webviewAfterCloseAll', await page.locator('iframe.webview.ready').count());
  const t1 = Date.now();
  await page.evaluate(() => 1);
  note('workbenchAfterClose_ms', Date.now() - t1);
  // And a new panel opens normally afterwards.
  const again = await openExplainer(page, 'retry-backoff').then(() => 'reopened').catch((e) => `failed: ${e}`);
  note('reopenAfterHang', again);

  writeFileSync(test.info().outputPath('widgets-spike.json'), JSON.stringify(results, null, 2));
});

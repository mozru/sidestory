// A long session in real VS Code: panels opened and closed, details dived into and left, many times over.
// The workbench must stay responsive, closed panels must take their webviews with them, and the extension
// host's heap (measured after garbage collection) must not keep growing.
import { expect, type Page, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { command, content, inContainer, openExplainer, resetWorkbench } from './helpers.ts';

test.beforeEach(async ({ page }) => resetWorkbench(page));

/** The (minified) names of the extension's per-panel classes, read from the bundle the container runs. */
/** Fields that identify each class's objects in a heap snapshot (set by classNames). */
const FIELDS: Record<string, string[]> = {};

function classNames(): { session: string; decorations: string } {
  const bundle = readFileSync(new URL('../../dist/extension.cjs', import.meta.url), 'utf8');
  // `X=class{trail;panel;positions=` when minified; spaced out otherwise.
  const name = (...fields: string[]) => new RegExp(`([\\w$]+)\\s*=\\s*class\\s*\\{\\s*${fields.join('[;=\\s]+')}`).exec(bundle)?.[1];
  const session = name('trail', 'panel', 'positions');
  const decorations = name('focusTypes');
  if (!session || !decorations) throw new Error('ExplainerSession or Decorations not found in dist/extension.cjs');
  FIELDS[session] = ['trail', 'panel', 'positions'];
  FIELDS[decorations] = ['focusTypes'];
  return { session, decorations };
}

/**
 * The extension host after a full GC: its used JS heap and, if classes are given, how many objects of
 * each are alive (from a heap snapshot). Opens the host's inspector (SIGUSR1, on the container's loopback only) and
 * asks it over the DevTools protocol, with the server's own Node.
 */
function extensionHost(classes: string[] = []): { heap: number; live: Record<string, number> } {
  const script = `
    const classes = ${JSON.stringify(classes)};
    const list = await (await fetch('http://127.0.0.1:9229/json/list')).json();
    const ws = new WebSocket(list[0].webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    let id = 0;
    let chunks = [];
    ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.method === 'HeapProfiler.addHeapSnapshotChunk') chunks.push(m.params.chunk); });
    const call = (method) => new Promise((resolve) => {
      const me = ++id;
      const on = (e) => { const m = JSON.parse(e.data); if (m.id === me) { ws.removeEventListener('message', on); resolve(m.result); } };
      ws.addEventListener('message', on);
      ws.send(JSON.stringify({ id: me, method }));
    });
    for (let i = 0; i < 3; i++) await call('HeapProfiler.collectGarbage');
    const heap = (await call('Runtime.getHeapUsage')).usedSize;
    if (!classes.length) {
      console.log(JSON.stringify({ heap, live: {} }));
      process.exit(0);
    }
    await call('HeapProfiler.takeHeapSnapshot'); // (it leaves the heap bigger: take it last)
    ws.close();
    const snap = JSON.parse(chunks.join(''));
    chunks = [];
    const f = snap.snapshot.meta.node_fields;
    const objectType = snap.snapshot.meta.node_types[0].indexOf('object');
    const live = Object.fromEntries(classes.map((c) => [c, 0]));
    // Minified names can collide with VS Code's own minified classes: count only objects that also have
    // the class's own fields.
    const fields = ${JSON.stringify(Object.fromEntries(classes.map((c) => [c, FIELDS[c] ?? []])))};
    const ef = snap.snapshot.meta.edge_fields;
    const propertyType = snap.snapshot.meta.edge_types[0].indexOf('property');
    let edge = 0;
    for (let i = 0; i < snap.nodes.length; i += f.length) {
      const name = snap.strings[snap.nodes[i + f.indexOf('name')]];
      const edges = snap.nodes[i + f.indexOf('edge_count')];
      if (snap.nodes[i + f.indexOf('type')] === objectType && name in live) {
        const props = new Set();
        for (let k = 0; k < edges; k++) {
          const e = edge + k * ef.length;
          if (snap.edges[e + ef.indexOf('type')] === propertyType) props.add(snap.strings[snap.edges[e + ef.indexOf('name_or_index')]]);
        }
        if (fields[name].every((p) => props.has(p))) live[name]++;
      }
      edge += edges * ef.length;
    }
    console.log(JSON.stringify({ heap, live }));`;
  const out = inContainer(
    `pid=$(pgrep -n -f '[t]ype=extensionHost') && kill -USR1 $pid && sleep 1 && "$OPENVSCODE_SERVER_ROOT/node" --input-type=module -e "$CX_SCRIPT"`.replace('$CX_SCRIPT', script.replace(/(["\\$`])/g, '\\$1')),
  );
  return JSON.parse(out.trim().split('\n').at(-1)!);
}

/** The extension host's resident memory, from /proc (no GC: for the record, not for asserting). */
const extensionHostRss = () => Number(inContainer(`grep VmRSS /proc/$(pgrep -n -f '[t]ype=extensionHost')/status | awk '{print $2}'`).trim()) * 1024;

/** Time for the command palette to open: a stand-in for "the workbench still answers". */
async function paletteMs(page: Page): Promise<number> {
  await page.locator('.part.sidebar .composite.title').click();
  const t0 = Date.now();
  await page.keyboard.press('F1');
  await expect(page.locator('.quick-input-widget')).toBeVisible();
  const ms = Date.now() - t0;
  await page.keyboard.press('Escape');
  return ms;
}

async function cycle(page: Page): Promise<void> {
  const panel = await openExplainer(page, 'overview');
  await expect(panel.locator('.cx-title')).toHaveText('Sample workspace tour');
  await content(panel).locator('[data-explain-detail="bit-reader"] .cx-dive').click();
  await expect(panel.locator('.cx-title')).toHaveText('A backward bit reader in five moves');
  await expect(panel.locator('.cx-position')).toHaveText(/Step \d of 5/);
  await panel.locator('.cx-back').click();
  await expect(panel.locator('.cx-title')).toHaveText('Sample workspace tour');
  await command(page, 'View: Close All Editors');
  await expect(page.locator('iframe.webview')).toHaveCount(0);
}

test('opening, diving, coming back and closing 20 times leaves nothing behind', async ({ page }) => {
  test.setTimeout(300_000);
  await expect(page.locator('iframe.webview')).toHaveCount(0);
  // Warm up: first-use costs (the webview's code, caches VS Code fills once) aren't leaks.
  await cycle(page);
  await cycle(page);
  const { session, decorations } = classNames();
  const before = { heap: extensionHost().heap, rss: extensionHostRss(), palette: await paletteMs(page) };
  for (let i = 0; i < 20; i++) await cycle(page);
  const rss = extensionHostRss(); // before the heap snapshot, which grows it
  const after = { ...extensionHost([session, decorations]), rss, palette: await paletteMs(page) };
  const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;
  console.log(
    `[perf] extension host after 20 open/dive/back/close cycles: heap ${mb(before.heap)} → ${mb(after.heap)}, RSS ${mb(before.rss)} → ${mb(after.rss)}; ` +
      `live sessions ${after.live[session]}, decorations ${after.live[decorations]}; command palette ${before.palette} → ${after.palette} ms`,
  );
  // Every panel is closed: no webview, session or set of editor decorations is left.
  await expect(page.locator('iframe.webview')).toHaveCount(0);
  expect(after.live).toEqual({ [session]: 0, [decorations]: 0 });
  // A leaked session (its manifest, resolutions, watchers) per cycle would add well over this.
  expect(after.heap - before.heap).toBeLessThan(3_000_000);
  expect(after.palette).toBeLessThan(Math.max(1000, before.palette * 3));
  // The count is real: with a panel open, its session is found.
  await openExplainer(page, 'overview');
  expect(extensionHost([session, decorations]).live).toEqual({ [session]: 1, [decorations]: 1 });
});

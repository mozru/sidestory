// Memory and speed of the panel over long sessions: repeated updates, dives and frame rebuilds must not
// leave anything behind, and a big explainer must stay quick to render and to step through.
import { type CDPSession, expect, type Page, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { AnchorView, ToWebview } from '../../src/shared/protocol.ts';
import { compile, ON, serve } from './widget-helpers.ts';

const FIXTURE = 'fixtures/sample-workspace/.sidestory/bit-reader';
const HTML = readFileSync(`${FIXTURE}/sidestory.html`, 'utf8');
const MANIFEST = JSON.parse(readFileSync(`${FIXTURE}/manifest.json`, 'utf8')) as { title: string; anchors: Record<string, { file: string; range: [number, number] }> };
const ANCHORS: AnchorView[] = Object.entries(MANIFEST.anchors).map(([id, a]) => ({ id, file: a.file, range: { start: a.range[0], end: a.range[1] }, state: 'exact' }));
const ROOT_TRAIL = [{ name: 'bit-reader', title: MANIFEST.title }];
const DIR = 'file:///ws/.sidestory/bit-reader';

const send = (page: Page, m: ToWebview) => page.evaluate((msg) => (window as unknown as { __send(m: unknown): void }).__send(msg), m);
const base = (page: Page, name: string) => page.evaluate((n) => `${location.origin}/fixtures/sample-workspace/.sidestory/${n}/`, name);
const frame = (page: Page) => page.frameLocator('iframe.cx-content-frame');

interface Sample {
  heap: number;
  nodes: number;
  listeners: number;
  documents: number;
  frames: number;
  blobs: number;
  timers: number;
}

/** Before the panel's script runs: counts live blob: URLs (created, not revoked) and pending timeouts. */
async function instrument(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const blobs = new Set<string>();
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (o: Blob | MediaSource) => {
      const u = create(o);
      blobs.add(u);
      return u;
    };
    URL.revokeObjectURL = (u: string) => {
      blobs.delete(u);
      revoke(u);
    };
    const timers = new Set<unknown>();
    const set = window.setTimeout.bind(window);
    const clear = window.clearTimeout.bind(window);
    window.setTimeout = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
      const id = set(() => {
        timers.delete(id);
        if (typeof fn === 'function') fn(...args);
      }, ms);
      timers.add(id);
      return id;
    }) as typeof window.setTimeout;
    window.clearTimeout = ((id?: number) => {
      timers.delete(id);
      clear(id);
    }) as typeof window.clearTimeout;
    (window as unknown as { __live: () => { blobs: number; timers: number } }).__live = () => ({ blobs: blobs.size, timers: timers.size });
  });
}

async function sample(page: Page, cdp: CDPSession): Promise<Sample> {
  // The harness records every posted message: not the panel's memory.
  await page.evaluate(() => ((window as unknown as { __posted: unknown[] }).__posted.length = 0));
  for (let i = 0; i < 3; i++) await cdp.send('HeapProfiler.collectGarbage');
  const { usedSize } = await cdp.send('Runtime.getHeapUsage');
  const { metrics } = await cdp.send('Performance.getMetrics');
  const m = (name: string) => metrics.find((x) => x.name === name)?.value ?? NaN;
  const live = await page.evaluate(() => (window as unknown as { __live: () => { blobs: number; timers: number } }).__live());
  return { heap: usedSize, nodes: m('Nodes'), listeners: m('JSEventListeners'), documents: m('Documents'), frames: m('Frames'), ...live };
}

async function load(page: Page): Promise<void> {
  await instrument(page);
  await page.goto('/test/webview/harness.html');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __posted: { type: string }[] }).__posted.some((m) => m.type === 'ready'))).toBe(true);
}

async function start(page: Page, html = HTML): Promise<CDPSession> {
  await load(page);
  await send(page, { type: 'init', title: MANIFEST.title, html, anchors: ANCHORS, dir: DIR, base: await base(page, 'bit-reader'), trail: ROOT_TRAIL });
  await expect(page.locator('.cx-position')).toHaveText(/Step \d of/);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  return cdp;
}

/** Waits until the panel has rendered the given marker text. */
const rendered = (page: Page, marker: string) => expect(frame(page).getByText(marker, { exact: true })).toBeAttached();

function report(name: string, warm: Sample, end: Sample): void {
  const d = (k: keyof Sample) => `${k} ${warm[k]} → ${end[k]}`;
  console.log(`[perf] ${name}: heap ${(warm.heap / 1e6).toFixed(2)} MB → ${(end.heap / 1e6).toFixed(2)} MB; ${d('nodes')}; ${d('listeners')}; ${d('documents')}; ${d('frames')}; ${d('blobs')}; ${d('timers')}`);
}

/** After warming up, more cycles mustn't grow anything that should be released. */
function expectBounded(warm: Sample, end: Sample): void {
  expect(end.documents).toBeLessThanOrEqual(warm.documents);
  expect(end.frames).toBeLessThanOrEqual(warm.frames);
  expect(end.listeners).toBeLessThanOrEqual(warm.listeners + 5);
  expect(end.nodes).toBeLessThanOrEqual(warm.nodes * 1.1 + 50);
  expect(end.blobs).toBeLessThanOrEqual(warm.blobs);
  expect(end.timers).toBeLessThanOrEqual(warm.timers + 2);
  expect(end.heap).toBeLessThan(warm.heap * 1.2 + 1_000_000);
}

const IMAGES = Array.from({ length: 6 }, (_, i) => `<img alt="" src="assets/dot.svg?v=${i}">`).join('');
const withImages = (html: string, marker: string) => html.replace('</h2>', `</h2><p>${marker}</p>${IMAGES}`);

test.describe('memory', () => {
  test.describe.configure({ timeout: 120_000 });

  test('content updates release what they replace', async ({ page }) => {
    const cdp = await start(page, withImages(HTML, 'u0'));
    let warm: Sample | undefined;
    for (let i = 1; i <= 200; i++) {
      await send(page, { type: 'content', title: MANIFEST.title, html: withImages(HTML, `u${i}`) });
      if (i % 20 === 0) await send(page, { type: 'anchors', anchors: ANCHORS.map((a, j) => ({ ...a, state: (i + j) % 3 === 0 ? 'stale' : 'exact' })) });
      if (i === 20 || i === 200) {
        await rendered(page, `u${i}`);
        await page.waitForTimeout(2000); // the "updated" flashes run out
        if (i === 20) warm = await sample(page, cdp);
      }
    }
    const end = await sample(page, cdp);
    report('200 content updates', warm!, end);
    expectBounded(warm!, end);
  });

  test('diving and going back release the explainer left', async ({ page }) => {
    const cdp = await start(page);
    const child = { dir: 'file:///ws/.sidestory/retry-backoff', base: await base(page, 'retry-backoff') };
    const root = { dir: DIR, base: await base(page, 'bit-reader') };
    let warm: Sample | undefined;
    for (let i = 1; i <= 50; i++) {
      const childHtml = `<section data-explain-anchor="loop"><h2>Loop ${i}</h2><img alt="" src="assets/backoff.svg"><div data-explain-detail="bit-reader"></div></section>`;
      await send(page, { type: 'init', title: 'Retry', html: childHtml, anchors: [], ...child, trail: [...ROOT_TRAIL, { name: 'retry-backoff', title: 'Retry' }] });
      await rendered(page, `Loop ${i}`);
      await send(page, { type: 'details', items: [{ name: 'bit-reader', found: true, title: MANIFEST.title, summary: 's', steps: 5 }] });
      await send(page, { type: 'init', title: MANIFEST.title, html: withImages(HTML, `back ${i}`), anchors: ANCHORS, ...root, trail: ROOT_TRAIL });
      await rendered(page, `back ${i}`);
      if (i === 10) warm = await sample(page, cdp);
    }
    const end = await sample(page, cdp);
    report('50 dive/back', warm!, end);
    expectBounded(warm!, end);
  });

  test('rebuilding the content frame releases the old one', async ({ page }) => {
    const cdp = await start(page, withImages(HTML, 'r0'));
    let warm: Sample | undefined;
    for (let i = 1; i <= 50; i++) {
      // Navigating the frame (which nothing in the content can do) makes the panel build a fresh one.
      const old = await page.locator('iframe.cx-content-frame').elementHandle();
      await page.evaluate(() => document.querySelector<HTMLIFrameElement>('iframe.cx-content-frame')!.contentWindow!.location.reload());
      await expect.poll(() => old!.evaluate((el) => el.isConnected)).toBe(false);
      await expect(page.locator('.cx-position')).toHaveText(/Step \d of/);
      await expect(frame(page).locator('[data-explain-anchor]').first()).toBeAttached();
      await old!.dispose();
      if (i === 10) warm = await sample(page, cdp);
    }
    const end = await sample(page, cdp);
    report('50 frame rebuilds', warm!, end);
    expectBounded(warm!, end);
  });

  test('asset invalidations revoke the blobs they replace', async ({ page }) => {
    const cdp = await start(page, withImages(HTML, 'a0'));
    let warm: Sample | undefined;
    for (let i = 1; i <= 50; i++) {
      const before = await frame(page).locator('img').first().getAttribute('src');
      await send(page, { type: 'assetsChanged', paths: ['assets/dot.svg'] });
      await expect(frame(page).locator('img').first()).not.toHaveAttribute('src', before!);
      await expect(frame(page).locator('img').first()).toHaveAttribute('src', /^blob:/);
      if (i === 10) {
        await page.waitForTimeout(2000); // the "updated" flashes run out (a reply's 5 s timeout must not linger)
        warm = await sample(page, cdp);
      }
    }
    await page.waitForTimeout(2000);
    const end = await sample(page, cdp);
    report('50 asset invalidations', warm!, end);
    expectBounded(warm!, end);
  });
});

test.describe('widget memory', () => {
  test.describe.configure({ timeout: 180_000 });

  test('50 widget mount/unmount cycles return to baseline: frames, listeners, blob URLs, targets', async ({ page }) => {
    const builds = await compile({
      'w/chart.tsx': `import { useState } from 'react';
import { Bar, BarChart, XAxis } from 'recharts';
import { Button } from '@/components/ui/button';
import { useWidgetState } from 'explainer';
export default function C() {
  const [n, setN] = useWidgetState('n', 1);
  const [t] = useState(() => setInterval(() => {}, 1000));
  void t;
  return <div><BarChart width={300} height={120} data={[{ a: 'x', v: n }, { a: 'y', v: 2 }]}><XAxis dataKey="a" /><Bar dataKey="v" /></BarChart><Button onClick={() => setN(n + 1)}>inc</Button></div>;
}`,
    });
    await load(page);
    await serve(page, builds);
    const html = HTML.replace('</h2>', '</h2><explain-widget src="w/chart.tsx" id="c"><p>fallback</p></explain-widget>');
    await send(page, { type: 'init', title: MANIFEST.title, html, anchors: ANCHORS, dir: DIR, base: await base(page, 'bit-reader'), trail: ROOT_TRAIL });
    await expect(page.locator('.cx-position')).toHaveText(/Step \d of/);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const targets = async () => (await cdp.send('Target.getTargets')).targetInfos.filter((t) => t.type === 'iframe').length;
    const live = () => frame(page).locator('explain-widget[data-cx-wstate="live"]');
    const cycle = async () => {
      await send(page, { type: 'widgets', gate: ON });
      await expect(live()).toHaveCount(1);
      await send(page, { type: 'widgets', gate: { ...ON, status: 'ask' } });
      await expect(page.locator('iframe.cx-widget-frame')).toHaveCount(0);
    };
    // With no widget mounted yet, the baseline: no widget frames, no extra targets.
    await send(page, { type: 'widgets', gate: { ...ON, status: 'ask' } });
    const base0 = { frames: await page.locator('iframe.cx-widget-frame').count(), targets: await targets() };
    let warm: Sample | undefined;
    for (let i = 1; i <= 50; i++) {
      await cycle();
      if (i === 10) {
        await page.waitForTimeout(1500); // the state save timer and the last pings run out
        warm = await sample(page, cdp);
      }
    }
    await page.waitForTimeout(1500);
    const end = await sample(page, cdp);
    report('50 widget mount/unmount cycles', warm!, end);
    expectBounded(warm!, end);
    expect(await page.locator('iframe.cx-widget-frame').count()).toBe(base0.frames);
    expect(await targets()).toBeLessThanOrEqual(base0.targets);
  });
});

/** A big explainer: `n` sections of about 4 kB each (500 → 2 MB). */
function bigExplainer(n: number, marker = ''): { html: string; anchors: AnchorView[] } {
  const para = 'The reader keeps sixty-four bits and refills from the producer whenever fewer than the consumer asks for remain. '.repeat(6);
  const sections = Array.from(
    { length: n },
    (_, i) =>
      `<section data-explain-anchor="s${i}"><h2>Section ${i}${i === 0 ? marker : ''}</h2><p>${para}</p><p>See <code data-explain-ref="s${(i + 1) % n}">next</code>.</p><pre><code>${'always_ff @(posedge clk) begin\n  q &lt;= d;\nend\n'.repeat(40)}</code></pre><p>${para}</p><details><summary>More</summary><p>${para}</p></details></section>`,
  );
  return {
    html: `<h1>Big</h1>${sections.join('\n')}`,
    anchors: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, file: 'rtl/x.sv', range: { start: i * 10 + 1, end: i * 10 + 9 }, state: 'exact' })),
  };
}

/** Done when an element matches `selector` (in the content frame with `inFrame`) and its text includes `text`. */
interface Until {
  selector: string;
  inFrame?: boolean;
  text?: string;
}

/** Time from posting a message to the page until `until` holds (checked every frame) and the next frame is drawn. */
async function timeTo(page: Page, m: ToWebview, until: Until): Promise<number> {
  return page.evaluate(
    ([msg, u]) =>
      new Promise<number>((resolve) => {
        const check = () => {
          const doc = u.inFrame ? document.querySelector<HTMLIFrameElement>('iframe.cx-content-frame')!.contentDocument! : document;
          const el = doc.querySelector(u.selector);
          return !!el && (u.text === undefined || (el.textContent ?? '').includes(u.text));
        };
        const t0 = performance.now();
        (window as unknown as { __send(m: unknown): void }).__send(msg);
        const painted = () => requestAnimationFrame(() => setTimeout(() => resolve(performance.now() - t0)));
        const poll = () => (check() ? painted() : requestAnimationFrame(poll));
        poll();
      }),
    [m, until] as const,
  );
}

test.describe('speed', () => {
  test.describe.configure({ timeout: 120_000 });

  test('a 2 MB explainer with 500 sections renders, updates and steps quickly', async ({ page }) => {
    const big = bigExplainer(500);
    expect(big.html.length).toBeGreaterThan(2_000_000);
    await load(page);
    const position = (n: number): Until => ({ selector: '.cx-position', text: `Step ${n} of 500` });
    const init = await timeTo(page, { type: 'init', title: 'Big', html: big.html, anchors: big.anchors, dir: DIR, base: await base(page, 'bit-reader'), trail: ROOT_TRAIL }, position(1));
    const edited = bigExplainer(500, ' (edited)');
    const update = await timeTo(page, { type: 'content', title: 'Big', html: edited.html }, { selector: '[data-explain-anchor="s0"] h2', inFrame: true, text: 'edited' });
    // What a keystroke in linked code sends: every anchor's state, one of them changed.
    const states = big.anchors.map((a, i) => ({ ...a, state: i === 7 ? ('changed' as const) : a.state }));
    const anchorsMs = await timeTo(page, { type: 'anchors', anchors: states }, { selector: '[data-explain-anchor="s7"][data-cx-state="changed"]', inFrame: true });
    const steps: number[] = [];
    for (let i = 0; i < 10; i++) steps.push(await timeTo(page, { type: 'navigate', delta: 1 }, position(i + 2)));
    const sync = await timeTo(page, { type: 'syncTo', anchorId: 's400', jump: true }, position(401));
    const step = steps.sort((a, b) => a - b)[5]!;
    console.log(`[perf] 500 sections, ${(big.html.length / 1e6).toFixed(1)} MB: init ${init.toFixed(0)} ms, content update ${update.toFixed(0)} ms, anchors ${anchorsMs.toFixed(0)} ms, step (median) ${step.toFixed(0)} ms, syncTo ${sync.toFixed(0)} ms`);
    expect(init).toBeLessThan(5000);
    expect(update).toBeLessThan(5000);
    expect(anchorsMs).toBeLessThan(500);
    expect(step).toBeLessThan(200);
    expect(sync).toBeLessThan(300);
  });
});

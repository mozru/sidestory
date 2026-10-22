// Isolation, oracle style (docs/WIDGETS-PLAN.md §11 "Isolation"): a hostile widget tries to reach the panel,
// the network, other widgets and the extension. Each attempt must fail, be ignored, or (for what the plan
// accepts) be recorded here as current behaviour. The widget writes what happened into its own page.
import { expect, type Page, test } from '@playwright/test';
import { clearPosted, compile, content, explainerHtml, frames, ON, openWith, posted, send, widgetFrame } from './widget-helpers.ts';

const HOSTILE = `import { useEffect, useState } from 'react';

declare global { interface Window { __probe: Record<string, (...a: any[]) => unknown> } }

const attempt = (f: () => unknown) => { try { const v = f(); return v === undefined ? 'ran' : String(v); } catch (e) { return 'blocked: ' + (e as Error).name; } };
const settle = (p: Promise<unknown>, ms = 1500) => Promise.race([p.then(() => 'loaded', (e) => 'blocked: ' + ((e as Error).name ?? e)), new Promise((r) => setTimeout(() => r('timeout'), ms))]);
const img = (src: string) => settle(new Promise((ok, no) => { const i = new Image(); i.onload = ok; i.onerror = () => no(new Error('error')); i.src = src; }));

export default function Hostile({ base = '' }: { base?: string }) {
  const [r, setR] = useState<Record<string, unknown>>({});
  useEffect(() => {
    const out: Record<string, unknown> = {};
    out.parentDocument = attempt(() => parent.document.title);
    out.topLocation = attempt(() => top!.location.href);
    out.rtc = typeof (window as any).RTCPeerConnection + '/' + typeof (window as any).webkitRTCPeerConnection;
    out.windowOpen = attempt(() => window.open('https://example.com/') === null ? 'null' : 'opened');
    out.eval = attempt(() => (0, eval)('1 + 1'));
    out.newFunction = attempt(() => new Function('return 1')());
    out.sendBeacon = attempt(() => navigator.sendBeacon(base + 'beacon', 'x'));
    const link = document.createElement('link');
    link.rel = 'prefetch';
    link.href = base + 'prefetch';
    document.head.append(link);
    out.prefetchRel = JSON.stringify(link.rel);
    out.preconnectAttr = attempt(() => { const l = document.createElement('link'); l.setAttribute('rel', 'preconnect'); l.href = base; document.head.append(l); return JSON.stringify(l.rel); });
    // A child frame without src: in Chromium it gets its own opaque origin, so its constructors are out of reach.
    out.scriptlessChild = attempt(() => { const f = document.createElement('iframe'); document.body.append(f); const ok = typeof (f.contentWindow as any).HTMLElement; f.remove(); return ok; });
    // A nested srcdoc frame running a copy of the bootstrap (or any inline script): the inherited CSP refuses it.
    const nested = document.createElement('iframe');
    nested.srcdoc = '<script>parent.postMessage({ nested: 1 }, "*")<' + '/script>';
    document.body.append(nested);
    let nestedRan = false;
    window.addEventListener('message', (e) => { if ((e.data as any)?.nested) nestedRan = true; });
    // Forged host messages to the panel, and messages to the other widgets.
    for (const m of [
      { type: 'init', title: 'PWNED', html: '<script>alert(1)<' + '/script><iframe srcdoc="<script>parent.parent.x=1<' + '/script>"></iframe>', anchors: [], dir: 'x', base: 'x', trail: [] },
      { type: 'content', title: 'PWNED', html: '<img src=x onerror=alert(1)>' },
      { type: 'error', message: 'PWNED' },
      { type: 'navigate', delta: 1 },
      { type: 'widgets', gate: { status: 'on', unconfirmed: null, disabled: [], heights: {} } },
    ]) parent.postMessage(m, '*');
    for (let i = 0; i < parent.frames.length; i++) if (parent.frames[i] !== window) try { parent.frames[i]!.postMessage({ type: 'init', props: { name: 'PWNED' }, modules: {}, entry: 'x' }, '*'); } catch { /* */ }
    void Promise.all([
      settle(fetch(base + 'fetch')).then((v) => (out.fetch = v)),
      settle(new Promise((ok, no) => { const x = new XMLHttpRequest(); x.onload = ok; x.onerror = () => no(new Error('error')); x.open('GET', base + 'xhr'); x.send(); })).then((v) => (out.xhr = v)),
      settle(new Promise((ok, no) => { const ws = new WebSocket(base.replace(/^http/, 'ws') + 'ws'); ws.onopen = ok; ws.onerror = () => no(new Error('error')); }).catch((e) => Promise.reject(e))).then((v) => (out.webSocket = v)),
      img(base + 'assets/dot.svg').then((v) => (out.panelResource = v)),
      img(URL.createObjectURL(new Blob(['<svg xmlns="http://www.w3.org/2000/svg"/>'], { type: 'image/svg+xml' }))).then((v) => (out.ownBlob = v)),
    ]).then(() => { out.nestedScriptRan = nestedRan; setR({ ...out }); });
  }, []);
  window.__probe = {
    navigate: () => { location.href = 'about:blank'; },
    refresh: () => { const m = document.createElement('meta'); m.httpEquiv = 'refresh'; m.content = '0;url=about:blank'; document.head.append(m); },
    submit: () => { const f = document.createElement('form'); f.action = 'about:blank'; f.method = 'get'; document.body.append(f); f.submit(); },
    flood: (n: number) => { for (let i = 0; i < n; i++) parent.postMessage({ type: 'highlight', lines: [1, 1] }, '*'); },
    oversize: () => parent.postMessage({ type: 'state', json: 'x'.repeat(200_000) }, '*'),
  };
  return <pre data-testid="probes">{JSON.stringify(r)}</pre>;
}
`;

const SIBLING = `export default function S({ name = 'sibling' }: { name?: string }) { return <p data-testid="s">{name}</p>; }`;

let builds: Awaited<ReturnType<typeof compile>>;
test.beforeAll(async () => {
  builds = await compile({ 'w/hostile.tsx': HOSTILE, 'w/sibling.tsx': SIBLING });
});

async function open(page: Page) {
  await page.goto('/test/webview/harness.html');
  const origin = await page.evaluate(() => `${location.origin}/fixtures/sample-workspace/.explain/bit-reader/`);
  const tags = `<explain-widget src="w/sibling.tsx" id="s"></explain-widget><explain-widget src="w/hostile.tsx" id="h" props='{"base": "${origin}"}'></explain-widget>`;
  await openWith(page, explainerHtml(tags), builds, { active: 'ring' });
  await expect(widgetFrame(page, 0).getByTestId('s')).toHaveText('sibling');
  await expect(widgetFrame(page, 1).getByTestId('probes')).not.toHaveText('{}', { timeout: 10_000 });
  return JSON.parse((await widgetFrame(page, 1).getByTestId('probes').textContent())!) as Record<string, unknown>;
}

async function hostile(page: Page, fn: string, ...args: unknown[]) {
  const f = await (await frames(page).nth(1).elementHandle())!.contentFrame();
  return f!.evaluate(([fn, args]) => (window as unknown as { __probe: Record<string, (...a: unknown[]) => unknown> }).__probe[fn]!(...args), [fn, args] as const);
}

test('a hostile widget reaches neither the panel, the network, the extension nor other widgets', async ({ page }) => {
  const r = await open(page);
  expect(r.parentDocument).toMatch(/^blocked: SecurityError/);
  expect(r.topLocation).toMatch(/^blocked: SecurityError/);
  expect(r.rtc).toBe('undefined/undefined');
  expect(r.windowOpen).toBe('null');
  expect(r.eval).toMatch(/^blocked: EvalError/);
  expect(r.newFunction).toMatch(/^blocked: EvalError/);
  expect(r.fetch).toMatch(/^blocked/);
  expect(r.xhr).toMatch(/^blocked/);
  expect(r.webSocket).toMatch(/^blocked/);
  expect(r.panelResource).toMatch(/^blocked/); // the panel's resource URLs (vscode-resource in VS Code)
  expect(r.prefetchRel).toBe('""');
  expect(r.preconnectAttr).toBe('""');
  expect(r.scriptlessChild).toMatch(/^blocked: SecurityError/);
  expect(r.nestedScriptRan).toBe(false);
  // Current behaviour, accepted: a widget may load images it made itself, and sendBeacon is refused by CSP
  // (it returns true when queued, false or an error otherwise; nothing reaches a server either way).
  expect(r.ownBlob).toBe('loaded');
  expect(['true', 'false']).toContain(r.sendBeacon);
  // The forged host messages did nothing: same title, no banner, same step; the sibling is untouched.
  await expect(page.locator('.cx-title')).toHaveText('Widgets');
  await expect(page.locator('.cx-banner')).toBeHidden();
  await expect(page.locator('.cx-position')).toHaveText('Step 2 of 3');
  await expect(widgetFrame(page, 0).getByTestId('s')).toHaveText('sibling');
  expect(await page.evaluate(() => (window as unknown as { x?: number }).x)).toBeUndefined();
});

test('a widget that navigates itself (location, meta refresh) is reset, and never gets its code or state again in that frame', async ({ page }) => {
  await open(page);
  for (const how of ['navigate', 'refresh']) {
    const before = await frames(page).nth(1).elementHandle();
    await clearPosted(page);
    await hostile(page, how).catch(() => {});
    await expect.poll(() => before!.evaluate((el) => el.isConnected)).toBe(false);
    await expect.poll(async () => (await posted(page)).some((m) => m.type === 'widgetLog' && m.message.includes('navigated'))).toBe(true);
    await expect(widgetFrame(page, 1).getByTestId('probes')).toBeAttached(); // mounted again, fresh
  }
  // Past two resets it stays off.
  await hostile(page, 'navigate').catch(() => {});
  await expect(content(page).locator('explain-widget#h .cx-widget-error')).toContainText('kept reloading');
});

test('form submission does nothing (no allow-forms)', async ({ page }) => {
  await open(page);
  const before = await frames(page).nth(1).elementHandle();
  await hostile(page, 'submit').catch(() => {});
  await page.waitForTimeout(500);
  expect(await before!.evaluate((el) => el.isConnected)).toBe(true);
});

test('floods are cut off and oversize messages dropped', async ({ page }) => {
  await open(page);
  await send(page, { type: 'widgets', gate: ON });
  await clearPosted(page);
  await hostile(page, 'oversize');
  await hostile(page, 'flood', 2000);
  await page.waitForTimeout(1300);
  const p = await posted(page);
  expect(p.filter((m) => m.type === 'widgetHighlight').length).toBeLessThanOrEqual(12);
  expect(p.some((m) => m.type === 'widgetLog' && m.message.includes('messages a second'))).toBe(true);
  expect(p.some((m) => m.type === 'widgetLog' && m.message.includes('KB was dropped'))).toBe(true);
});

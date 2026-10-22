// Widgets in the panel (docs/WIDGETS-PLAN.md §11 "Panel"): frames over placeholders, the bridge, the
// activation and focus rules (§5.3), placement (§3), state and heights, caps, the consent bar. The harness
// answers for the extension (compiled widgets, library texts, anchor code); widgets are compiled by the
// real compiler. Test widgets expose `window.__probe` so a test can make them misbehave at a chosen moment
// (Playwright evaluates in the frame; that is not a user gesture).
import { expect, type FrameLocator, type Page, test } from '@playwright/test';
import type { FromWebview } from '../../src/shared/protocol.ts';
import { clearPosted, compile, content, explainerHtml, filler, frames, ON, openWith, posted, send, serve, widgetFrame } from './widget-helpers.ts';

const PROBE = `import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useWidgetState, useActiveStep, reveal, highlight, goToStep } from 'explainer';

declare global { interface Window { __probe: Record<string, (...a: any[]) => unknown> } }

export default function Probe({ name = 'w', start = 0, onStep = '' }: { name?: string; start?: number; onStep?: string }) {
  const [n, setN] = useWidgetState('n', start);
  const [extra, setExtra] = useState(0);
  const [result, setResult] = useState('');
  const step = useActiveStep();
  window.__probe = {
    // Focus through a scriptless child frame's unpatched focus(): the runtime's guard can't see it.
    // Focus without the runtime's focus() guard: a modal dialog's focusing steps.
    steal: () => {
      const d = document.createElement('dialog');
      const i = document.createElement('input');
      d.append(i);
      document.body.append(d);
      d.showModal();
      d.close();
      d.remove();
      return document.hasFocus();
    },
    reveal: (anchor = 'ring') => reveal(anchor),
    goToStep: (anchor: string) => goToStep(anchor),
    highlight: (lines: number[], anchor?: string) => highlight(lines, anchor ? { anchor } : {}),
    grow: (px: number) => setExtra(px),
  };
  useEffect(() => {
    if (onStep === 'highlight' && step) highlight([2, 3], { anchor: 'ring', identifiers: ['x'] });
  }, [step]);
  return <div className="p-2" style={{ minHeight: 100 + extra }}>
    <p data-testid="out">{name}:{n}|{step}|{result}</p>
    <Button data-testid="inc" onClick={() => setN(n + 1)}>inc</Button>
    <Button data-testid="reveal" onClick={() => { reveal('ring').then((ok) => setResult('reveal:' + ok)); }}>reveal</Button>
    <Button data-testid="later" onClick={async () => { await new Promise((r) => setTimeout(r, 600)); setResult('later:' + await reveal('ring')); }}>later</Button>
    <Button data-testid="go" onClick={() => { goToStep('tail').then((ok) => setResult('go:' + ok)); }}>go</Button>
    <input id="inp" data-testid="inp" />
  </div>;
}
`;

let builds: Awaited<ReturnType<typeof compile>>;
test.beforeAll(async () => {
  builds = await compile({ 'w/probe.tsx': PROBE });
});

const probeTag = (attrs = '', fallback = '<p>Fallback text</p>') => `<explain-widget src="w/probe.tsx" title="Probe"${attrs}>${fallback}</explain-widget>`;
const placeholder = (page: Page, n = 0) => content(page).locator('explain-widget').nth(n);
const out = (f: FrameLocator) => f.getByTestId('out');

/** Runs `window.__probe[fn](...args)` inside the n-th widget frame. */
async function widgetEval<T>(page: Page, n: number, fn: string, ...args: unknown[]): Promise<T> {
  const handle = await frames(page).nth(n).elementHandle();
  const f = await handle!.contentFrame();
  return f!.evaluate(([fn, args]) => (window as unknown as { __probe: Record<string, (...a: unknown[]) => unknown> }).__probe[fn]!(...args), [fn, args] as const) as Promise<T>;
}

const reveals = async (page: Page) => (await posted(page)).filter((m) => m.type === 'widgetReveal');
/** The element focused in the content frame (the panel's own document has the frame focused then). */
const contentFocus = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    if (a?.classList.contains('cx-widget-frame')) return 'widget';
    if (a?.classList.contains('cx-content-frame')) return (a as HTMLIFrameElement).contentDocument!.activeElement?.localName ?? 'none';
    return a?.localName ?? 'none';
  });

async function openProbe(page: Page, opts: { html?: string; active?: string } = {}) {
  await openWith(page, opts.html ?? explainerHtml(probeTag()), builds, { active: opts.active ?? 'ring' });
  await expect(out(widgetFrame(page))).toContainText('w:0');
}

/** The centre of an element in the widget frame, in page coordinates. */
async function centre(f: FrameLocator, testId: string) {
  const b = (await f.getByTestId(testId).boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

test.describe('mounting and rendering', () => {
  test('a widget mounts over its placeholder, labeled, with props and the active step', async ({ page }) => {
    await openWith(page, explainerHtml(probeTag(` props='{"start": 3, "name": "p"}'`)), builds, { active: 'ring' });
    await expect(frames(page)).toHaveCount(1);
    await expect(out(widgetFrame(page))).toHaveText('p:3|ring|');
    const ph = placeholder(page);
    await expect(ph).toHaveAttribute('data-cx-wstate', 'live');
    await expect(ph).toHaveAttribute('role', 'group');
    await expect(ph).toHaveAttribute('tabindex', '0');
    await expect(ph).toHaveAttribute('aria-label', 'Probe (interactive)');
    await expect(ph.locator('.cx-widget-tag')).toHaveText('Interactive');
    // The fallback is for screen readers while the widget is live.
    const desc = await ph.getAttribute('aria-describedby');
    await expect(content(page).locator(`#${desc}`)).toHaveText('Fallback text');
    await expect(ph.locator('p', { hasText: 'Fallback text' })).toHaveCSS('position', 'absolute');
    // The frame lies over the placeholder's content box (below the label).
    const fb = (await frames(page).first().boundingBox())!;
    const pb = (await ph.boundingBox())!;
    expect(Math.abs(fb.x - pb.x - 1)).toBeLessThan(2);
    expect(Math.abs(fb.y - (pb.y + 1 + 22))).toBeLessThan(2);
    expect(Math.abs(fb.width - (pb.width - 2))).toBeLessThan(2);
    // window.innerHeight inside is the panel's viewport, not the frame's own height.
    const inner = await (await frames(page).first().elementHandle())!.contentFrame().then((f) => f!.evaluate(() => innerHeight));
    expect(inner).toBe(await page.locator('.cx-scroll').evaluate((s) => s.clientHeight));
  });

  test('the JSON child wins over the props attribute; __proto__ in props reaches nothing', async ({ page }) => {
    const tag = `<explain-widget src="w/probe.tsx" props='{"name":"attr"}'><script type="application/json">{"name":"child","__proto__":{"start":7}}</script><p>fb</p></explain-widget>`;
    await openWith(page, explainerHtml(tag), builds, { active: 'ring' });
    await expect(out(widgetFrame(page))).toHaveText('child:0|ring|');
    expect((await posted(page)).some((m) => m.type === 'widgetLog' && m.message.includes('both a props attribute and a JSON'))).toBe(true);
  });

  test('a self-closing placeholder is read as an empty one, with a warning, and the section goes on', async ({ page }) => {
    await openWith(page, explainerHtml('<explain-widget src="w/probe.tsx" title="P"/>'), builds, { active: 'ring' });
    await expect(out(widgetFrame(page))).toContainText('w:0');
    await expect(content(page).locator('[data-explain-anchor="ring"] > p', { hasText: 'Prose below the widget.' })).toBeAttached();
    expect((await posted(page)).some((m) => m.type === 'widgetLog' && m.message.includes('self-closing'))).toBe(true);
  });

  test('without consent, untrusted or turned off: the fallback at its own height, and no frames', async ({ page }) => {
    await openWith(page, explainerHtml(probeTag()), builds, { gate: { ...ON, status: 'ask' } });
    await expect(placeholder(page)).toHaveAttribute('data-cx-wstate', 'off');
    await expect(placeholder(page).locator('p', { hasText: 'Fallback text' })).toBeVisible();
    await expect(frames(page)).toHaveCount(0);
    expect((await posted(page)).some((m) => m.type === 'widgetCompile' || m.type === 'widgetLibs')).toBe(false);
  });

  test('a compile error shows in the box with its place, and "Show fallback" shows the fallback', async ({ page }) => {
    const bad = await compile({ 'w/bad.tsx': 'import * as THREE from "three";\nexport default function A() { return <p>{String(THREE)}</p>; }\n' });
    await openWith(page, explainerHtml('<explain-widget src="w/bad.tsx"><p>The fallback</p></explain-widget>'), bad);
    const err = placeholder(page).locator('.cx-widget-error');
    await expect(err).toBeVisible();
    await expect(err).toContainText('Three.js');
    await expect(err.locator('code')).toHaveText('w/bad.tsx:1');
    await err.getByRole('button', { name: 'Show fallback' }).click();
    await expect(err).toBeHidden();
    expect((await posted(page)).some((m) => m.type === 'widgetLog' && m.level === 'error' && m.message.includes('Three.js'))).toBe(true);
  });
});

test.describe('reveal, goToStep and focus need the reader’s interaction with that widget', () => {
  test('a click on a widget button calls reveal: true', async ({ page }) => {
    await openProbe(page);
    await widgetFrame(page).getByTestId('reveal').click();
    await expect(out(widgetFrame(page))).toContainText('reveal:true');
    expect(await reveals(page)).toEqual([{ type: 'widgetReveal', anchor: 'ring' }]);
  });

  test('reveal after an await is refused, and logged for authors', async ({ page }) => {
    await openProbe(page);
    await widgetFrame(page).getByTestId('later').click();
    // Hold the pointer still: the activation window still runs, but focus may have left (pointer clicks give focus back).
    await expect(out(widgetFrame(page))).toContainText('later:false', { timeout: 5000 });
    expect(await reveals(page)).toEqual([]);
    expect((await posted(page)).some((m) => m.type === 'widgetLog' && m.message.includes('reveal() only works from a click'))).toBe(true);
  });

  test('focus moving straight from widget A to a button in widget B: B’s reveal works, A’s call meanwhile fails', async ({ page }) => {
    const html = explainerHtml(`${probeTag(` id="a" props='{"name":"a"}'`)}${probeTag(` id="b" props='{"name":"b"}'`)}`);
    await openWith(page, html, builds, { active: 'ring' });
    const a = widgetFrame(page, 0);
    const b = widgetFrame(page, 1);
    await expect(out(b)).toContainText('b:0');
    await a.getByTestId('inp').click(); // focus in A (a text field keeps it)
    await a.getByTestId('later').click();
    await b.getByTestId('reveal').click();
    await expect(out(b)).toContainText('reveal:true');
    await expect(out(a)).toContainText('later:false', { timeout: 5000 });
    expect(await reveals(page)).toHaveLength(1);
  });

  test('a widget that steals focus right after a click on a step button (pointer elsewhere) is refused, twice', async ({ page }) => {
    await openProbe(page);
    for (const step of ['Intro', 'Ring']) {
      await page.locator('.cx-step', { hasText: step }).click();
      await widgetEval(page, 0, 'steal');
      expect(await widgetEval<boolean>(page, 0, 'reveal')).toBe(false);
      await expect.poll(() => contentFocus(page)).toBe('explain-widget');
    }
    expect(await reveals(page)).toEqual([]);
    expect((await posted(page)).some((m) => m.type === 'widgetLog' && m.message.includes('took focus without a click'))).toBe(true);
  });

  test('pressing J, then moving to the widget that came up and clicking it, works at once', async ({ page }) => {
    await openProbe(page, { active: 'intro' });
    await page.locator('.cx-scroll').focus();
    await page.keyboard.press('j');
    await expect(page.locator('.cx-position')).toHaveText('Step 2 of 3');
    await page.waitForTimeout(1000); // the step's smooth scroll settles
    const to = await centre(widgetFrame(page), 'reveal');
    await page.mouse.move(to.x - 200, to.y + 150);
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await page.mouse.down();
    await page.mouse.up();
    await expect(out(widgetFrame(page))).toContainText('reveal:true');
  });

  test('clicking prose just below a widget, which then steals focus and calls reveal, is refused', async ({ page }) => {
    await openProbe(page);
    const ph = (await placeholder(page).boundingBox())!;
    await page.mouse.click(ph.x + 40, ph.y + ph.height + 10);
    await widgetEval(page, 0, 'steal');
    expect(await widgetEval<boolean>(page, 0, 'reveal')).toBe(false);
    await expect.poll(() => contentFocus(page)).toBe('explain-widget');
  });

  test('clicking prose under a widget that grows under the resting pointer, then steals focus, is refused', async ({ page }) => {
    await openProbe(page);
    const ph = (await placeholder(page).boundingBox())!;
    await page.mouse.click(ph.x + 40, ph.y + ph.height + 12);
    await widgetEval(page, 0, 'grow', 80);
    await expect.poll(async () => (await placeholder(page).boundingBox())!.height).toBeGreaterThan(ph.height + 60);
    await widgetEval(page, 0, 'steal');
    expect(await widgetEval<boolean>(page, 0, 'reveal')).toBe(false);
    await expect.poll(() => contentFocus(page)).toBe('explain-widget');
  });

  test('a fast pointer jump into a widget, and wheel-scrolling over it then clicking, both work', async ({ page }) => {
    await openProbe(page);
    const to = await centre(widgetFrame(page), 'reveal');
    await page.mouse.move(5, 5);
    await page.mouse.move(to.x, to.y); // one jump
    await page.mouse.down();
    await page.mouse.up();
    await expect(out(widgetFrame(page))).toContainText('reveal:true');
    await page.mouse.wheel(0, 40);
    await page.waitForTimeout(200);
    const at = await centre(widgetFrame(page), 'go');
    await page.mouse.click(at.x, at.y);
    await expect(out(widgetFrame(page))).toContainText('go:true');
    await expect(page.locator('.cx-position')).toHaveText('Step 3 of 3');
  });

  test('Enter on the placeholder, then Enter on a widget button that calls reveal: true; Enter keeps focus in the widget', async ({ page }) => {
    await openProbe(page);
    await placeholder(page).focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => contentFocus(page)).toBe('widget');
    await page.keyboard.press('Tab'); // inc
    await page.keyboard.press('Tab'); // reveal
    await page.keyboard.press('Enter');
    await expect(out(widgetFrame(page))).toContainText('reveal:true');
    expect(await contentFocus(page)).toBe('widget');
  });

  test('a click on a step button, then leaving past the widget through the panel edge: a focus() is theft', async ({ page }) => {
    await openProbe(page);
    await page.locator('.cx-step', { hasText: 'Tail' }).click();
    await page.waitForTimeout(300);
    const ph = (await placeholder(page).boundingBox())!;
    // Down the gutter beside the widget and out of the panel's right edge.
    await page.mouse.move(596, ph.y + ph.height / 2, { steps: 4 });
    await widgetEval(page, 0, 'steal');
    await clearPosted(page);
    await send(page, { type: 'focusQuery', id: 7 });
    await expect.poll(async () => (await posted(page)).find((m) => m.type === 'focusAnswer')).toEqual({ type: 'focusAnswer', id: 7, legit: false });
    await expect.poll(() => contentFocus(page)).toBe('explain-widget');
  });

  test('a touch tap on a widget button works', async ({ browser }) => {
    const ctx = await browser.newContext({ hasTouch: true, viewport: { width: 600, height: 900 } });
    const page = await ctx.newPage();
    await openProbe(page);
    const to = await centre(widgetFrame(page), 'reveal');
    await page.touchscreen.tap(to.x, to.y);
    await expect(out(widgetFrame(page))).toContainText('reveal:true');
    await ctx.close();
  });

  test('goToStep from a click changes the step; the extension is told to reveal it', async ({ page }) => {
    await openProbe(page);
    await clearPosted(page);
    await widgetFrame(page).getByTestId('go').click();
    await expect(out(widgetFrame(page))).toContainText('go:true');
    await expect(page.locator('.cx-position')).toHaveText('Step 3 of 3');
    expect(await posted(page)).toContainEqual({ type: 'focusAnchor', anchorId: 'tail', source: 'step' });
  });

  test('a focused widget answers the extension’s focus question as legitimate after a click in it', async ({ page }) => {
    await openProbe(page);
    await widgetFrame(page).getByTestId('inp').click();
    await send(page, { type: 'focusQuery', id: 3 });
    await expect.poll(async () => (await posted(page)).find((m) => m.type === 'focusAnswer')).toEqual({ type: 'focusAnswer', id: 3, legit: true });
  });
});

test.describe('highlight, steps, keys and focus exits', () => {
  test('highlight needs no click: cleared before the step reaches widgets, so a highlight in response sticks', async ({ page }) => {
    await openWith(page, explainerHtml(probeTag(` props='{"onStep":"highlight"}'`)), builds, { active: 'ring' });
    const hl = { type: 'widgetHighlight', anchor: 'ring', lines: [2, 3], identifiers: ['x'] };
    await expect.poll(async () => (await posted(page)).filter((m) => m.type === 'widgetHighlight')).toEqual([hl]);
    await clearPosted(page);
    // The editor's cursor moves into the nested anchor: same step, and the widget highlights again in response.
    await send(page, { type: 'syncTo', anchorId: 'inner' });
    await expect.poll(async () => (await posted(page)).filter((m) => m.type === 'widgetHighlight')).toEqual([{ type: 'widgetHighlight' }, hl]);
  });

  test('highlight of an anchor outside the current step is dropped (and logged once)', async ({ page }) => {
    await openProbe(page, { active: 'ring' });
    await clearPosted(page);
    await widgetEval(page, 0, 'highlight', [1, 2], 'inner');
    await widgetEval(page, 0, 'highlight', [1, 2], 'tail');
    await expect.poll(async () => (await posted(page)).filter((m) => m.type === 'widgetHighlight')).toEqual([{ type: 'widgetHighlight', anchor: 'inner', lines: [1, 2] }]);
    expect((await posted(page)).filter((m) => m.type === 'widgetLog' && m.message.includes('highlight() only works'))).toHaveLength(1);
  });

  test('highlight is limited to 10 a second, the latest call delivered', async ({ page }) => {
    await openProbe(page, { active: 'ring' });
    await clearPosted(page);
    for (let i = 1; i <= 25; i++) await widgetEval(page, 0, 'highlight', [i, i]);
    await page.waitForTimeout(1300);
    const hl = (await posted(page)).filter((m): m is Extract<FromWebview, { type: 'widgetHighlight' }> => m.type === 'widgetHighlight');
    expect(hl.length).toBeLessThanOrEqual(12);
    expect(hl.at(-1)!.lines).toEqual([25, 25]);
  });

  test('Escape leaves the widget to its placeholder; Tab past its end goes on in reading order', async ({ page }) => {
    await openWith(page, explainerHtml(probeTag(), { after: '<p><a href="#x" id="after">after</a></p>' }), builds, { active: 'ring' });
    await expect(out(widgetFrame(page))).toContainText('w:0');
    await widgetFrame(page).getByTestId('inp').click();
    await page.keyboard.press('Escape');
    await expect.poll(() => contentFocus(page)).toBe('explain-widget');
    await page.keyboard.press('Enter');
    await expect.poll(() => contentFocus(page)).toBe('widget');
    await widgetFrame(page).getByTestId('inp').focus();
    await page.keyboard.press('Tab');
    await expect.poll(() => contentFocus(page)).toBe('a');
  });

  test('the theme reaches widgets, and changes follow (dark: variants)', async ({ page }) => {
    await openProbe(page);
    const cls = (f: FrameLocator) => f.locator('html').getAttribute('class');
    await expect.poll(() => cls(widgetFrame(page))).toContain('dark');
    await page.evaluate(() => (document.body.className = 'vscode-light'));
    await expect.poll(() => cls(widgetFrame(page))).toContain('light');
  });
});

test.describe('placement', () => {
  test('inside a closed <details>: unmounted, no error; opening it mounts the widget', async ({ page }) => {
    await openWith(page, explainerHtml(`<details><summary>More</summary>${probeTag()}</details>`), builds);
    await page.waitForTimeout(300);
    await expect(frames(page)).toHaveCount(0);
    await expect(placeholder(page)).toHaveAttribute('data-cx-wstate', 'hidden');
    await content(page).locator('summary').click();
    await expect(out(widgetFrame(page))).toContainText('w:0');
  });

  test('a transformed ancestor isn’t supported: the box says so, Output names the ancestor and property', async ({ page }) => {
    await openWith(page, explainerHtml(`<div class="card" style="transform: rotate(1deg)">${probeTag()}</div>`), builds);
    await expect(placeholder(page).locator('.cx-widget-error')).toContainText("can't be shown here");
    await expect(frames(page)).toHaveCount(0);
    await expect.poll(async () => (await posted(page)).some((m) => m.type === 'widgetLog' && m.message.includes('`div.card`: transform'))).toBe(true);
  });

  test('a scrolling ancestor that overflows: "can’t be shown at this width"; at a width where it fits, it mounts', async ({ page }) => {
    const html = explainerHtml(`<div class="wide" style="overflow-x: auto"><div style="width: 700px">${probeTag()}</div></div>`);
    await openWith(page, html, builds);
    await expect(placeholder(page).locator('.cx-widget-error')).toContainText("can't be shown at this width");
    await expect.poll(async () => (await posted(page)).some((m) => m.type === 'widgetLog' && m.message.includes('`div.wide`: overflow-x: auto'))).toBe(true);
    await page.setViewportSize({ width: 900, height: 900 });
    await expect(out(widgetFrame(page))).toContainText('w:0');
  });

  test('a clipping ancestor clips the frame to its padding box', async ({ page }) => {
    await openWith(page, explainerHtml(`<div style="overflow: hidden; height: 80px">${probeTag()}</div>`), builds);
    await expect(out(widgetFrame(page))).toContainText('w:0');
    await expect.poll(() => frames(page).first().evaluate((f) => getComputedStyle(f).clipPath)).toMatch(/^inset\(0px 0px \d+px( 0px)?\)$/);
  });
});

test.describe('heights, state, caps', () => {
  test('the widget sizes its placeholder; growth above the reading line keeps the reader’s place', async ({ page }) => {
    await openWith(page, explainerHtml(probeTag(), { after: filler(60) }), builds, { active: 'ring' });
    await expect(out(widgetFrame(page))).toContainText('w:0');
    await expect.poll(async () => (await placeholder(page).boundingBox())!.height).toBeGreaterThan(100);
    const h0 = (await placeholder(page).boundingBox())!.height;
    await page.waitForTimeout(1600); // the opening scroll to the step (and its hold) is over
    // Scroll so the widget's top is above the reading line, the widget still on screen (off screen, frames don't lay out).
    const top = (await placeholder(page).boundingBox())!.y - (await page.locator('.cx-scroll').boundingBox())!.y;
    await page.locator('.cx-scroll').evaluate((s, t) => (s.scrollTop = t + 30), top);
    await page.waitForTimeout(300);
    const tail = () => content(page).locator('[data-explain-anchor="tail"] p').nth(10).boundingBox().then((b) => b!.y);
    const before = await tail();
    await widgetEval(page, 0, 'grow', 120);
    await expect.poll(async () => (await placeholder(page).boundingBox())!.height).toBeGreaterThan(h0 + 100);
    expect(Math.abs((await tail()) - before)).toBeLessThan(3);
    expect((await posted(page)).some((m) => m.type === 'focusAnchor')).toBe(false); // compensation never picks a step
  });

  test('height changes wait while a pointer is down in the panel', async ({ page }) => {
    await openProbe(page);
    const ph = (await placeholder(page).boundingBox())!;
    await page.mouse.move(ph.x + 40, ph.y - 30);
    await page.mouse.down();
    await widgetEval(page, 0, 'grow', 90);
    await page.waitForTimeout(400);
    expect(Math.abs((await placeholder(page).boundingBox())!.height - ph.height)).toBeLessThan(2);
    await page.mouse.up();
    await expect.poll(async () => (await placeholder(page).boundingBox())!.height).toBeGreaterThan(ph.height + 80);
  });

  test('state survives scrolling far away and back, a source edit, an HTML edit and a new page', async ({ page }) => {
    const html = explainerHtml(probeTag(' id="p"'), { after: filler(120) });
    await openWith(page, html, builds, { active: 'ring' });
    const f = widgetFrame(page);
    await f.getByTestId('inc').click();
    await f.getByTestId('inc').click();
    await expect(out(f)).toContainText('w:2');
    // Far away: unmounted (state asked first); back: mounted with it.
    await page.locator('.cx-scroll').evaluate((s) => (s.scrollTop = s.scrollHeight));
    await expect(frames(page)).toHaveCount(0);
    await page.locator('.cx-scroll').evaluate((s) => (s.scrollTop = 0));
    await expect(out(widgetFrame(page))).toContainText('w:2');
    // A source edit: a new build remounts the widget, with its state.
    const edited = await compile({ 'w/probe.tsx': PROBE.replace('{name}:{n}', '{name}!{n}') });
    await send(page, { type: 'widget', src: 'w/probe.tsx', build: edited['w/probe.tsx']! });
    await expect(out(widgetFrame(page))).toContainText('w!2');
    // An HTML edit that changes its props remounts it too, still with its state.
    await send(page, { type: 'content', title: 'Widgets', html: html.replace('id="p"', `id="p" props='{"name":"q"}'`) });
    await expect(out(widgetFrame(page))).toContainText('q!2');
    // The panel's saved state carries it (a hidden panel is rebuilt from it).
    await expect.poll(() => page.evaluate(() => JSON.stringify((window as unknown as { __state: { widgets?: unknown } }).__state.widgets ?? null))).toContain('{\\"n\\":2}');
  });

  test('an HTML edit elsewhere keeps the widget mounted (same frame)', async ({ page }) => {
    const html = explainerHtml(probeTag());
    await openProbe(page, { html });
    const id = await frames(page).first().evaluate((f) => ((f as unknown as { __mark: number }).__mark = 1));
    await send(page, { type: 'content', title: 'Widgets', html: html.replace('Prose above the widget.', 'Prose above, edited.') });
    await expect(content(page).getByText('Prose above, edited.')).toBeAttached();
    expect(await frames(page).first().evaluate((f) => (f as unknown as { __mark?: number }).__mark)).toBe(id);
  });

  test('at most 8 mounted; past 24 in an explainer, the rest say so', async ({ page }) => {
    const many = Array.from({ length: 26 }, (_, i) => probeTag(` id="w${i}" props='{"name":"n${i}"}'`, '')).join('');
    await openWith(page, explainerHtml(`<div style="display: grid; grid-template-columns: repeat(13, 1fr)">${many}</div>`), builds);
    await expect.poll(() => frames(page).count()).toBe(8);
    await page.waitForTimeout(500);
    expect(await frames(page).count()).toBe(8);
    await expect(placeholder(page, 25).locator('.cx-widget-error')).toContainText('more than 24 widgets');
  });
});

test.describe('the consent bar (panel chrome)', () => {
  test('asks, offers trust in Restricted Mode, and offers to confirm anchors; buttons only post requests', async ({ page }) => {
    await openWith(page, explainerHtml(probeTag()), builds, { gate: { ...ON, status: 'ask' } });
    const bar = page.locator('.cx-consent');
    await expect(bar).toContainText('This explainer has 1 interactive widget');
    await clearPosted(page);
    await bar.getByRole('button', { name: 'Run widgets…' }).click();
    expect(await posted(page)).toEqual([{ type: 'widgetConsent' }]);
    await send(page, { type: 'widgets', gate: { ...ON, status: 'untrusted' } });
    await bar.getByRole('button', { name: 'Trust workspace…' }).click();
    expect(await posted(page)).toContainEqual({ type: 'widgetTrust' });
    await send(page, { type: 'widgets', gate: { ...ON, unconfirmed: { anchors: 2, summary: 'src/a.ts, 12 lines' } } });
    await bar.getByRole('button', { name: /Let widgets read 2 anchors \(src\/a\.ts, 12 lines\)/ }).click();
    expect(await posted(page)).toContainEqual({ type: 'widgetConfirmAnchors' });
    // Granted: the widget mounts without reopening anything.
    await expect(out(widgetFrame(page))).toContainText('w:0');
    await send(page, { type: 'widgets', gate: ON });
    await expect(bar).toBeHidden();
  });

  test('the bar is outside the content: author CSS can’t hide it', async ({ page }) => {
    await openWith(page, `<style>.cx-consent, [class*=consent] { display: none !important }</style>${explainerHtml(probeTag())}`, builds, { gate: { ...ON, status: 'ask' } });
    await expect(page.locator('.cx-consent')).toBeVisible();
  });
});

test.describe('watchdogs', () => {
  test('heartbeats carry breadcrumbs; a widget that stops answering pings is reported once', async ({ page }) => {
    await openProbe(page);
    await expect.poll(async () => (await posted(page)).find((m) => m.type === 'heartbeat'), { timeout: 3000 }).toMatchObject({ type: 'heartbeat', visible: true, mounted: ['w/probe.tsx'] });
    // The widget stops answering (a hang that doesn't also freeze the panel, as with site isolation; when it
    // shares the panel's thread, the panel's own timers stop too and the extension's watchdog handles it).
    const handle = await frames(page).first().elementHandle();
    await (await handle!.contentFrame())!.evaluate(() => {
      const data = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data')!.get!;
      Object.defineProperty(MessageEvent.prototype, 'data', { get() { const d = data.call(this); return d?.type === 'ping' ? null : d; } });
    });
    await expect.poll(async () => (await posted(page)).filter((m) => m.type === 'widgetsUnresponsive').length, { timeout: 10_000 }).toBe(1);
    // The extension's answer: unmount everywhere.
    await send(page, { type: 'widgetsReset', phase: 'unmount' });
    await expect(frames(page)).toHaveCount(0);
  });
});

test.describe('review regressions', () => {
  test('a key pressed in the panel, then a click on the widget already under the pointer, works and isn’t a theft', async ({ page }) => {
    await openProbe(page);
    const ph = (await placeholder(page).boundingBox())!;
    const at = await centre(widgetFrame(page), 'reveal');
    // The pointer comes from the prose into the widget and rests there.
    await page.mouse.move(at.x, ph.y - 40);
    await page.mouse.move(at.x, at.y, { steps: 8 });
    await page.locator('.cx-scroll').focus();
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(300);
    const to = await centre(widgetFrame(page), 'reveal');
    await page.mouse.move(to.x, to.y, { steps: 3 });
    await page.mouse.down();
    await page.mouse.up();
    await expect(out(widgetFrame(page))).toContainText('reveal:true');
    expect((await posted(page)).some((m) => m.type === 'widgetLog' && m.message.includes('took focus'))).toBe(false);
  });

  test('a widget the pointer rests on only because it grew there is refused, but not stopped as a thief', async ({ page }) => {
    await openProbe(page);
    await page.waitForTimeout(1600); // the opening scroll (and its hold) is over
    // The widget holds the reading line, so its growth isn't compensated by scrolling: it grows downward.
    const view = (await page.locator('.cx-scroll').boundingBox())!;
    const top = (await placeholder(page).boundingBox())!.y;
    await page.locator('.cx-scroll').evaluate((s, d) => (s.scrollTop += d), top - (view.y + view.height * 0.3 - 20));
    await page.waitForTimeout(300);
    const ph = (await placeholder(page).boundingBox())!;
    for (let i = 0; i < 4; i++) {
      await page.mouse.click(ph.x + 40, ph.y + ph.height + 12 + i);
      await widgetEval(page, 0, 'grow', 80 + i);
      await page.waitForTimeout(250);
      await widgetEval(page, 0, 'steal');
      expect(await widgetEval<boolean>(page, 0, 'reveal')).toBe(false);
      await expect.poll(() => contentFocus(page)).toBe('explain-widget');
      await widgetEval(page, 0, 'grow', 0);
      await page.waitForTimeout(250);
    }
    await expect(placeholder(page)).toHaveAttribute('data-cx-wstate', 'live');
  });

  test('a mounted widget that is off screen gets no credit for pointer travel toward it', async ({ page }) => {
    const html = explainerHtml('<p>x</p>', { before: `<p>Before.</p>${filler(12)}${probeTag()}${filler(30)}` });
    await openWith(page, html, builds, { active: 'intro' });
    await expect(out(widgetFrame(page))).toContainText('w:0');
    const fb = (await frames(page).first().boundingBox())!;
    expect(fb.y).toBeGreaterThan(page.viewportSize()!.height);
    const p = (await content(page).locator('p', { hasText: 'Paragraph 1 ' }).first().boundingBox())!;
    await page.mouse.click(fb.x + 40, p.y + 5);
    await page.mouse.move(fb.x + 40, p.y + 25, { steps: 2 });
    await widgetEval(page, 0, 'steal');
    expect(await widgetEval<boolean>(page, 0, 'reveal')).toBe(false);
  });

  test('author CSS can’t shrink the placeholder under the frame or hide the label', async ({ page }) => {
    const css = '<style>#w.x{height:0 !important;padding:0 !important;border:0 !important;margin:0 !important} #w.x > .cx-widget-bar{display:none !important} #w.x .cx-widget-tag{visibility:hidden !important}</style>';
    await openWith(page, css + explainerHtml(probeTag(' id="w" class="x"')), builds, { active: 'ring' });
    await expect(out(widgetFrame(page))).toContainText('w:0');
    await widgetEval(page, 0, 'grow', 400);
    await page.waitForTimeout(600);
    const fb = (await frames(page).first().boundingBox())!;
    const pb = (await placeholder(page).boundingBox())!;
    expect(pb.height).toBeGreaterThan(400);
    expect(fb.y + fb.height).toBeLessThanOrEqual(pb.y + pb.height + 1);
    await expect(page.locator('.cx-widget-label')).toBeVisible();
  });

  test('the "Interactive" label over a running widget is panel chrome: author CSS (custom properties, text-indent, width) can’t hide it', async ({ page }) => {
    const css = '<style>#w .cx-widget-tag{--vscode-badge-foreground:transparent !important;--vscode-badge-background:transparent !important;width:0 !important;overflow:hidden !important;padding:0 !important;text-indent:-999px !important} #w .cx-widget-name,#w .cx-widget-note{color:transparent !important} :root{--vscode-badge-foreground:transparent !important}</style>';
    await openWith(page, css + explainerHtml(probeTag(' id="w"')), builds, { active: 'ring' });
    await expect(out(widgetFrame(page))).toContainText('w:0');
    const tag = page.locator('.cx-widget-label .cx-widget-label-tag');
    await expect(tag).toHaveText('Interactive');
    await expect(tag).toBeVisible();
    const info = await tag.evaluate((e) => { const cs = getComputedStyle(e); const r = e.getBoundingClientRect(); return { color: cs.color, w: r.width, indent: cs.textIndent }; });
    expect(info.color).not.toBe('rgba(0, 0, 0, 0)');
    expect(info.w).toBeGreaterThan(40);
    expect(info.indent).toBe('0px');
    // It sits on the placeholder's bar, just above the frame.
    const lb = (await page.locator('.cx-widget-label').boundingBox())!;
    const fb = (await frames(page).first().boundingBox())!;
    expect(Math.abs(lb.y + lb.height - fb.y)).toBeLessThan(2);
    expect(Math.abs(lb.x - fb.x)).toBeLessThan(2);
  });

  test('a widget growing while it holds the reading line stays where the reader is using it', async ({ page }) => {
    const grower = await compile({ 'w/g.tsx': `import { useState } from 'react';
export default function G() { const [rows, setRows] = useState(1); return <div><button data-testid="add" onClick={() => setRows(rows + 3)}>add</button>{Array.from({ length: rows }, (_, i) => <p key={i} style={{ height: 30, margin: 0 }}>row {i}</p>)}</div>; }` });
    await openWith(page, explainerHtml('<explain-widget id="g" src="w/g.tsx" title="G" height="300"></explain-widget>', { before: filler(10) }), grower, { active: 'ring' });
    const f = widgetFrame(page);
    await expect(f.getByTestId('add')).toBeVisible();
    await page.waitForTimeout(1600); // the opening scroll (and its hold) is over
    // The reading line (30% down the panel) runs through the widget.
    const view = (await page.locator('.cx-scroll').boundingBox())!;
    const line = view.y + view.height * 0.3;
    const top = (await placeholder(page).boundingBox())!.y;
    await page.locator('.cx-scroll').evaluate((s, d) => (s.scrollTop += d), top - (line - 60));
    await page.waitForTimeout(300);
    const ph = (await placeholder(page).boundingBox())!;
    expect(ph.y < line && ph.y + ph.height > line).toBe(true);
    const b1 = (await f.getByTestId('add').boundingBox())!;
    for (let i = 0; i < 4; i++) {
      await f.getByTestId('add').click();
      await page.waitForTimeout(200);
    }
    await page.waitForTimeout(500);
    expect(Math.abs((await f.getByTestId('add').boundingBox())!.y - b1.y)).toBeLessThan(2);
  });

  test('fixing a broken src (placeholder with an id) in the HTML runs the widget', async ({ page }) => {
    const bad = await compile({ 'w/bad.tsx': 'export default function B() { return <div>; }' });
    await openWith(page, explainerHtml('<explain-widget id="x" src="w/bad.tsx" title="P"></explain-widget>'), { ...builds, ...bad }, { active: 'ring' });
    await expect(placeholder(page)).toHaveAttribute('data-cx-wstate', 'error');
    await send(page, { type: 'content', title: 'Widgets', html: explainerHtml('<explain-widget id="x" src="w/probe.tsx" title="P"></explain-widget>') });
    await expect(out(widgetFrame(page))).toContainText('w:0');
    await expect(placeholder(page)).toHaveAttribute('data-cx-wstate', 'live');
  });

  test('state set just before diving into another explainer is kept for coming back; heights aren’t filed under the new one', async ({ page }) => {
    const html = explainerHtml(probeTag(' id="x"'));
    await openWith(page, html, builds, { active: 'ring' });
    const f = widgetFrame(page);
    for (let i = 0; i < 3; i++) await f.getByTestId('inc').click();
    await expect(out(f)).toContainText('w:3');
    await widgetEval(page, 0, 'grow', 60);
    await page.waitForTimeout(150);
    await clearPosted(page);
    const base = await page.evaluate(() => `${location.origin}/fixtures/sample-workspace/.explain/bit-reader/`);
    const anchors = [{ id: 'intro', file: 'src/a.ts', range: { start: 1, end: 10 }, state: 'exact' as const }, { id: 'ring', file: 'src/a.ts', range: { start: 11, end: 30 }, state: 'exact' as const }, { id: 'tail', file: 'src/a.ts', range: { start: 31, end: 40 }, state: 'exact' as const }];
    await send(page, { type: 'init', title: 'Other', html: '<section data-explain-anchor="intro"><h2>Other</h2></section>', anchors, active: 'intro', dir: 'file:///ws/.explain/other', base, trail: [{ name: 'w', title: 'Widgets' }, { name: 'other', title: 'Other' }] });
    await page.waitForTimeout(1500);
    expect((await posted(page)).filter((m) => m.type === 'widgetHeights')).toEqual([]);
    await send(page, { type: 'init', title: 'Widgets', html, anchors, active: 'ring', dir: 'file:///ws/.explain/w', base, trail: [{ name: 'w', title: 'Widgets' }] });
    await send(page, { type: 'widgets', gate: ON });
    await expect(out(widgetFrame(page))).toContainText('w:3');
  });

  test('resizing the panel sends widgets no theme messages; a theme change sends one', async ({ page }) => {
    await openProbe(page);
    const f = (await (await frames(page).first().elementHandle())!.contentFrame())!;
    await f.evaluate(() => {
      (window as any).__themes = 0;
      addEventListener('message', (e) => { if (e.data?.type === 'theme') (window as any).__themes++; });
    });
    for (let w = 600; w < 760; w += 20) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.waitForTimeout(30);
    }
    await page.waitForTimeout(200);
    expect(await f.evaluate(() => (window as any).__themes)).toBe(0);
    await page.evaluate(() => document.documentElement.style.setProperty('--vscode-foreground', '#123456'));
    await expect.poll(() => f.evaluate(() => (window as any).__themes)).toBe(1);
  });

  test('VS Code’s reduce-motion setting (a body class) reaches widgets, and follows changes', async ({ page }) => {
    const rm = await compile({ 'w/rm.tsx': `import { useReducedMotion } from 'explainer';
export default function R() { return <p data-testid="rm">{String(useReducedMotion())}</p>; }` });
    await openWith(page, explainerHtml('<explain-widget src="w/rm.tsx"></explain-widget>'), rm, { active: 'ring' });
    await expect(widgetFrame(page).getByTestId('rm')).toHaveText('false');
    await page.evaluate(() => document.body.classList.add('vscode-reduce-motion'));
    await expect(widgetFrame(page).getByTestId('rm')).toHaveText('true');
  });

  test('a panel paused for seconds (sleep, debugger) doesn’t report its widgets as unresponsive', async ({ page }) => {
    await openProbe(page);
    await page.waitForTimeout(1500);
    await clearPosted(page);
    await page.evaluate(() => { const end = performance.now() + 4500; while (performance.now() < end) { /* paused */ } });
    await page.waitForTimeout(2000);
    expect((await posted(page)).filter((m) => m.type === 'widgetsUnresponsive')).toEqual([]);
  });

  test('a refusal sent before the extension saw a new widget is asked again when the gate comes', async ({ page }) => {
    await openWith(page, explainerHtml(probeTag()), { 'w/probe.tsx': null }, { active: 'ring' });
    await expect(placeholder(page)).toHaveAttribute('data-cx-wstate', 'off');
    await serve(page, builds);
    await send(page, { type: 'widgets', gate: ON });
    await expect(out(widgetFrame(page))).toContainText('w:0');
  });

  test('a watchdog suspension ends with a new gate or another explainer; a stopped explainer says why', async ({ page }) => {
    await openProbe(page);
    await send(page, { type: 'widgetsReset', phase: 'unmount' });
    await expect(frames(page)).toHaveCount(0);
    // The extension's new gate (nothing turned off) ends it, even without a remount message.
    await send(page, { type: 'widgets', gate: { ...ON, stopped: true, disabled: ['w/probe.tsx'] } });
    await expect(placeholder(page).locator('.cx-widget-error')).toContainText('kept freezing the panel, so they were stopped');
    await send(page, { type: 'widgets', gate: ON });
    await expect(out(widgetFrame(page))).toContainText('w:0');
    // Suspended, then another explainer is shown: its widgets mount.
    await send(page, { type: 'widgetsReset', phase: 'unmount' });
    await expect(frames(page)).toHaveCount(0);
    const base = await page.evaluate(() => `${location.origin}/fixtures/sample-workspace/.explain/bit-reader/`);
    await send(page, { type: 'init', title: 'Other', html: explainerHtml(probeTag()), anchors: [{ id: 'intro', file: 'src/a.ts', range: { start: 1, end: 10 }, state: 'exact' }, { id: 'ring', file: 'src/a.ts', range: { start: 11, end: 30 }, state: 'exact' }, { id: 'tail', file: 'src/a.ts', range: { start: 31, end: 40 }, state: 'exact' }], active: 'ring', dir: 'file:///ws/.explain/other', base, trail: [{ name: 'other', title: 'Other' }] });
    await send(page, { type: 'widgets', gate: ON });
    await expect(out(widgetFrame(page))).toContainText('w:0');
  });

  test('"Show fallback" on a broken widget shows the whole fallback, not clipped at the widget’s height', async ({ page }) => {
    const bad = await compile({ 'w/bad.tsx': 'export default function B() { return <div>; }' });
    await openWith(page, explainerHtml(`<explain-widget id="b" src="w/bad.tsx" title="B" height="120"><div>${filler(8)}</div></explain-widget>`), { ...builds, ...bad }, { active: 'ring' });
    await expect(placeholder(page)).toHaveAttribute('data-cx-wstate', 'error');
    await placeholder(page).locator('.cx-widget-fallback').click();
    await expect.poll(() => placeholder(page).evaluate((e) => e.scrollHeight - e.clientHeight)).toBeLessThanOrEqual(1);
    expect(await placeholder(page).evaluate((e) => e.clientHeight)).toBeGreaterThan(200);
  });

  test('heartbeats go on while the page is hidden (visible: false), and one is sent at once on the change', async ({ page }) => {
    await openProbe(page);
    await expect.poll(async () => (await posted(page)).some((m) => m.type === 'heartbeat')).toBe(true);
    await clearPosted(page);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(async () => (await posted(page)).filter((m) => m.type === 'heartbeat').length, { timeout: 200 }).toBeGreaterThan(0);
    await page.waitForTimeout(2200);
    const beats = (await posted(page)).filter((m) => m.type === 'heartbeat');
    expect(beats.length).toBeGreaterThanOrEqual(3);
    expect(beats.every((b) => b.type === 'heartbeat' && !b.visible)).toBe(true);
  });

  test('a highlight waiting in the rate limit is dropped when the step changes', async ({ page }) => {
    await openProbe(page, { active: 'ring' });
    for (let i = 1; i <= 12; i++) await widgetEval(page, 0, 'highlight', [i, i]);
    await clearPosted(page);
    // The cursor moves into the nested anchor: a step change within the same section, where the old call
    // would still pass the highlight check.
    await send(page, { type: 'syncTo', anchorId: 'inner' });
    await page.waitForTimeout(1300);
    expect((await posted(page)).filter((m) => m.type === 'widgetHighlight' && 'anchor' in m && m.anchor)).toEqual([]);
  });
});

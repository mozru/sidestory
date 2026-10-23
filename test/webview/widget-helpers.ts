// Helpers for the panel's widget tests: the harness plays the extension (compiled widgets, library texts,
// anchor code); widgets are compiled here, in the test process, by the real compiler (src/extension/widgets).
import { expect, type FrameLocator, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WidgetCompilerCore } from '../../src/extension/widgets/compile-core.ts';
import type { FromWebview, ToWebview, WidgetBuild, WidgetGate } from '../../src/shared/protocol.ts';
import type { WidgetCode } from '../../src/shared/widget-protocol.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let core: WidgetCompilerCore | undefined;

/** Compiles widget files (path → source) with the real compiler; returns builds by entry path. */
export async function compile(files: Record<string, string>, entries: string[] = Object.keys(files).filter((f) => /\.(t|j)sx?$/.test(f))): Promise<Record<string, WidgetBuild>> {
  const dir = mkdtempSync(join(tmpdir(), 'cx-panel-widget-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  core ??= new WidgetCompilerCore({ dataDir: join(root, 'dist', 'widget-data') });
  const out: Record<string, WidgetBuild> = {};
  for (const e of entries) {
    const r = await core.compile(dir, e);
    out[e] = { entry: r.entry, modules: r.modules, libraries: r.libraries, icons: r.icons, errors: r.errors, hash: r.hash };
  }
  return out;
}

export const ON: WidgetGate = { status: 'on', unconfirmed: null, disabled: [], heights: {} };

export const send = (page: Page, m: ToWebview) => page.evaluate((msg) => (window as unknown as { __send(m: unknown): void }).__send(msg), m);
export const posted = (page: Page) => page.evaluate(() => (window as unknown as { __posted: FromWebview[] }).__posted);
export const clearPosted = (page: Page) => page.evaluate(() => ((window as unknown as { __posted: FromWebview[] }).__posted = []));
export const content = (page: Page) => page.frameLocator('iframe.cx-content-frame');

/** Answers the panel's compile and code requests with these. */
export async function serve(page: Page, builds: Record<string, WidgetBuild | null>, codes: Record<string, WidgetCode> = {}): Promise<void> {
  await page.evaluate(([b, c]) => {
    const w = window as unknown as { __builds: unknown; __codes: unknown };
    w.__builds = b;
    w.__codes = c;
  }, [builds, codes] as const);
}

const ANCHORS = [
  { id: 'intro', file: 'src/a.ts', range: { start: 1, end: 10 }, state: 'exact' as const },
  { id: 'ring', file: 'src/a.ts', range: { start: 11, end: 30 }, state: 'exact' as const },
  { id: 'inner', file: 'src/a.ts', range: { start: 12, end: 14 }, state: 'exact' as const },
  { id: 'tail', file: 'src/a.ts', range: { start: 31, end: 40 }, state: 'exact' as const },
];

export const filler = (n: number) => Array.from({ length: n }, (_, i) => `<p>Paragraph ${i} of filler text so the page scrolls, long enough to wrap onto a second line in the panel.</p>`).join('');

/** An explainer with a widget in section "ring" (plus `extra` HTML in that section). */
export function explainerHtml(widget: string, opts: { before?: string; after?: string } = {}): string {
  return `<section data-explain-anchor="intro"><h2>Intro</h2>${opts.before ?? '<p>Before the widget.</p>'}</section>
<section data-explain-anchor="ring"><h2>Ring</h2><p>Prose above the widget.</p>${widget}<p>Prose below the widget.</p><div data-explain-anchor="inner"><p>Inner anchor.</p></div></section>
<section data-explain-anchor="tail"><h2>Tail</h2>${opts.after ?? filler(30)}</section>`;
}

/** Opens the harness with this explainer HTML and widgets switched on. */
export async function openWith(page: Page, html: string, builds: Record<string, WidgetBuild | null>, opts: { gate?: WidgetGate; codes?: Record<string, WidgetCode>; active?: string } = {}): Promise<void> {
  await page.goto('/test/webview/harness.html');
  await expect.poll(() => posted(page)).toContainEqual({ type: 'ready' });
  await serve(page, builds, opts.codes);
  const base = await page.evaluate(() => `${location.origin}/fixtures/sample-workspace/.sidestory/bit-reader/`);
  await send(page, { type: 'init', title: 'Widgets', html, anchors: ANCHORS, active: opts.active, dir: 'file:///ws/.sidestory/w', base, trail: [{ name: 'w', title: 'Widgets' }] });
  await expect(page.locator('.cx-title')).toHaveText('Widgets');
  await send(page, { type: 'widgets', gate: opts.gate ?? ON });
  // Opening at a section scrolls there smoothly: let it settle before anything measures positions.
  if (opts.active) await expect.poll(() => page.locator('.cx-scroll').evaluate((s) => new Promise<number>((r) => { const a = s.scrollTop; setTimeout(() => r(s.scrollTop - a), 150); }))).toBe(0);
}

/** The widget frame for a placeholder (by its key), as the panel laid it out. */
export function widgetFrame(page: Page, n = 0): FrameLocator {
  return page.frameLocator('iframe.cx-widget-frame').nth(n);
}

export const frames = (page: Page) => page.locator('iframe.cx-widget-frame');

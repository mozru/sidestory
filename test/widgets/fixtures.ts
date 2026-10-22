// Test fixtures for widget frames: serves test/widgets/harness.html (with the panel-equivalent CSP and the
// real bootstrap) and dist/widget-libs/* through page.route, so no server is needed.
import { test as base, expect, type Frame, type FrameLocator, type Page } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WIDGET_BOOTSTRAP } from '../../src/shared/widget-bootstrap.ts';
import { WIDGET_LIBRARIES } from '../../src/shared/widget-imports.ts';
import type { ToWidget } from '../../src/shared/widget-protocol.ts';
import { THEMES, type ThemeName } from '../webview/themes.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
export const ORIGIN = 'http://127.0.0.1:4293';
export const BOOTSTRAP_HASH = `sha256-${createHash('sha256').update(WIDGET_BOOTSTRAP, 'utf8').digest('base64')}`;
/** docs/WIDGETS-PLAN.md §5.4. */
export const WIDGET_CSP = `default-src 'none'; script-src '${BOOTSTRAP_HASH}' 'strict-dynamic'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; require-trusted-types-for 'script'; trusted-types default`;

/** Library ids for a widget using `ids`, with their deps, in load order; Tailwind and the runtime always. */
export function libsFor(ids: string[]): string[] {
  const want = new Set<string>();
  const add = (id: string) => {
    if (want.has(id)) return;
    want.add(id);
    for (const d of WIDGET_LIBRARIES.find((l) => l.id === id)!.deps) add(d);
  };
  for (const id of [...ids, 'tailwind', 'runtime']) add(id);
  return WIDGET_LIBRARIES.map((l) => l.id).filter((id) => want.has(id));
}

export type Init = Omit<Extract<ToWidget, { type: 'init' }>, 'type'>;

export function theme(name: ThemeName): Init['theme'] {
  const t = THEMES[name];
  return {
    kind: name === 'hc' ? 'high-contrast' : name,
    bodyClass: t.bodyClass,
    vars: Object.fromEntries(Object.entries(t.vars).map(([k, v]) => [`--vscode-${k}`, v])),
  };
}

export function init(entry: string, modules: Record<string, string>, extra: Partial<Init> = {}): Init {
  return {
    props: {}, state: null, theme: theme('dark'), viewportHeight: 900, activeStep: 'refill', myAnchor: 'refill', icons: {},
    anchors: [
      { id: 'interface', title: 'Interface', step: 0, file: 'src/fifo.sv', range: { start: 1, end: 10 }, state: 'ok' },
      { id: 'refill', title: 'Refill', step: 1, file: 'src/fifo.sv', range: { start: 11, end: 20 }, state: 'ok' },
      { id: 'drain', title: 'Drain', step: 2, file: 'src/fifo.sv', range: { start: 21, end: 30 }, state: 'ok' },
    ],
    reducedMotion: false, entry, modules, ...extra,
  };
}

export interface MountOptions { libs: string[]; init: Init; height?: number; fixedHeight?: boolean; resultOk?: boolean | null; codes?: Record<string, unknown> | null }

export class Harness {
  readonly page: Page;
  constructor(page: Page) { this.page = page; }
  async open() {
    const nonce = randomBytes(16).toString('base64url');
    const html = readFileSync(join(here, 'harness.html'), 'utf8')
      .replaceAll('%NONCE%', nonce)
      .replaceAll('%BOOTSTRAP_HASH%', BOOTSTRAP_HASH)
      .replaceAll('%BOOTSTRAP%', () => JSON.stringify(WIDGET_BOOTSTRAP))
      .replaceAll('%WIDGET_CSP%', () => JSON.stringify(WIDGET_CSP));
    await this.page.route(`${ORIGIN}/**`, (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/harness.html') return route.fulfill({ contentType: 'text/html', body: html });
      const lib = /^\/libs\/([a-z0-9-]+)\.js$/.exec(path);
      if (lib) return route.fulfill({ contentType: 'text/javascript', body: readFileSync(join(root, 'dist', 'widget-libs', `${lib[1]}.js`)) });
      return route.fulfill({ status: 404 });
    });
    await this.page.goto(`${ORIGIN}/harness.html`);
  }
  async mount(o: MountOptions): Promise<number> {
    return this.page.evaluate((o) => (window as any).cx.mount(o), { resultOk: true, ...o });
  }
  frame(id: number): FrameLocator { return this.page.frameLocator(`#w${id}`); }
  async frameHandle(id: number): Promise<Frame> {
    const el = await this.page.waitForSelector(`#w${id}`, { state: 'attached' });
    const f = await el.contentFrame();
    if (!f) throw new Error('no frame');
    return f;
  }
  send(id: number, msg: unknown) { return this.page.evaluate(([id, msg]) => (window as any).cx.send(id, msg), [id, msg] as const); }
  messages(id: number, type?: string): Promise<any[]> { return this.page.evaluate(([id, type]) => (window as any).cx.messages(id, type), [id, type] as const); }
  async waitFor(id: number, type: string, pred: (m: any) => boolean = () => true, timeout = 5000): Promise<any> {
    let found: any;
    await expect.poll(async () => { found = (await this.messages(id, type)).find(pred); return !!found; }, { timeout, message: `waiting for '${type}' from widget ${id}` }).toBe(true);
    return found;
  }
  timing(id: number): Promise<{ boot: number; ready: number; firstHeight: number }> { return this.page.evaluate((id) => (window as any).cx.timing(id), id); }
}

export const test = base.extend<{ harness: Harness }>({
  harness: async ({ page }, use) => {
    const h = new Harness(page);
    await h.open();
    await use(h);
  },
});
export { expect };

/** CommonJS as the compiler emits it (Sucrase, imports → require, JSX automatic runtime). */
export const cjs = (body: string) => `"use strict";Object.defineProperty(exports, "__esModule", {value: true});
var _jsxruntime = require("react/jsx-runtime");
${body}`;

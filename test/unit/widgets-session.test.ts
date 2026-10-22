// The extension enforces the widget gate itself (docs/WIDGETS-PLAN.md §5.1): compile, library and code
// requests from a panel are refused without trust, the setting and the reader's consent, whatever the panel
// (which renders untrusted content) asks for. Runs a real session over the sample workspace, with the real
// compiler worker (run from its TypeScript source).
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ToWebview } from '../../src/shared/protocol.ts';
import { counts, EventEmitter, events, modal, Uri, workspace } from './vscode-stub.ts';

vi.mock('vscode', () => import('./vscode-stub.ts'));

const { ExplainerSession } = await import('../../src/extension/session.ts');
const { refFromDir } = await import('../../src/extension/explainers.ts');
const { WidgetHost } = await import('../../src/extension/widgets/host.ts');
const { configureWidgetCompiler, disposeWidgetCompiler } = await import('../../src/extension/widgets/compile.ts');

let root = '';
let extDir = '';
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cx-widgets-')));
  cpSync('fixtures/sample-workspace', root, { recursive: true });
  workspace.root = Uri.file(root);
  // From the sources, not dist/ (which may be missing or stale): the worker runs as TypeScript, and the
  // compiler's data is generated (in a child process, faster outside vitest's module runner).
  const dataDir = join(root, '.cx-widget-data');
  execFileSync(process.execPath, [resolve('scripts/widget-data.ts'), dataDir]);
  configureWidgetCompiler({ workerFile: resolve('src/extension/widgets/compile-worker.ts'), dataDir });
  // The extension's own folder, with a stand-in for a built library.
  extDir = join(root, '.cx-ext');
  mkdirSync(join(extDir, 'dist', 'widget-libs'), { recursive: true });
  writeFileSync(join(extDir, 'dist', 'widget-libs', 'react.js'), '/* react */');
}, 60_000);
afterAll(() => disposeWidgetCompiler());

const state = new Map<string, unknown>();
const memento = { get: <T>(k: string, d: T) => (state.has(k) ? (state.get(k) as T) : d), update: async (k: string, v: unknown) => void (v === undefined ? state.delete(k) : state.set(k, v)) };
const closers: (() => void)[] = [];

function newHost() {
  return new WidgetHost({ workspaceState: memento, extensionUri: Uri.file(extDir) } as never);
}

function open(opts: { host?: InstanceType<typeof WidgetHost>; onPost?: (m: ToWebview) => void } = {}) {
  const host = opts.host ?? newHost();
  const ref = refFromDir(Uri.file(`${root}/.explain/retry-backoff`) as never)!;
  const posted: ToWebview[] = [];
  const messages = new EventEmitter<unknown>();
  const disposed = new EventEmitter<void>();
  const viewState = new EventEmitter<void>();
  const panel = {
    visible: true, title: '', viewColumn: 2,
    webview: { html: '', cspSource: 'test:', asWebviewUri: (u: Uri) => u, onDidReceiveMessage: messages.event, postMessage: async (m: ToWebview) => { posted.push(m); opts.onPost?.(m); return true; } },
    onDidDispose: disposed.event, onDidChangeViewState: viewState.event, dispose: () => disposed.fire(),
  };
  const decorations = { set() {}, setWidget() {}, isDimmed: () => false, refresh() {}, flash() {} };
  const session = new ExplainerSession([ref], panel as never, Uri.file('/ext') as never, decorations as never, { memento: memento as never, reanchor() {}, widgets: host });
  closers.push(() => {
    panel.dispose();
    if (!opts.host) host.dispose();
  });
  const send = (m: unknown) => messages.fire(m);
  const last = <T extends ToWebview['type']>(type: T) => posted.filter((m) => m.type === type).at(-1) as Extract<ToWebview, { type: T }> | undefined;
  return { session, posted, send, last };
}

afterEach(async () => {
  for (const c of closers.splice(0)) c();
  state.clear();
  modal.answer = undefined;
  modal.asked = [];
  workspace.isTrusted = true;
  await new Promise((r) => setTimeout(r, 200));
  expect(Object.values(events).reduce((n, e) => n + e.listeners.size, 0)).toBe(0);
  expect(counts.watchers).toBe(0);
});

/** Waits until the last `widgets` message has this status. */
async function gate(p: ReturnType<typeof open>, status: string) {
  await vi.waitFor(() => expect(p.last('widgets')?.gate.status).toBe(status), { timeout: 10_000 });
}

describe('the widget gate, enforced in the extension', () => {
  it('in Restricted Mode: "untrusted", and compile, library and code requests are refused', async () => {
    workspace.isTrusted = false;
    const p = open();
    await p.session.load();
    p.send({ type: 'ready' });
    await gate(p, 'untrusted');
    p.send({ type: 'widgetCompile', src: 'widgets/backoff.tsx' });
    p.send({ type: 'widgetLibs', ids: ['react', 'runtime'] });
    p.send({ type: 'widgetCode', src: 'widgets/backoff.tsx', anchor: 'delay' });
    await new Promise((r) => setTimeout(r, 300));
    expect(p.last('widget')).toEqual({ type: 'widget', src: 'widgets/backoff.tsx', build: null });
    expect(p.last('widgetLibs')).toBeUndefined();
    expect(p.last('widgetCode')).toBeUndefined();
  });

  it('trusted, before consent: "ask", refused; the modal’s answer (not the panel) grants consent; then served', async () => {
    const p = open();
    await p.session.load();
    p.send({ type: 'ready' });
    await gate(p, 'ask');
    p.send({ type: 'widgetCompile', src: 'widgets/backoff.tsx' });
    await vi.waitFor(() => expect(p.last('widget')).toEqual({ type: 'widget', src: 'widgets/backoff.tsx', build: null }));
    // Declined: still asking.
    p.send({ type: 'widgetConsent' });
    await vi.waitFor(() => expect(modal.asked).toHaveLength(1));
    expect(modal.asked[0]).toContain('may be able to reach the network');
    await new Promise((r) => setTimeout(r, 200));
    expect(p.last('widgets')?.gate.status).toBe('ask');
    // Agreed.
    modal.answer = 'Run Widgets';
    p.send({ type: 'widgetConsent' });
    await gate(p, 'on');
    p.send({ type: 'widgetCompile', src: 'widgets/backoff.tsx' });
    await vi.waitFor(() => expect(p.last('widget')?.build?.entry).toBe('widgets/backoff.tsx'));
    expect(p.last('widget')!.build!.errors).toEqual([]);
    p.send({ type: 'widgetLibs', ids: ['react', 'nope'] });
    await vi.waitFor(() => expect(Object.keys(p.last('widgetLibs')?.libs ?? {})).toEqual(['react']));
    // A source that isn't one of the explainer's widgets is never compiled for the panel.
    p.send({ type: 'widgetCompile', src: 'widgets/other.tsx' });
    await vi.waitFor(() => expect(p.last('widget')).toEqual({ type: 'widget', src: 'widgets/other.tsx', build: null }));
  });

  it('code: an unconfirmed quote is refused until the reader confirms it in the modal', async () => {
    modal.answer = 'Run Widgets';
    const p = open();
    await p.session.load();
    p.send({ type: 'ready' });
    await gate(p, 'ask');
    p.send({ type: 'widgetConsent' });
    await gate(p, 'on');
    await vi.waitFor(() => expect(p.last('widgets')?.gate.unconfirmed).toEqual({ anchors: 1, summary: 'src/retry.ts, 5 lines' }));
    p.send({ type: 'widgetCode', src: 'widgets/backoff.tsx', anchor: 'delay' });
    await vi.waitFor(() => expect(p.last('widgetCode')?.code).toEqual({ anchor: 'delay', status: 'unavailable', reason: 'unconfirmed' }));
    modal.answer = 'Let Widgets Read';
    p.send({ type: 'widgetConfirmAnchors' });
    await vi.waitFor(() => expect(p.last('widgetCode')?.code).toMatchObject({ anchor: 'delay', status: 'ok', startLine: 14, language: 'typescript' }));
    expect(p.last('widgetCode')!.code.text).toContain('const ceiling = Math.min(opts.maxMs, opts.baseMs * 2 ** attempt);');
    expect(p.last('widgets')?.gate.unconfirmed).toBeNull();
  });

  it('the watchdog’s disabled widgets are refused until their code changes', async () => {
    modal.answer = 'Run Widgets';
    const p = open();
    await p.session.load();
    p.send({ type: 'ready' });
    await gate(p, 'ask');
    p.send({ type: 'widgetConsent' });
    await gate(p, 'on');
    p.send({ type: 'widgetsUnresponsive', mounted: ['widgets/backoff.tsx'], mounting: 'widgets/backoff.tsx', recent: null });
    await vi.waitFor(() => expect(p.posted).toContainEqual({ type: 'widgetsReset', phase: 'unmount' }));
    await vi.waitFor(() => expect(p.last('widgets')?.gate.disabled).toEqual(['widgets/backoff.tsx']), { timeout: 5000 });
    p.send({ type: 'widgetCompile', src: 'widgets/backoff.tsx' });
    await vi.waitFor(() => expect(p.last('widget')).toEqual({ type: 'widget', src: 'widgets/backoff.tsx', build: null }));
  });
});

describe('review regressions (extension side)', () => {
  async function consented(o: Parameters<typeof open>[0] = {}) {
    modal.answer = 'Run Widgets';
    const p = open(o);
    await p.session.load();
    p.send({ type: 'ready' });
    await vi.waitFor(() => expect(['ask', 'on']).toContain(p.last('widgets')?.gate.status), { timeout: 10_000 });
    if (p.last('widgets')?.gate.status === 'ask') p.send({ type: 'widgetConsent' });
    await gate(p, 'on');
    return p;
  }

  it('a compile request for a widget a live edit just added waits for the gate, instead of a refusal', async () => {
    const dir = `${root}/.explain/retry-backoff`;
    const html = readFileSync(`${dir}/explainer.html`, 'utf8');
    writeFileSync(`${dir}/widgets/extra.tsx`, 'export default function E() { return <p>extra</p>; }');
    let sendNow: ((m: unknown) => void) | undefined;
    // The panel asks as soon as the new content arrives (a message later), while the gate is being computed.
    const p = await consented({ onPost: (m) => { if (m.type === 'content') setTimeout(() => sendNow?.({ type: 'widgetCompile', src: 'widgets/extra.tsx' })); } });
    sendNow = p.send;
    try {
      writeFileSync(`${dir}/explainer.html`, html.replace('</section>', '<explain-widget src="widgets/extra.tsx"></explain-widget></section>'));
      await (p.session as unknown as { reload(): Promise<void> }).reload();
      await vi.waitFor(() => expect(p.posted.filter((m) => m.type === 'widget' && m.src === 'widgets/extra.tsx')).toHaveLength(1), { timeout: 10_000 });
      expect(p.last('widget')?.build?.entry).toBe('widgets/extra.tsx');
    } finally {
      writeFileSync(`${dir}/explainer.html`, html);
    }
  });

  it('code is served only for anchors the asking widget reads (useAnchorCode with that id)', async () => {
    const p = await consented();
    modal.answer = 'Let Widgets Read';
    p.send({ type: 'widgetConfirmAnchors' });
    await vi.waitFor(() => expect(p.last('widgets')?.gate.unconfirmed).toBeNull());
    p.send({ type: 'widgetCode', src: 'widgets/backoff.tsx', anchor: 'options' });
    await vi.waitFor(() => expect(p.last('widgetCode')).toEqual({ type: 'widgetCode', src: 'widgets/backoff.tsx', code: { anchor: 'options', status: 'unavailable', reason: 'not-requested' } }));
    p.send({ type: 'widgetCode', src: 'widgets/backoff.tsx', anchor: 'delay' });
    await vi.waitFor(() => expect(p.last('widgetCode')?.code.status).toBe('ok'));
  });

  it('a stale focus answer doesn’t move focus; only the latest question’s does', async () => {
    const vscode = await import('./vscode-stub.ts');
    const calls: unknown[] = [];
    const orig = vscode.commands.executeCommand;
    vscode.commands.executeCommand = (async (...a: unknown[]) => void calls.push(a)) as never;
    try {
      const p = await consented();
      (p.session as unknown as { focusQueries: number }).focusQueries = 5;
      p.send({ type: 'focusAnswer', id: 4, legit: false });
      await new Promise((r) => setTimeout(r, 50));
      expect(calls).toEqual([]);
      p.send({ type: 'focusAnswer', id: 5, legit: false });
      await vi.waitFor(() => expect(calls).toEqual([['workbench.action.focusActiveEditorGroup']]));
    } finally {
      vscode.commands.executeCommand = orig;
    }
  });

  it('one hang reported by several panels: one suspect is turned off, each panel hears of it before remounting, and when the watchdog gives up the explainer’s widgets are stopped (with a reason) while panels remount', async () => {
    const host = newHost();
    closers.push(() => host.dispose());
    const a = await consented({ host });
    const b = await consented({ host });
    // Panel A was mounting backoff; panel B last saw activity from a widget it shares the process with.
    a.send({ type: 'widgetsUnresponsive', mounted: ['widgets/backoff.tsx'], mounting: 'widgets/backoff.tsx', recent: null });
    b.send({ type: 'widgetsUnresponsive', mounted: ['widgets/backoff.tsx'], mounting: null, recent: 'widgets/backoff.tsx' });
    for (const p of [a, b]) await vi.waitFor(() => expect(p.posted).toContainEqual({ type: 'widgetsReset', phase: 'remount' }), { timeout: 5000 });
    for (const p of [a, b]) {
      expect(p.posted.filter((m) => m.type === 'widgetsReset')).toEqual([{ type: 'widgetsReset', phase: 'unmount' }, { type: 'widgetsReset', phase: 'remount' }]);
      // The gate naming the disabled widget came first.
      const remount = p.posted.findIndex((m) => m.type === 'widgetsReset' && m.phase === 'remount');
      const gateAt = p.posted.slice(0, remount).findIndex((m) => m.type === 'widgets' && m.gate.disabled.includes('widgets/backoff.tsx'));
      expect(gateAt).toBeGreaterThan(-1);
    }
    // One escalation (the suspect), not one per panel: a second incident escalates to "all", a third stops.
    const resets = () => a.posted.filter((m) => m.type === 'widgetsReset').length;
    a.send({ type: 'widgetsUnresponsive', mounted: ['widgets/backoff.tsx'], mounting: 'widgets/backoff.tsx', recent: null });
    await vi.waitFor(() => expect(resets()).toBe(4), { timeout: 5000 });
    a.send({ type: 'widgetsUnresponsive', mounted: ['widgets/backoff.tsx'], mounting: 'widgets/backoff.tsx', recent: null });
    // Third: the watchdog gives up on this explainer. Its gate stops every widget, with the reason, and the
    // panels remount (nothing of this explainer runs).
    await vi.waitFor(() => expect(resets()).toBe(6), { timeout: 5000 });
    for (const p of [a, b]) expect(p.last('widgets')?.gate).toMatchObject({ stopped: true, disabled: ['widgets/backoff.tsx'] });
    expect(b.posted.filter((m) => m.type === 'widgetsReset').at(-1)).toEqual({ type: 'widgetsReset', phase: 'remount' });
    // Enable Widgets brings them back.
    await host.enableAll();
    await vi.waitFor(() => expect(a.last('widgets')?.gate.stopped).toBeUndefined());
    expect(a.last('widgets')?.gate.disabled).toEqual([]);
  }, 30_000);

  it('a hang nobody can attribute (no widget mounting or recently active) blames no explainer: panels just remount', async () => {
    const p = await consented();
    p.send({ type: 'widgetsUnresponsive', mounted: ['widgets/backoff.tsx'], mounting: null, recent: null });
    await vi.waitFor(() => expect(p.posted).toContainEqual({ type: 'widgetsReset', phase: 'remount' }), { timeout: 5000 });
    expect(p.last('widgets')?.gate.disabled).toEqual([]);
  });
});

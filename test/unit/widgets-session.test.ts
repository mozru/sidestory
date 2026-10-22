// The extension enforces the widget gate itself (docs/WIDGETS-PLAN.md §5.1): compile, library and code
// requests from a panel are refused without trust, the setting and the reader's consent, whatever the panel
// (which renders untrusted content) asks for. Runs a real session over the sample workspace, with the real
// compiler worker (built in dist/).
import { cpSync, mkdtempSync, realpathSync } from 'node:fs';
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
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cx-widgets-')));
  cpSync('fixtures/sample-workspace', root, { recursive: true });
  workspace.root = Uri.file(root);
  configureWidgetCompiler({ workerFile: resolve('dist/compile-worker.cjs'), dataDir: resolve('dist/widget-data') });
});
afterAll(() => disposeWidgetCompiler());

const state = new Map<string, unknown>();
const memento = { get: <T>(k: string, d: T) => (state.has(k) ? (state.get(k) as T) : d), update: async (k: string, v: unknown) => void (v === undefined ? state.delete(k) : state.set(k, v)) };
const closers: (() => void)[] = [];

function open() {
  const host = new WidgetHost({ workspaceState: memento, extensionUri: Uri.file(resolve('.')) } as never);
  const ref = refFromDir(Uri.file(`${root}/.explain/retry-backoff`) as never)!;
  const posted: ToWebview[] = [];
  const messages = new EventEmitter<unknown>();
  const disposed = new EventEmitter<void>();
  const viewState = new EventEmitter<void>();
  const panel = {
    visible: true, title: '', viewColumn: 2,
    webview: { html: '', cspSource: 'test:', asWebviewUri: (u: Uri) => u, onDidReceiveMessage: messages.event, postMessage: async (m: ToWebview) => posted.push(m) > 0 },
    onDidDispose: disposed.event, onDidChangeViewState: viewState.event, dispose: () => disposed.fire(),
  };
  const decorations = { set() {}, setWidget() {}, isDimmed: () => false, refresh() {}, flash() {} };
  const session = new ExplainerSession([ref], panel as never, Uri.file('/ext') as never, decorations as never, { memento: memento as never, reanchor() {}, widgets: host });
  closers.push(() => {
    panel.dispose();
    host.dispose();
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
    p.send({ type: 'widgetCode', anchor: 'delay' });
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
    p.send({ type: 'widgetCode', anchor: 'delay' });
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

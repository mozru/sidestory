// An explainer panel's session over a long life: diving and coming back, edits elsewhere, closing.
// Nothing it sets up may outlive the explainer it belongs to, and work per edit mustn't grow with the manifest.
import { cpSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ToWebview } from '../../src/shared/protocol.ts';
import { counts, EventEmitter, events, Uri, workspace } from './vscode-stub.ts';

vi.mock('vscode', () => import('./vscode-stub.ts'));

const { ExplainerSession } = await import('../../src/extension/session.ts');
const { refFromDir } = await import('../../src/extension/explainers.ts');

let root = '';
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cx-session-')));
  cpSync('fixtures/sample-workspace', root, { recursive: true });
  workspace.root = Uri.file(root);
});

/** Panels opened by the test, closed after it. */
const panels: { dispose(): void }[] = [];

function open(name: string) {
  const ref = refFromDir(Uri.file(`${root}/.explain/${name}`) as never)!;
  const posted: ToWebview[] = [];
  const messages = new EventEmitter<unknown>();
  const disposed = new EventEmitter<void>();
  const panel = {
    visible: true,
    title: '',
    viewColumn: 2,
    webview: {
      html: '',
      cspSource: 'test:',
      asWebviewUri: (u: Uri) => u,
      onDidReceiveMessage: messages.event,
      postMessage: async (m: ToWebview) => posted.push(m) > 0,
    },
    onDidDispose: disposed.event,
    dispose: () => disposed.fire(),
  };
  const decorations = { set() {}, setWidget() {}, isDimmed: () => false, refresh() {}, flash() {} };
  const memento = { get: <T>(_k: string, d: T) => d, update: async () => {} };
  panels.push(panel);
  const session = new ExplainerSession([ref], panel as never, Uri.file('/ext') as never, decorations as never, { memento: memento as never, reanchor() {} });
  const lastInit = () => posted.filter((m) => m.type === 'init').at(-1) as Extract<ToWebview, { type: 'init' }> | undefined;
  return { session, panel, posted, lastInit, send: (m: unknown) => messages.fire(m) };
}

const listeners = () => Object.values(events).reduce((n, e) => n + e.listeners.size, 0);

afterEach(async () => {
  for (const p of panels.splice(0)) p.dispose();
  await new Promise((r) => setTimeout(r, 300)); // anything still loading finishes (and must give up)
  expect(listeners()).toBe(0);
  expect(counts.watchers).toBe(0);
});

describe('ExplainerSession lifecycle', () => {
  it('diving and coming back many times keeps one explainer’s watchers and listeners, and closing releases them all', async () => {
    const { session, panel, lastInit, send } = open('overview');
    await session.load();
    send({ type: 'ready' });
    await vi.waitFor(() => expect(lastInit()?.title).toBe('Sample workspace tour'));
    const watchers = counts.watchers;
    const subscribed = listeners();
    expect(watchers).toBeGreaterThan(0);
    for (let i = 0; i < 20; i++) {
      send({ type: 'dive', name: 'bit-reader' });
      await vi.waitFor(() => expect(lastInit()?.dir).toMatch(/bit-reader$/));
      send({ type: 'goTo', depth: 0 });
      await vi.waitFor(() => expect(lastInit()?.dir).toMatch(/overview$/));
    }
    expect(counts.watchers).toBe(watchers);
    expect(listeners()).toBe(subscribed);
    panel.dispose();
    // afterEach: nothing left
  });

  it('closing the panel while a dive is loading leaves nothing behind', async () => {
    const { session, panel, send } = open('overview');
    await session.load();
    send({ type: 'ready' });
    send({ type: 'dive', name: 'bit-reader' });
    await Promise.resolve();
    panel.dispose();
  });

  it('edits and cursor moves in other files cost nothing per anchor, and the lookup follows the explainer shown', async () => {
    const { session, panel, lastInit, posted, send } = open('overview');
    await session.load();
    send({ type: 'ready' });
    send({ type: 'dive', name: 'bit-reader' });
    await vi.waitFor(() => expect(lastInit()?.dir).toMatch(/bit-reader$/));
    await vi.waitFor(() => expect(lastInit()?.anchors.every((a) => a.state !== 'pending')).toBe(true));

    const elsewhere = { uri: Uri.file(`${root}/README.md`), lineCount: 10 };
    const change = { document: elsewhere, contentChanges: [{ range: {}, text: 'x' }] };
    const selection = { textEditor: { document: elsewhere }, selections: [{ active: { line: 3 } }], kind: 1 };
    const before = counts.joinPath;
    for (let i = 0; i < 100; i++) {
      events.documentChanged.fire(change);
      events.selectionChanged.fire(selection);
    }
    // Only the explainer's own two files are named per event, however many anchors it has.
    expect((counts.joinPath - before) / 100).toBeLessThanOrEqual(2);

    // The cursor in the detail's code still finds its section (an anchor the overview doesn't have).
    events.selectionChanged.fire({ textEditor: { document: { uri: Uri.file(`${root}/rtl/bit_reader.sv`) } }, selections: [{ active: { line: 35 } }], kind: 1 });
    await vi.waitFor(() => expect(posted).toContainEqual({ type: 'syncTo', anchorId: 'refill' }));
  });
});

// The extension's side of the panel's Back / Forward: the page keeps the history; the session opens what it asks for
// (checked like a restored trail), relays Sidestory: Back / Forward, and marks Go to Step as a jump.
import { cpSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ToWebview } from '../../src/shared/protocol.ts';
import { fromWebviewSchema } from '../../src/shared/protocol.ts';
import { EventEmitter, Uri, workspace } from './vscode-stub.ts';

vi.mock('vscode', () => import('./vscode-stub.ts'));

const { ExplainerSession } = await import('../../src/extension/session.ts');
const { refFromDir } = await import('../../src/extension/explainers.ts');

let root = '';
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cx-history-')));
  cpSync('fixtures/sample-workspace', root, { recursive: true });
  workspace.root = Uri.file(root);
});

const panels: { dispose(): void }[] = [];
afterEach(async () => {
  for (const p of panels.splice(0)) p.dispose();
  await new Promise((r) => setTimeout(r, 200));
});

function open(name: string, historyChanged?: (s: InstanceType<typeof ExplainerSession>) => void) {
  const ref = refFromDir(Uri.file(`${root}/.sidestory/${name}`) as never)!;
  const posted: ToWebview[] = [];
  const messages = new EventEmitter<unknown>();
  const disposed = new EventEmitter<void>();
  const panel = {
    visible: true,
    title: '',
    viewColumn: 2,
    webview: { html: '', cspSource: 'test:', asWebviewUri: (u: Uri) => u, onDidReceiveMessage: messages.event, postMessage: async (m: ToWebview) => posted.push(m) > 0 },
    onDidDispose: disposed.event,
    onDidChangeViewState: new EventEmitter<void>().event,
    dispose: () => disposed.fire(),
  };
  panels.push(panel);
  const decorations = { set() {}, setWidget() {}, isDimmed: () => false, refresh() {}, flash() {}, clearFlash() {} };
  const session = new ExplainerSession([ref], panel as never, Uri.file('/ext') as never, decorations as never, { memento: { get: <T>(_k: string, d: T) => d, update: async () => {} } as never, reanchor() {}, historyChanged });
  const lastInit = () => posted.filter((m) => m.type === 'init').at(-1) as Extract<ToWebview, { type: 'init' }> | undefined;
  return { session, posted, lastInit, send: (m: unknown) => messages.fire(m) };
}

const dirOf = (name: string) => Uri.file(`${root}/.sidestory/${name}`).toString();

describe('Back / Forward', () => {
  it('openHistory shows that sidestory with its trail, at its step', async () => {
    const { session, lastInit, send } = open('bit-reader');
    await session.load();
    send({ type: 'ready' });
    await vi.waitFor(() => expect(lastInit()?.dir).toBe(dirOf('bit-reader')));
    send({ type: 'openHistory', dir: dirOf('retry-backoff'), trail: ['overview', 'retry-backoff'], active: 'loop' });
    await vi.waitFor(() => expect(lastInit()?.dir).toBe(dirOf('retry-backoff')));
    expect(lastInit()?.trail.map((t) => t.name)).toEqual(['overview', 'retry-backoff']);
    expect(lastInit()?.active).toBe('loop');
    expect(session.trailRefs.map((r) => r.name)).toEqual(['overview', 'retry-backoff']);
  });

  it('refuses what a restored trail would refuse: outside a .sidestory folder, a trail not ending at it, repeats', async () => {
    const { session, lastInit, posted, send } = open('bit-reader');
    await session.load();
    send({ type: 'ready' });
    await vi.waitFor(() => expect(lastInit()?.dir).toBe(dirOf('bit-reader')));
    const inits = () => posted.filter((m) => m.type === 'init').length;
    const before = inits();
    send({ type: 'openHistory', dir: Uri.file(`${root}/rtl`).toString(), trail: ['rtl'] });
    send({ type: 'openHistory', dir: dirOf('overview'), trail: ['bit-reader'] });
    send({ type: 'openHistory', dir: dirOf('overview'), trail: ['overview', 'overview'] });
    send({ type: 'openHistory', dir: '::not a uri', trail: ['overview'] });
    send({ type: 'openHistory', dir: 'file:///elsewhere/.sidestory/overview', trail: ['overview'] });
    await new Promise((r) => setTimeout(r, 200));
    expect(inits()).toBe(before);
    expect(session.ref.name).toBe('bit-reader');
    // Each refusal tells the page, so it stops waiting and forgets the entry.
    expect(posted.filter((m) => m.type === 'historyFailed').map((m) => (m as { dir: string }).dir)).toEqual([
      Uri.file(`${root}/rtl`).toString(),
      dirOf('overview'),
      dirOf('overview'),
      '::not a uri',
      'file:///elsewhere/.sidestory/overview',
    ]);
  });

  it('a sidestory deleted since, a dive into nothing and a way up that is gone are refused too', async () => {
    const { session, lastInit, posted, send } = open('bit-reader');
    await session.load();
    send({ type: 'ready' });
    await vi.waitFor(() => expect(lastInit()?.dir).toBe(dirOf('bit-reader')));
    const failed = () => posted.filter((m) => m.type === 'historyFailed');
    send({ type: 'openHistory', dir: dirOf('deleted'), trail: ['deleted'] });
    await vi.waitFor(() => expect(failed()).toEqual([{ type: 'historyFailed', dir: dirOf('deleted'), trail: ['deleted'] }]));
    send({ type: 'dive', name: 'no-such-detail' });
    await vi.waitFor(() => expect(failed()).toHaveLength(2));
    expect(failed()[1]).toEqual({ type: 'historyFailed', dir: dirOf('no-such-detail'), trail: ['bit-reader', 'no-such-detail'] });
    send({ type: 'goTo', depth: 3 });
    expect(failed()[2]).toEqual({ type: 'historyFailed', dir: '', trail: [] });
    expect(session.ref.name).toBe('bit-reader');
  });

  it('the page’s Back / Forward state reaches the host', async () => {
    const changed: boolean[][] = [];
    const { session, send } = open('bit-reader', (s) => changed.push([s.canNavigate.back, s.canNavigate.forward]));
    await session.load();
    send({ type: 'historyState', canBack: true, canForward: false });
    send({ type: 'historyState', canBack: false, canForward: true });
    expect(changed).toEqual([[true, false], [false, true]]);
  });

  it('Sidestory: Back / Forward reach the page; Go to Step is a jump', async () => {
    const { session, posted, lastInit, send } = open('bit-reader');
    await session.load();
    send({ type: 'ready' });
    await vi.waitFor(() => expect(lastInit()).toBeDefined());
    session.history(-1);
    session.history(1);
    const id = lastInit()!.anchors[1]!.id;
    session.goTo(id);
    expect(posted.filter((m) => m.type === 'history' || m.type === 'syncTo')).toEqual([
      { type: 'history', delta: -1 },
      { type: 'history', delta: 1 },
      { type: 'syncTo', anchorId: id, jump: true },
    ]);
  });

  it('the message is checked: names, trail length, anchor id', () => {
    const ok = { type: 'openHistory', dir: dirOf('overview'), trail: ['overview'], active: 'intro' };
    expect(fromWebviewSchema.safeParse(ok).success).toBe(true);
    expect(fromWebviewSchema.safeParse({ ...ok, trail: [] }).success).toBe(false);
    expect(fromWebviewSchema.safeParse({ ...ok, trail: ['../x'] }).success).toBe(false);
    expect(fromWebviewSchema.safeParse({ ...ok, trail: Array.from({ length: 17 }, (_, i) => `s${i}`) }).success).toBe(false);
    expect(fromWebviewSchema.safeParse({ ...ok, active: 'no spaces' }).success).toBe(false);
  });
});

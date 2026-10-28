// The hover preview, host side (`sidestory.hoverPreview`): what a link's card shows, through the same resolution and
// checks as a click, and the editor mark; nothing ever opens, scrolls or takes focus.
import { cpSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToWebview } from '../../src/shared/protocol.ts';
import { config, EventEmitter, events, fakeDocument, modal, shown, Uri, window, workspace } from './vscode-stub.ts';

vi.mock('vscode', () => import('./vscode-stub.ts'));

const { ExplainerSession } = await import('../../src/extension/session.ts');
const { refFromDir } = await import('../../src/extension/explainers.ts');
const { previewLines } = await import('../../src/extension/preview.ts');
const { Decorations } = await import('../../src/extension/decorations.ts');
const { fromWebviewSchema } = await import('../../src/shared/protocol.ts');

let root = '';
beforeAll(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cx-hover-')));
  cpSync('fixtures/sample-workspace', root, { recursive: true });
  workspace.root = Uri.file(root);
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'config/secrets.json'), '{}\n');
});

const panels: { dispose(): void }[] = [];
afterEach(() => {
  for (const p of panels.splice(0)) p.dispose();
  delete config['sidestory.hoverPreview'];
  (window as { visibleTextEditors: unknown[] }).visibleTextEditors = [];
  (workspace as { textDocuments: unknown[] }).textDocuments = [];
});
beforeEach(() => {
  shown.length = 0;
  modal.asked.length = 0;
});

async function ready() {
  const ref = refFromDir(Uri.file(`${root}/.sidestory/bit-reader`) as never)!;
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
  const hovers: unknown[] = [];
  const decorations = { set() {}, setWidget() {}, isDimmed: () => false, refresh() {}, flash() {}, clearFlash() {}, setHover: (h: unknown) => hovers.push(h) };
  const session = new ExplainerSession([ref], panel as never, Uri.file('/ext') as never, decorations as never, { memento: { get: <T>(_k: string, d: T) => d, update: async () => {} } as never, reanchor() {} });
  const send = (m: unknown) => messages.fire(m);
  await session.load();
  send({ type: 'ready' });
  await vi.waitFor(() => expect((posted.filter((m) => m.type === 'init').at(-1) as { anchors: { state: string }[] } | undefined)?.anchors.every((a) => a.state !== 'pending')).toBe(true));
  send({ type: 'codeTargets', sections: [], refs: [], links: ['rtl/bit_reader.sv#L3-L5', 'rtl/bit_reader.sv#L900', 'rtl/bit_reader.sv', 'rtl/bit_reader.sv#driver(cnt_q)', 'config/secrets.json'] });
  const reply = async (id: number) => {
    await vi.waitFor(() => expect(posted.some((m) => m.type === 'codePreview' && m.id === id)).toBe(true));
    return posted.find((m) => m.type === 'codePreview' && m.id === id) as Extract<ToWebview, { type: 'codePreview' }>;
  };
  return { posted, send, reply, hovers };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('previewLines', () => {
  const text = Array.from({ length: 40 }, (_, i) => `    line ${i + 1}`).join('\n');

  it('gives the range, its common indentation removed', () => {
    expect(previewLines(text, { start: 3, end: 5 })).toEqual({ start: 3, end: 5, lines: ['line 3', 'line 4', 'line 5'], more: 0 });
    expect(previewLines('a\r\n  b\r\n\t c\n', { start: 1, end: 3 })).toEqual({ start: 1, end: 3, lines: ['a', '  b', '\t c'], more: 0 });
    expect(previewLines('  x\n\n    y', { start: 1, end: 3 })!.lines).toEqual(['x', '', '  y']); // a blank line doesn't count
  });

  it('caps at 12 lines of 200 characters, and counts the rest; clamps to the text; nothing past its end', () => {
    expect(previewLines(text, { start: 1, end: 30 })).toMatchObject({ end: 30, more: 18 });
    expect(previewLines(text, { start: 1, end: 30 })!.lines).toHaveLength(12);
    expect(previewLines(text, { start: 35, end: 99 })).toMatchObject({ start: 35, end: 40, more: 0 });
    expect(previewLines(`${'x'.repeat(500)}\nb`, { start: 1, end: 1 })!.lines[0]).toHaveLength(200);
    expect(previewLines(text, { start: 41, end: 41 })).toBeUndefined();
  });
});

describe('previewRef and previewCode', () => {
  it('a ref gives its anchor’s resolved lines; a code link its target, symbols included; nothing is opened', async () => {
    const { send, reply } = await ready();
    send({ type: 'previewRef', id: 1, anchorId: 'state' });
    expect((await reply(1)).preview).toMatchObject({ path: 'rtl/bit_reader.sv', start: 16, end: 17, lines: ['logic [W-1:0] buf_q;   // MSB-aligned bit window', 'logic [6:0]   cnt_q;   // valid bits in buf_q'], more: 0, languageId: 'sv' });
    send({ type: 'previewCode', id: 2, path: 'rtl/bit_reader.sv', target: 'L3-L5' });
    expect((await reply(2)).preview).toMatchObject({ start: 3, end: 5, lines: [') (', '  input  logic         clk,', '  input  logic         rst_n,'] });
    send({ type: 'previewCode', id: 3, path: 'rtl/bit_reader.sv' });
    expect((await reply(3)).preview).toMatchObject({ start: 1, end: 44, more: 32, languageId: 'systemverilog' }) // the empty line after the last newline counts, as in the editor;
    expect((await reply(3)).preview!.lines).toHaveLength(12);
    send({ type: 'previewCode', id: 4, path: 'rtl/bit_reader.sv', target: 'driver(cnt_q)' });
    expect((await reply(4)).preview).toMatchObject({ start: 23 });
    expect(shown).toHaveLength(0);
    expect(modal.asked).toHaveLength(0);
  });

  it('not found: an unknown anchor, a target past the end, a link the page doesn’t have; a secret file is never read', async () => {
    const { send, reply, posted } = await ready();
    send({ type: 'previewRef', id: 1, anchorId: 'nope' });
    expect(await reply(1)).toEqual({ type: 'codePreview', id: 1, preview: null });
    send({ type: 'previewCode', id: 2, path: 'rtl/bit_reader.sv', target: 'L900' });
    expect((await reply(2)).preview).toBeNull();
    send({ type: 'previewCode', id: 3, path: 'rtl/bit_reader.sv', target: 'L7' }); // not on the page
    expect((await reply(3)).preview).toBeNull();
    send({ type: 'previewCode', id: 4, path: 'config/secrets.json' });
    expect(await reply(4)).toMatchObject({ preview: null, note: expect.stringContaining('secrets') });
    expect(modal.asked).toHaveLength(0);
    // Schema-invalid requests never arrive.
    const before = posted.length;
    send({ type: 'previewCode', id: 5, path: '../outside.sv' });
    send({ type: 'previewRef', id: -1, anchorId: 'state' });
    await sleep(100);
    expect(posted.length).toBe(before);
  });

  it('`off` answers nothing; `editor` marks visible editors only and posts no card; previewEnd clears the mark', async () => {
    const { send, posted, hovers } = await ready();
    config['sidestory.hoverPreview'] = 'off';
    send({ type: 'previewRef', id: 1, anchorId: 'state' });
    await sleep(100);
    expect(posted.some((m) => m.type === 'codePreview')).toBe(false);
    expect(hovers).toEqual([]);

    config['sidestory.hoverPreview'] = 'editor';
    send({ type: 'previewRef', id: 2, anchorId: 'consume' });
    await vi.waitFor(() => expect(hovers).toHaveLength(1));
    expect(hovers[0]).toMatchObject({ range: { start: 31, end: 34 } });
    expect((hovers[0] as { uri: Uri }).uri.fsPath).toBe(Uri.file(join(root, 'rtl/bit_reader.sv')).fsPath);
    send({ type: 'previewEnd' });
    expect(hovers).toEqual([hovers[0], undefined]);
    // A code link's file is looked at only when a document is already open: none is here, so no mark.
    send({ type: 'previewCode', id: 3, path: 'rtl/bit_reader.sv', target: 'L3-L5' });
    await sleep(100);
    expect(hovers).toHaveLength(2);
    (workspace as { textDocuments: unknown[] }).textDocuments = [fakeDocument(Uri.file(join(root, 'rtl/bit_reader.sv')), 'a\nb\nc\nd\ne\n')];
    send({ type: 'previewCode', id: 4, path: 'rtl/bit_reader.sv', target: 'L3-L5' });
    await vi.waitFor(() => expect(hovers).toHaveLength(3));
    expect(hovers[2]).toMatchObject({ range: { start: 3, end: 5 } });
    expect(posted.some((m) => m.type === 'codePreview')).toBe(false);
    expect(shown).toHaveLength(0);
  });

  it('the setting reaches the page with init and when it changes', async () => {
    const { posted } = await ready();
    expect(posted).toContainEqual({ type: 'settings', hoverPreview: 'card' });
    config['sidestory.hoverPreview'] = 'both';
    events.configurationChanged.fire({ affectsConfiguration: (k: string) => k === 'sidestory.hoverPreview' });
    expect(posted.at(-1)).toEqual({ type: 'settings', hoverPreview: 'both' });
    config['sidestory.hoverPreview'] = 'sideways';
    events.configurationChanged.fire({ affectsConfiguration: (k: string) => k === 'sidestory.hoverPreview' });
    expect(posted.at(-1)).toEqual({ type: 'settings', hoverPreview: 'card' });
  });
});

describe('the hover mark', () => {
  it('goes on visible editors of that file only, and comes off', () => {
    const uri = Uri.file('/w/a.ts');
    const editor = (u: Uri) => {
      const set = new Map<unknown, unknown[]>();
      return { set, document: { uri: u, lineCount: 50 }, setDecorations: (t: unknown, r: unknown[]) => set.set(t, r) };
    };
    const a = editor(uri);
    const b = editor(Uri.file('/w/b.ts'));
    (window as { visibleTextEditors: unknown[] }).visibleTextEditors = [a, b];
    const d = new Decorations();
    try {
      d.setHover({ uri: uri as never, range: { start: 3, end: 5 } });
      const lit = (e: typeof a) => [...e.set.values()].flat() as { start: { line: number }; end: { line: number } }[];
      expect(lit(a).map((r) => [r.start.line, r.end.line])).toEqual([[2, 4]]);
      expect(lit(b)).toEqual([]);
      d.setHover(undefined);
      expect(lit(a)).toEqual([]);
    } finally {
      d.dispose();
    }
  });

  it('the schema takes previews of anchors and safe code links only', () => {
    expect(fromWebviewSchema.safeParse({ type: 'previewRef', id: 1, anchorId: 'state' }).success).toBe(true);
    expect(fromWebviewSchema.safeParse({ type: 'previewCode', id: 1, path: 'rtl/a.sv', target: 'L1-L2' }).success).toBe(true);
    expect(fromWebviewSchema.safeParse({ type: 'previewCode', id: 1, path: '/etc/passwd' }).success).toBe(false);
    expect(fromWebviewSchema.safeParse({ type: 'previewCode', id: 1, path: 'a.sv', target: 'L0' }).success).toBe(false);
    expect(fromWebviewSchema.safeParse({ type: 'previewRef', id: 1.5, anchorId: 'state' }).success).toBe(false);
    expect(fromWebviewSchema.safeParse({ type: 'previewEnd' }).success).toBe(true);
  });
});

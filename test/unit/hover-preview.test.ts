// The hover preview, host side (`sidestory.hoverPreview`): what a link's card shows, through the same resolution and
// checks as a click, and the editor mark; nothing ever opens, scrolls or takes focus.
import { cpSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToWebview } from '../../src/shared/protocol.ts';
import { config, EventEmitter, events, fakeDocument, modal, Position, Range, shown, Uri, window, workspace } from './vscode-stub.ts';

vi.mock('vscode', () => import('./vscode-stub.ts'));

const { ExplainerSession } = await import('../../src/extension/session.ts');
const { refFromDir } = await import('../../src/extension/explainers.ts');
const { previewLines } = await import('../../src/extension/preview.ts');
const { Decorations } = await import('../../src/extension/decorations.ts');
const { edgeArrow } = await import('../../src/extension/hover-mark.ts');
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
  config['sidestory.hoverPreview'] = 'card'; // the card's tests; `editor` (the default) is set where it's tested
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
  const decorations = { set() {}, setWidget() {}, isDimmed: () => false, refresh() {}, flash() {}, clearFlash() {}, setHover: (_owner: unknown, h: unknown) => hovers.push(h) };
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
    expect((await reply(3)).preview).toMatchObject({ start: 1, end: 44, more: 32, languageId: 'sv' }) // the empty line after the last newline counts, as in the editor;
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

  it('`off` answers nothing; `editor` marks the lines at the card’s moment and posts no card; previewEnd clears the mark', async () => {
    const { send, posted, hovers } = await ready();
    config['sidestory.hoverPreview'] = 'off';
    send({ type: 'previewRef', id: 1, anchorId: 'state' });
    await sleep(100);
    expect(posted.some((m) => m.type === 'codePreview')).toBe(false);
    expect(hovers).toEqual([]);

    config['sidestory.hoverPreview'] = 'editor';
    const file = Uri.file(join(root, 'rtl/bit_reader.sv'));
    (window as { visibleTextEditors: unknown[] }).visibleTextEditors = [{ document: { uri: file } }];
    send({ type: 'previewRef', id: 2, anchorId: 'consume' });
    await sleep(100);
    expect(hovers).toEqual([]); // resolved, but marked only at the card's moment, so sweeping marks nothing
    send({ type: 'previewShow', id: 2 });
    await vi.waitFor(() => expect(hovers).toHaveLength(1));
    expect(hovers[0]).toMatchObject({ range: { start: 31, end: 34 }, reveal: false });
    expect((hovers[0] as { uri: Uri }).uri.fsPath).toBe(file.fsPath);
    send({ type: 'previewEnd' });
    expect(hovers).toEqual([hovers[0], undefined]);
    (workspace as { textDocuments: unknown[] }).textDocuments = [fakeDocument(file, 'a\nb\nc\nd\ne\n')];
    send({ type: 'previewShow', id: 4 }); // before it resolved: marked once it does
    send({ type: 'previewCode', id: 4, path: 'rtl/bit_reader.sv', target: 'L3-L5' });
    await vi.waitFor(() => expect(hovers).toHaveLength(3));
    expect(hovers[2]).toMatchObject({ range: { start: 3, end: 5 } });
    expect(posted.some((m) => m.type === 'codePreview')).toBe(false); // on screen: nothing to say by the link
    expect(shown).toHaveLength(0);
  });

  it('`editor`: the page says so by the link when no editor shows the file, or the code can’t be found; nothing opens', async () => {
    const { send, reply } = await ready();
    config['sidestory.hoverPreview'] = 'editor';
    const opened = vi.spyOn(workspace, 'openTextDocument');
    try {
      send({ type: 'previewRef', id: 1, anchorId: 'consume' });
      send({ type: 'previewShow', id: 1 });
      expect(await reply(1)).toEqual({ type: 'codePreview', id: 1, preview: null, note: "bit_reader.sv isn't open · click to open" });
      send({ type: 'previewEnd' });
      send({ type: 'previewCode', id: 2, path: 'rtl/bit_reader.sv', target: 'L3-L5' }); // no document: never read
      send({ type: 'previewShow', id: 2 });
      expect((await reply(2)).note).toBe("bit_reader.sv isn't open · click to open");
      send({ type: 'previewEnd' });
      send({ type: 'previewRef', id: 3, anchorId: 'nope' });
      send({ type: 'previewShow', id: 3 });
      expect((await reply(3)).note).toBe('Code not found');
      expect(opened).not.toHaveBeenCalled();
      expect(shown).toHaveLength(0);
    } finally {
      opened.mockRestore();
    }
  });

  it('a file no editor has open is read, never opened as a document (that would wake its language server)', async () => {
    const { send, reply } = await ready();
    const opened = vi.spyOn(workspace, 'openTextDocument');
    try {
      send({ type: 'previewCode', id: 1, path: 'rtl/bit_reader.sv', target: 'L3-L5' });
      expect((await reply(1)).preview).toMatchObject({ start: 3, end: 5, languageId: 'sv' });
      send({ type: 'previewCode', id: 2, path: 'rtl/bit_reader.sv', target: 'driver(cnt_q)' });
      expect((await reply(2)).preview).toMatchObject({ start: 23 });
      send({ type: 'previewCode', id: 3, path: 'rtl/bit_reader.sv' });
      expect((await reply(3)).preview).toMatchObject({ start: 1, end: 44 });
      expect(opened).not.toHaveBeenCalled();
    } finally {
      opened.mockRestore();
    }
  });

  it('the setting reaches the page with init and when it changes', async () => {
    delete config['sidestory.hoverPreview'];
    const { posted } = await ready();
    expect(posted).toContainEqual({ type: 'settings', hoverPreview: 'editor' });
    config['sidestory.hoverPreview'] = 'both';
    events.configurationChanged.fire({ affectsConfiguration: (k: string) => k === 'sidestory.hoverPreview' });
    expect(posted.at(-1)).toEqual({ type: 'settings', hoverPreview: 'both' });
    config['sidestory.hoverPreview'] = 'sideways';
    events.configurationChanged.fire({ affectsConfiguration: (k: string) => k === 'sidestory.hoverPreview' });
    expect(posted.at(-1)).toEqual({ type: 'settings', hoverPreview: 'editor' });
  });
});

describe('the hover mark', () => {
  const uri = Uri.file('/w/a.ts');
  /** An editor showing lines `top`–`bottom` (0-based) of a 200-line file: what it's painted with, and its reveals. */
  const editor = (u: Uri, top = 0, bottom = 39) => {
    const set = new Map<unknown, unknown[]>();
    const reveals: [number, number][] = [];
    const e = {
      set,
      reveals,
      document: { uri: u, lineCount: 200, lineAt: (n: number) => ({ range: { end: new Position(n, 4) } }) },
      visibleRanges: [new Range(top, 0, bottom, 0)],
      setDecorations: (t: unknown, r: unknown[]) => set.set(t, r),
      revealRange: (r: Range, type: number) => reveals.push([r.start.line, type]),
      scrollTo(t: number, b: number) {
        e.visibleRanges = [new Range(t, 0, b, 0)];
        events.visibleRangesChanged.fire({ textEditor: e });
      },
    };
    return e;
  };
  type Ed = ReturnType<typeof editor>;
  const painted = (e: Ed) => [...e.set.values()].flat() as { start: { line: number }; end: { line: number }; renderOptions?: { after: { contentText: string } } }[];
  const arrow = (e: Ed) => painted(e).find((r) => r.renderOptions)?.renderOptions!.after.contentText;
  const lines = (e: Ed) => painted(e).filter((r) => !r.renderOptions).map((r) => [r.start.line, r.end.line]);
  const show = (...es: Ed[]) => ((window as { visibleTextEditors: unknown[] }).visibleTextEditors = es);
  afterEach(() => vi.useRealTimers());

  it('edge arrows: above, below, none when partly visible or folded away, label or distance', () => {
    const v = (...r: [number, number][]) => r.map(([a, b]) => new Range(a, 0, b, 0)) as never;
    expect(edgeArrow(v([50, 89]), 13, 17, 'Refill')).toEqual({ line: 50, text: '↑ Refill · L14–18' });
    expect(edgeArrow(v([50, 89]), 13, 17)).toEqual({ line: 50, text: '↑ L14–18 · 33 lines up' });
    expect(edgeArrow(v([0, 39]), 120, 120)).toEqual({ line: 39, text: '↓ L121 · 81 lines down' });
    expect(edgeArrow(v([0, 39]), 30, 60)).toBeUndefined();
    expect(edgeArrow(v([0, 9], [40, 49]), 20, 25)).toBeUndefined(); // in a fold between visible ranges
    expect(edgeArrow([], 1, 2)).toBeUndefined();
  });

  it('marks visible editors of that file (lines and arrow), follows scrolling, and comes off only for the panel that made it', () => {
    const a = editor(uri, 0, 39);
    const b = editor(Uri.file('/w/b.ts'));
    show(a, b);
    const d = new Decorations();
    const owner = {};
    try {
      d.setHover(owner, { uri: uri as never, range: { start: 101, end: 104 }, label: 'Refill', reveal: false });
      expect(lines(a)).toEqual([[100, 103]]);
      expect(arrow(a)).toBe('↓ Refill · L101–104');
      expect(painted(b)).toEqual([]);
      expect(a.reveals).toEqual([]); // never scrolls without hoverReveal
      a.scrollTo(90, 129); // now in view: no arrow
      expect(arrow(a)).toBeUndefined();
      a.scrollTo(150, 189);
      expect(arrow(a)).toBe('↑ Refill · L101–104');
      d.setHover({}, undefined); // another panel's previewEnd leaves this mark alone
      expect(lines(a)).toEqual([[100, 103]]);
      d.setHover(owner, undefined);
      expect(painted(a)).toEqual([]);
      const c = editor(uri, 0, 39); // an editor opened later gets nothing
      show(a, c);
      events.visibleEditorsChanged.fire(undefined);
      expect(painted(c)).toEqual([]);
    } finally {
      d.dispose();
      show();
    }
  });

  it('hoverReveal scrolls an editor whose view misses the lines, and back after; not after a click or the reader scrolling it', () => {
    vi.useFakeTimers();
    const d = new Decorations();
    const owner = {};
    const target = { uri: uri as never, range: { start: 101, end: 104 }, reveal: true };
    try {
      const a = editor(uri, 10, 49);
      const inView = editor(uri, 90, 129);
      show(a, inView);
      d.setHover(owner, target);
      expect(a.reveals).toEqual([[100, 2]]); // InCenterIfOutsideViewport
      expect(inView.reveals).toEqual([]);
      expect(arrow(a)).toBeUndefined(); // on its way there: no arrow
      a.scrollTo(80, 119); // the reveal's own scroll
      d.setHover(owner, undefined);
      expect(a.reveals).toEqual([[100, 2], [10, 3]]); // back to its first line, AtTop
      a.scrollTo(10, 49);

      d.setHover(owner, target);
      a.scrollTo(80, 119);
      d.setHover(owner, undefined, true); // the reader clicked the link
      expect(a.reveals).toHaveLength(3);

      a.scrollTo(10, 49);
      d.setHover(owner, target);
      a.scrollTo(80, 119);
      vi.advanceTimersByTime(1000);
      a.scrollTo(60, 99); // the reader scrolled it
      d.setHover(owner, undefined);
      expect(a.reveals).toHaveLength(4); // the reveal only: not fought back
    } finally {
      d.dispose();
      show();
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

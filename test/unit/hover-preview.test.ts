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
const { edgeArrow, RESTORE_MS } = await import('../../src/extension/hover-mark.ts');
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
  const ends: unknown[] = [];
  const kept: unknown[] = [];
  const decorations = {
    set() {},
    setWidget() {},
    isDimmed: () => false,
    refresh() {},
    flash() {},
    clearFlash() {},
    setHover: (_owner: unknown, h: unknown, end: unknown) => (hovers.push(h), h || ends.push(end)),
    keepHover: (owner: unknown) => kept.push(owner),
  };
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
  return { posted, send, reply, hovers, ends, kept, panel };
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

  it('hoverReveal: a hover ending with the pointer out of the panel waits; the next end, a hide or a close restores; a click keeps', async () => {
    const { send, hovers, ends, kept, panel } = await ready();
    config['sidestory.hoverPreview'] = 'editor';
    config['sidestory.hoverReveal'] = true;
    try {
      const mark = async (id: number) => {
        const n = hovers.length;
        send({ type: 'previewRef', id, anchorId: 'consume' });
        send({ type: 'previewShow', id });
        await vi.waitFor(() => expect(hovers.length).toBe(n + 1));
        expect(hovers.at(-1)).toMatchObject({ reveal: true });
      };
      await mark(1);
      send({ type: 'previewEnd', left: true });
      send({ type: 'previewEnd' }); // the panel is used again
      expect(ends).toEqual(['left', undefined]);
      send({ type: 'previewEnd' }); // nothing left to end
      expect(ends).toHaveLength(2);
      await mark(2);
      send({ type: 'openRef', anchorId: 'consume' });
      expect(kept).toHaveLength(1);
      await mark(3);
      panel.dispose(); // closed mid-hover: the scroll goes back
      expect(ends).toEqual(['left', undefined, undefined]);
    } finally {
      delete config['sidestory.hoverReveal'];
    }
  });

  it('`editor`: the page says so by the link when no editor shows the file, or the code can’t be found; nothing opens', async () => {
    const { send, reply } = await ready();
    config['sidestory.hoverPreview'] = 'editor';
    const opened = vi.spyOn(workspace, 'openTextDocument');
    try {
      send({ type: 'previewRef', id: 1, anchorId: 'consume' });
      send({ type: 'previewShow', id: 1 });
      expect(await reply(1)).toEqual({ type: 'codePreview', id: 1, preview: null, note: "bit_reader.sv isn't on screen · click to open" });
      send({ type: 'previewEnd' });
      send({ type: 'previewCode', id: 2, path: 'rtl/bit_reader.sv', target: 'L3-L5' }); // no document: never read
      send({ type: 'previewShow', id: 2 });
      expect((await reply(2)).note).toBe("bit_reader.sv isn't on screen · click to open");
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
    const calls: unknown[] = [];
    const reveals: [number, number][] = [];
    const e = {
      set,
      calls,
      reveals,
      document: { uri: u, lineCount: 200, lineAt: (n: number) => ({ text: 'code', range: { end: new Position(n, 4) } }) },
      visibleRanges: [new Range(top, 0, bottom, 0)],
      setDecorations: (t: unknown, r: unknown[]) => (set.set(t, r), calls.push(t)),
      revealRange: (r: Range, type: number) => reveals.push([r.start.line, type]),
      scrollTo(t: number, b: number) {
        e.visibleRanges = [new Range(t, 0, b, 0)];
        events.visibleRangesChanged.fire({ textEditor: e });
      },
    };
    return e;
  };
  type Ed = ReturnType<typeof editor>;
  type Painted = { start: { line: number }; end: { line: number } } | { range: { start: { line: number } }; renderOptions: { after: { contentText: string } } };
  const painted = (e: Ed) => [...e.set.values()].flat() as Painted[];
  const arrow = (e: Ed) => {
    const a = painted(e).find((r) => 'renderOptions' in r);
    return a && 'range' in a ? { line: a.range.start.line, text: a.renderOptions.after.contentText } : undefined;
  };
  const lines = (e: Ed) => painted(e).flatMap((r) => ('start' in r ? [[r.start.line, r.end.line]] : []));
  const show = (...es: Ed[]) => ((window as { visibleTextEditors: unknown[] }).visibleTextEditors = es);
  const target = (start: number, end: number, reveal = true) => ({ uri: uri as never, range: { start, end }, reveal });
  afterEach(() => {
    vi.useRealTimers();
    delete config['editor.stickyScroll.enabled'];
  });

  it('edge arrows: inside the view (below sticky scroll, above a cut-off last line), none when partly visible or folded away', () => {
    const v = (...r: [number, number][]) => r.map(([a, b]) => new Range(a, 0, b, 0)) as never;
    expect(edgeArrow(v([50, 89]), 13, 17, 'Refill')).toEqual({ line: 53, text: '↑ Refill · L14–18' });
    expect(edgeArrow(v([50, 89]), 13, 17, 'Refill', 0)).toEqual({ line: 50, text: '↑ Refill · L14–18' });
    expect(edgeArrow(v([0, 39]), 120, 120)).toEqual({ line: 38, text: '↓ L121' });
    expect(edgeArrow(v([0, 39]), 120, 120, '  Refill\n   the  window ')!.text).toBe('↓ Refill the window · L121');
    expect(edgeArrow(v([0, 39]), 120, 120, 'x'.repeat(80))!.text).toBe(`↓ ${'x'.repeat(49)}… · L121`);
    expect(edgeArrow(v([0, 39]), 30, 60)).toBeUndefined();
    expect(edgeArrow(v([0, 9], [40, 49]), 20, 25)).toBeUndefined(); // in a fold between visible ranges
    expect(edgeArrow([], 1, 2)).toBeUndefined();
  });

  it('marks visible editors of that file, repaints only the arrow (and only when it changes) on scroll, and comes off only for its panel', () => {
    const a = editor(uri, 0, 39);
    const b = editor(Uri.file('/w/b.ts'));
    show(a, b);
    const d = new Decorations();
    const owner = {};
    try {
      d.setHover(owner, { ...target(101, 104, false), label: 'Refill' });
      expect(lines(a)).toEqual([[100, 103]]);
      expect(arrow(a)!.text).toBe('↓ Refill · L101–104');
      expect(arrow(a)!.line).toBe(38);
      expect(painted(b)).toEqual([]);
      expect(a.reveals).toEqual([]); // never scrolls without hoverReveal
      a.calls.length = 0;
      a.scrollTo(1, 40); // the arrow moves: only it is painted again
      expect(a.calls).toHaveLength(1);
      a.calls.length = 0;
      a.scrollTo(1, 40); // nothing changed: nothing painted
      expect(a.calls).toHaveLength(0);
      a.scrollTo(90, 129); // in view: no arrow
      expect(arrow(a)).toBeUndefined();
      a.scrollTo(150, 189);
      expect(arrow(a)!.text).toBe('↑ Refill · L101–104');
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

  it('hoverReveal scrolls an editor whose view misses the lines, and back a moment after; link to link doesn’t bounce', () => {
    vi.useFakeTimers();
    const d = new Decorations();
    const owner = {};
    try {
      const a = editor(uri, 10, 49);
      const inView = editor(uri, 100, 139);
      show(a, inView);
      d.setHover(owner, target(121, 124));
      expect(a.reveals).toEqual([[120, 2]]); // InCenterIfOutsideViewport
      expect(inView.reveals).toEqual([]);
      expect(arrow(a)).toBeUndefined(); // on its way there: no arrow
      a.scrollTo(100, 139); // the reveal's own scroll (the lines are in view)
      d.setHover(owner, undefined);
      // On to the next link before the restore: no scroll back, and the first view is still where it goes back to.
      vi.advanceTimersByTime(RESTORE_MS - 100);
      d.setHover(owner, target(171, 172));
      expect(a.reveals).toEqual([[120, 2], [170, 2]]);
      a.scrollTo(150, 189);
      d.setHover(owner, undefined);
      vi.advanceTimersByTime(RESTORE_MS - 1);
      expect(a.reveals).toHaveLength(2);
      vi.advanceTimersByTime(1);
      expect(a.reveals).toEqual([[120, 2], [170, 2], [10, 3]]); // back to its first line, AtTop
    } finally {
      d.dispose();
      show();
    }
  });

  it('hoverReveal leaves the editor where it is after a click, the reader scrolling, selecting or focusing it, or a step there', () => {
    vi.useFakeTimers();
    const d = new Decorations();
    const owner = {};
    const restored = (a: Ed) => a.reveals.some(([, type]) => type === 3);
    try {
      const run = (between: (a: Ed) => void) => {
        const a = editor(uri, 10, 49);
        show(a);
        d.setHover(owner, target(121, 124));
        a.scrollTo(100, 139);
        between(a);
        d.setHover(owner, undefined);
        vi.advanceTimersByTime(RESTORE_MS);
        return a;
      };
      expect(restored(run(() => {}))).toBe(true);
      expect(restored(run(() => d.keepHover(owner)))).toBe(false); // the link was clicked
      expect(restored(run((a) => a.scrollTo(60, 99)))).toBe(false); // the reader scrolled it away from the lines
      expect(restored(run((a) => events.selectionChanged.fire({ textEditor: a, selections: [], kind: 2 })))).toBe(false);
      expect(restored(run((a) => events.activeEditorChanged.fire(a)))).toBe(false);
      expect(restored(run(() => d.set({ uri: uri as never, range: { start: 3, end: 5 }, highlight: [], dim: false })))).toBe(false); // a step there
      // A click right after the pointer left the link (pointerdown ends the hover first): still kept.
      const a = editor(uri, 10, 49);
      show(a);
      d.setHover(owner, target(121, 124));
      a.scrollTo(100, 139);
      d.setHover(owner, undefined);
      d.keepHover(owner);
      vi.advanceTimersByTime(RESTORE_MS);
      expect(restored(a)).toBe(false);
    } finally {
      d.dispose();
      show();
    }
  });

  it('hoverReveal: the pointer leaving the panel keeps the editor scrolled until the panel is used again; another panel’s hover restores it first', () => {
    vi.useFakeTimers();
    const d = new Decorations();
    const owner = {};
    try {
      const a = editor(uri, 10, 49);
      show(a);
      d.setHover(owner, target(121, 124));
      a.scrollTo(100, 139);
      d.setHover(owner, undefined, 'left');
      vi.advanceTimersByTime(10_000);
      expect(a.reveals).toHaveLength(1); // still there, waiting for the reader
      d.setHover(owner, undefined); // back in the panel
      vi.advanceTimersByTime(RESTORE_MS);
      expect(a.reveals.at(-1)).toEqual([10, 3]);

      a.scrollTo(10, 49);
      d.setHover(owner, target(121, 124));
      a.scrollTo(100, 139);
      d.setHover({}, target(5, 6)); // another panel hovers: this panel's scroll goes back first
      expect(a.reveals.slice(-2)).toEqual([[10, 3], [4, 2]]);
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

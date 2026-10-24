// Explained here (docs/NAVIGATION-PLAN.md §7, §12.1): CodeLens, the status bar item, and the edit fan-in.
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { code, story, tempRoot, waitFor, write } from './nav-fixtures.ts';
import { config, events, executed, Range, StatusBarAlignment, statusItems, Uri, watchers, window, workspace } from './vscode-stub.ts';

vi.mock('vscode', () => import('./vscode-stub.ts'));

const { SidestoryIndex, INDEX_LIMITS } = await import('../../src/extension/nav/index.ts');
const { SidestoryWatcher } = await import('../../src/extension/nav/watcher.ts');
const { ExplainedHere, HERE_LIMITS } = await import('../../src/extension/nav/explained-here.ts');
const { PreparedTextCache } = await import('../../src/extension/prepared-cache.ts');
const { uriKey } = await import('../../src/extension/explainers.ts');

type Index = InstanceType<typeof SidestoryIndex>;
type Here = InstanceType<typeof ExplainedHere>;
const limits = INDEX_LIMITS as unknown as Record<string, number>;
const saved = { ...limits };

let root = '';
let index: Index;
let here: Here;
let sessions: FakeSession[] = [];
const owned: { dispose(): void }[] = [];

interface FakeSession {
  ref: { dir: Uri; name: string };
  panel: { visible: boolean; onDidChangeViewState: (fn: () => void) => { dispose(): void } };
  currentGeneration: number;
  resolutionsFor: (uri: string, dir: string, generation: number) => Map<string, unknown> | undefined;
}

function fakeSession(name: string, visible: boolean, overlay?: Map<string, unknown>): FakeSession {
  const dir = Uri.file(join(root, '.sidestory', name));
  return {
    ref: { dir, name },
    panel: { visible, onDidChangeViewState: () => ({ dispose() {} }) },
    currentGeneration: 1,
    resolutionsFor: () => overlay,
  };
}

/** A text document over a file's text (the version is bumped by `edit`). */
function doc(path: string, scheme = 'file') {
  let text = readFileSync(path, 'utf8');
  const d = {
    uri: scheme === 'file' ? Uri.file(path) : new Uri(scheme, path),
    version: 1,
    isClosed: false,
    isDirty: false,
    get lineCount() {
      return text.split('\n').length;
    },
    getText: () => text,
    lineAt: (n: number) => {
      const line = text.split('\n')[n] ?? '';
      return { text: line, range: { end: { line: n, character: line.length } } };
    },
    /** Only the end of the text is asked for (the size check). */
    offsetAt: () => text.length,
    setText(t: string) {
      text = t;
      d.version++;
    },
  };
  return d;
}
type Doc = ReturnType<typeof doc>;

function show(d: Doc, line = 0) {
  const editor = { document: d, selection: { active: { line } }, setDecorations() {} };
  window.visibleTextEditors = [editor];
  window.activeTextEditor = editor;
  return editor;
}

const token = { isCancellationRequested: false };
async function lensesOf(d: Doc) {
  let got = await here.provideCodeLenses(d as never, token as never);
  if (!got.length) {
    await waitFor(() => (here as unknown as { results: Map<string, { version: number }> }).results.get(uriKey(d.uri as never))?.version === d.version);
    got = await here.provideCodeLenses(d as never, token as never);
  }
  return got.map((l) => ({ line: l.range.start.line, title: l.command!.title, command: l.command!.command, args: l.command!.arguments?.[0] as Record<string, unknown> }));
}

async function start() {
  const watcher = new SidestoryWatcher();
  index = new SidestoryIndex(watcher);
  const prepared = new PreparedTextCache();
  here = new ExplainedHere(index, { sessions: () => sessions as never, prepared }, Uri.file('/ext') as never);
  owned.push(here, index, watcher, prepared);
  await index.refresh();
}

beforeAll(() => {
  limits.debounceMs = 20;
  limits.debounceMaxMs = 100;
});

beforeEach(() => {
  root = tempRoot('cx-here-');
  workspace.root = Uri.file(root);
  workspace.textDocuments = [];
  window.visibleTextEditors = [];
  window.activeTextEditor = undefined;
  sessions = [];
  statusItems.length = 0;
  for (const k of Object.keys(config)) delete config[k];
  write(join(root, 'f.ts'), code(200));
});

afterEach(() => {
  for (const d of owned.splice(0)) d.dispose();
  rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  Object.assign(limits, saved);
});

describe('CodeLens', () => {
  it('names the primary path and the step, and opens there', async () => {
    story(root, '', 'top', { title: 'Top', anchors: { t1: { file: 'f.ts', range: [100, 110] } }, details: ['det'] });
    story(root, '', 'det', { title: 'Det', anchors: { d1: { file: 'f.ts', range: [10, 12] }, d2: { file: 'f.ts', range: [20, 22], quote: 'line 20\nline 21\nline 22' } } });
    await start();
    const d = doc(join(root, 'f.ts'));
    show(d);
    const lenses = await lensesOf(d);
    expect(lenses.map((l) => [l.line, l.title])).toEqual([
      [9, '$(book) Top › Det · step 1: Step d1'],
      [19, '$(book) Top › Det · step 2: Step d2'],
      [99, '$(book) Top · step 1: Step t1'],
    ]);
    expect(lenses[0]!.command).toBe('sidestory.openAt');
    expect(lenses[0]!.args).toEqual({ dir: Uri.file(join(root, '.sidestory', 'det')).toString(), anchor: 'd1', trail: ['top', 'det'], source: 'lens' });
  });

  it('merges regions starting on one line: “and N more”, which asks which', async () => {
    story(root, '', 'a', { title: 'A', anchors: { x: { file: 'f.ts', range: [5, 9] } } });
    story(root, '', 'b', { title: 'B', anchors: { y: { file: 'f.ts', range: [5, 6] } } });
    await start();
    const d = doc(join(root, 'f.ts'));
    show(d);
    const lenses = await lensesOf(d);
    expect(lenses).toHaveLength(1);
    expect(lenses[0]!.title).toBe('$(book) B · step 1: Step y and 1 more'); // the tightest first
    expect(lenses[0]!.command).toBe('sidestory.showHere');
    // It names exactly the steps it counted, so the pick that follows lists those.
    const keys = lenses[0]!.args.keys as string[];
    expect(lenses[0]!.args).toEqual({ uri: d.uri.toString(), line: 5, keys });
    expect(here.byKeys(d.uri as never, keys).map((it) => it.entry.ref.name)).toEqual(['b', 'a']);
  });

  it('counts nested anchors of one step once', async () => {
    story(root, '', 'a', {
      title: 'A',
      anchors: { outer: { file: 'f.ts', range: [5, 9] }, inner: { file: 'f.ts', range: [5, 6] } },
      html: '<section data-explain-anchor="outer"><h2>Outer</h2><div data-explain-anchor="inner"><h3>Inner</h3></div></section>',
    });
    await start();
    const d = doc(join(root, 'f.ts'));
    show(d);
    const lenses = await lensesOf(d);
    expect(lenses).toHaveLength(1);
    expect(lenses[0]!.title).toBe('$(book) A · step 1: Outer');
    expect(lenses[0]!.command).toBe('sidestory.openAt');
  });

  it('asks VS Code again when a resolve lands after it was given nothing, even with the same lenses', async () => {
    story(root, '', 'a', { title: 'A', anchors: { a1: { file: 'f.ts', range: [5, 6], quote: 'line 5\nline 6' } } });
    await start();
    const d = doc(join(root, 'f.ts'));
    show(d);
    expect(await lensesOf(d)).toHaveLength(1);
    // A new version with the same code where it was (same lenses), resolved slowly.
    const real = index.quotesFor.bind(index);
    index.quotesFor = async (...args) => {
      await new Promise((r) => setTimeout(r, 300));
      return real(...args);
    };
    (here as unknown as { results: Map<string, { version: number }> }).results.get(uriKey(d.uri as never))!.version = -1;
    let fired = 0;
    here.onDidChangeCodeLenses(() => fired++);
    expect(await here.provideCodeLenses(d as never, token as never)).toEqual([]);
    await waitFor(() => fired > 0);
    expect(await here.provideCodeLenses(d as never, token as never)).toHaveLength(1);
  });

  it('a resolve running when the index changes is not reused: a fresh one follows', async () => {
    story(root, '', 'a', { title: 'A', anchors: { a1: { file: 'f.ts', range: [5, 6], quote: 'line 5\nline 6' } } });
    await start();
    const real = index.quotesFor.bind(index);
    let calls = 0;
    index.quotesFor = async (...args) => {
      calls++;
      await new Promise((r) => setTimeout(r, 150));
      return real(...args);
    };
    const d = doc(join(root, 'f.ts'));
    show(d);
    void here.provideCodeLenses(d as never, token as never);
    await new Promise((r) => setTimeout(r, 20));
    (here as unknown as { reresolveVisible(): void }).reresolveVisible();
    await here.provideCodeLenses(d as never, token as never);
    await waitFor(() => calls >= 2, 3000);
    expect(await lensesOf(d)).toHaveLength(1);
  });

  it('a resolve running when the index re-reads a sidestory and finds it unchanged still lands', async () => {
    story(root, '', 'a', { title: 'A', anchors: { a1: { file: 'f.ts', range: [5, 6], quote: 'line 5\nline 6' } } });
    await start();
    const real = index.quotesFor.bind(index);
    index.quotesFor = async (...args) => {
      await new Promise((r) => setTimeout(r, 200));
      return real(...args);
    };
    const d = doc(join(root, 'f.ts'));
    show(d);
    let fired = 0;
    here.onDidChangeCodeLenses(() => fired++);
    const changes: unknown[] = [];
    index.onDidChange((ev) => changes.push(ev));
    expect(await here.provideCodeLenses(d as never, token as never)).toEqual([]);
    // A watcher event for the manifest (an editor touching it): the entry's version moves, but the re-read finds the
    // same stamps, so the index says nothing changed and nobody asks for a new resolve.
    watchers.find((x) => x.pattern === '**/.sidestory/**')!.fireChange(Uri.file(join(root, '.sidestory', 'a', 'manifest.json')));
    await waitFor(() => fired > 0, 3000);
    expect(changes).toHaveLength(0);
    expect(await here.provideCodeLenses(d as never, token as never)).toHaveLength(1);
  });

  it('a resolve still running for an old version is followed by one for the new version', async () => {
    story(root, '', 'a', { title: 'A', anchors: { a1: { file: 'f.ts', range: [5, 6], quote: 'line 5\nline 6' } } });
    await start();
    const real = index.quotesFor.bind(index);
    index.quotesFor = async (...args) => {
      await new Promise((r) => setTimeout(r, 200));
      return real(...args);
    };
    const d = doc(join(root, 'f.ts'));
    show(d);
    void here.provideCodeLenses(d as never, token as never);
    d.setText(`new\n${d.getText()}`); // the running resolve is now for an old version
    await here.provideCodeLenses(d as never, token as never);
    await waitFor(() => (here as unknown as { results: Map<string, { version: number }> }).results.get(uriKey(d.uri as never))?.version === d.version, 3000);
    const lenses = await lensesOf(d);
    expect(lenses.map((l) => l.line)).toEqual([5]);
  });

  it('shows 30 lenses, then one “All N sidestory steps” lens on the next covered line', async () => {
    const anchors: Record<string, { file: string; range: [number, number] }> = {};
    for (let i = 0; i < 40; i++) anchors[`a${i}`] = { file: 'f.ts', range: [i * 4 + 1, i * 4 + 2] };
    story(root, '', 'many', { title: 'Many', anchors });
    await start();
    const d = doc(join(root, 'f.ts'));
    show(d);
    const lenses = await lensesOf(d);
    expect(lenses).toHaveLength(HERE_LIMITS.lensLines + 1);
    expect(lenses.at(-1)).toMatchObject({ line: 120, title: '$(book) All 40 sidestory steps in this file', command: 'sidestory.showHere', args: { uri: d.uri.toString(), all: true } });
  });

  it('shows nothing for lost anchors, and says when code changed a lot', async () => {
    story(root, '', 'a', { title: 'A', anchors: { gone: { file: 'f.ts', range: [5, 6], quote: 'nowhere to be found\nat all' }, ok: { file: 'f.ts', range: [30, 31] } } });
    story(root, '', 'b', { title: 'B', anchors: { s: { file: 'f.ts', range: [50, 51] } } });
    // A hidden panel shows "b" and has resolved its anchor as stale: its results are used.
    sessions = [fakeSession('b', false, new Map([['s', { state: 'stale', range: { start: 52, end: 53 }, ambiguous: false }]]))];
    await start();
    const d = doc(join(root, 'f.ts'));
    show(d);
    const lenses = await lensesOf(d);
    expect(lenses.map((l) => l.title)).toEqual(['$(book) A · step 2: Step ok', '$(book) B · step 1: Step s (code changed a lot)']);
    expect(lenses[1]!.line).toBe(51);
  });

  it('hides every anchor of a sidestory shown in a visible panel, whichever step it is on', async () => {
    story(root, '', 'a', { title: 'A', anchors: { a1: { file: 'f.ts', range: [5, 6] }, a2: { file: 'f.ts', range: [40, 41] }, a3: { file: 'f.ts', range: [80, 81] } } });
    story(root, '', 'b', { title: 'B', anchors: { b1: { file: 'f.ts', range: [60, 61] } } });
    await start();
    const d = doc(join(root, 'f.ts'));
    show(d);
    expect(await lensesOf(d)).toHaveLength(4);
    sessions = [fakeSession('a', true)];
    const before = (await lensesOf(d)).map((l) => l.title);
    expect(before).toEqual(['$(book) B · step 1: Step b1']);
    // Stepping in the panel changes nothing the lenses depend on.
    expect((await lensesOf(d)).map((l) => l.title)).toEqual(before);
  });

  it('ignores other schemes and files nobody anchors', async () => {
    story(root, '', 'a', { title: 'A', anchors: { a1: { file: 'f.ts', range: [5, 6] } } });
    write(join(root, 'g.ts'), code(5));
    await start();
    expect(await here.provideCodeLenses(doc(join(root, 'f.ts'), 'git') as never, token as never)).toEqual([]);
    expect(await here.provideCodeLenses(doc(join(root, 'g.ts')) as never, token as never)).toEqual([]);
  });

  it('answers within about 50 ms when resolving is slow, then says the lenses changed', async () => {
    story(root, '', 'a', { title: 'A', anchors: { a1: { file: 'f.ts', range: [5, 6], quote: 'line 5\nline 6' } } });
    await start();
    const real = index.quotesFor.bind(index);
    index.quotesFor = async (...args) => {
      await new Promise((r) => setTimeout(r, 400));
      return real(...args);
    };
    let fired = 0;
    here.onDidChangeCodeLenses(() => fired++);
    const d = doc(join(root, 'f.ts'));
    const t0 = performance.now();
    const first = await here.provideCodeLenses(d as never, token as never);
    expect(performance.now() - t0).toBeLessThan(150);
    expect(first).toEqual([]);
    await waitFor(() => fired > 0);
    expect(await here.provideCodeLenses(d as never, token as never)).toHaveLength(1);
  });

  it('fires onDidChangeCodeLenses only when a start line or state changes', async () => {
    story(root, '', 'a', { title: 'A', anchors: { a1: { file: 'f.ts', range: [5, 6], quote: 'line 5\nline 6' } } });
    await start();
    const d = doc(join(root, 'f.ts'));
    await lensesOf(d);
    let fired = 0;
    here.onDidChangeCodeLenses(() => fired++);
    // A new version with the anchored code where it was: no change.
    d.setText(`${d.getText()}more\n`);
    await lensesOf(d);
    expect(fired).toBe(0);
    // Two lines inserted above: the lens moves.
    d.setText(`new\nnew\n${d.getText()}`);
    expect((await lensesOf(d))[0]!.line).toBe(6);
    expect(fired).toBe(1);
  });

  it('follows the setting', async () => {
    story(root, '', 'a', { title: 'A', anchors: { a1: { file: 'f.ts', range: [5, 6] } } });
    await start();
    const d = doc(join(root, 'f.ts'));
    expect(await lensesOf(d)).toHaveLength(1);
    config['sidestory.codeLens.enabled'] = false;
    expect(await here.provideCodeLenses(d as never, token as never)).toEqual([]);
  });
});

describe('the status bar item', () => {
  const statusAfter = async () => {
    await new Promise((r) => setTimeout(r, HERE_LIMITS.cursorDelayMs + 50));
    return statusItems.at(-1);
  };

  it('names the sidestory for the cursor’s line, on the right, with a name the status bar menu shows', async () => {
    story(root, '', 'a', { title: 'A '.repeat(40).trim(), anchors: { a1: { file: 'f.ts', range: [5, 9] } } });
    await start();
    const d = doc(join(root, 'f.ts'));
    await lensesOf(d);
    show(d, 6);
    events.selectionChanged.fire({ textEditor: window.activeTextEditor });
    const item = await statusAfter();
    expect(item).toMatchObject({ alignment: StatusBarAlignment.Right, name: 'Sidestory', shown: true });
    expect(item!.text.startsWith('$(book) ')).toBe(true);
    expect(item!.text.length).toBeLessThanOrEqual('$(book) '.length + HERE_LIMITS.statusChars);
    expect(item!.text).toContain('…');
    expect(typeof item!.tooltip).toBe('string');
    expect(here.statusOpenArgs()).toMatchObject({ anchor: 'a1' });
    expect(executed.some((c) => c[0] === 'setContext' && c[1] === 'sidestory.coveredHere' && c[2] === true)).toBe(true);
  });

  it('sets sidestory.coveredHere as the cursor moves, without waiting (the context menu reads it next)', async () => {
    story(root, '', 'a', { title: 'A', anchors: { a1: { file: 'f.ts', range: [5, 9] } } });
    await start();
    const d = doc(join(root, 'f.ts'));
    show(d);
    await lensesOf(d);
    const covered = () => executed.filter((c) => c[0] === 'setContext' && c[1] === 'sidestory.coveredHere').at(-1)?.[2];
    show(d, 6);
    events.selectionChanged.fire({ textEditor: window.activeTextEditor });
    expect(covered()).toBe(true); // synchronously
    show(d, 0);
    events.selectionChanged.fire({ textEditor: window.activeTextEditor });
    expect(covered()).toBe(false);
  });

  it('skips sidestories a visible panel shows, and the details it already offers', async () => {
    story(root, '', 'top', { title: 'Top', anchors: { t1: { file: 'f.ts', range: [1, 50] } }, details: ['det'] });
    story(root, '', 'det', { title: 'Det', anchors: { d1: { file: 'f.ts', range: [5, 9] } } });
    story(root, '', 'other', { title: 'Other', anchors: { o1: { file: 'f.ts', range: [3, 30] } } });
    await start();
    const d = doc(join(root, 'f.ts'));
    await lensesOf(d);
    show(d, 6);
    sessions = [fakeSession('top', true)];
    events.selectionChanged.fire({ textEditor: window.activeTextEditor });
    const item = await statusAfter();
    expect(item!.text).toBe('$(book) Also in: Other');
    sessions = [fakeSession('other', true), fakeSession('top', true)];
    events.selectionChanged.fire({ textEditor: window.activeTextEditor });
    expect((await statusAfter())!.shown).toBe(false);
  });

  it('goes away when turned off', async () => {
    story(root, '', 'a', { title: 'A', anchors: { a1: { file: 'f.ts', range: [5, 9] } } });
    await start();
    const d = doc(join(root, 'f.ts'));
    await lensesOf(d);
    show(d, 6);
    events.selectionChanged.fire({ textEditor: window.activeTextEditor });
    expect((await statusAfter())!.shown).toBe(true);
    config['sidestory.statusBar.enabled'] = false;
    events.selectionChanged.fire({ textEditor: window.activeTextEditor });
    expect((await statusAfter())!.disposed).toBe(true);
  });
});

describe('edits', () => {
  it('a keystroke with 2,000 anchors in the file costs little (fan-in benchmark)', async () => {
    write(join(root, 'f.ts'), code(2200));
    for (let s = 0; s < 10; s++) {
      const anchors: Record<string, { file: string; range: [number, number] }> = {};
      for (let i = 0; i < 200; i++) anchors[`a${i}`] = { file: 'f.ts', range: [s * 200 + i + 1, s * 200 + i + 2] };
      story(root, '', `s${s}`, { title: `S${s}`, anchors });
    }
    await start();
    const d = doc(join(root, 'f.ts'));
    show(d);
    expect(await lensesOf(d)).toHaveLength(31);
    const items = (here as unknown as { results: Map<string, { items: { hint?: unknown }[] }> }).results.get(uriKey(d.uri as never))!.items;
    expect(items).toHaveLength(2000);
    const n = 200;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      events.documentChanged.fire({ document: d, contentChanges: [{ range: new Range(0, 0, 0, 0), text: 'x', rangeOffset: 0, rangeLength: 0 }] });
    }
    const per = (performance.now() - t0) / n;
    // A huge multi-edit doesn't track hints through every change: the re-resolve places the lenses.
    const many = Array.from({ length: HERE_LIMITS.trackedChanges + 1 }, (_, i) => ({ range: new Range(i, 0, i, 0), text: 'y', rangeOffset: 0, rangeLength: 0 }));
    events.documentChanged.fire({ document: d, contentChanges: many });
    expect(items.every((it) => it.hint === undefined)).toBe(true);
    console.log(`keystroke fan-in, 2,000 anchors: ${per.toFixed(3)} ms per event`);
    expect(per).toBeLessThan(6);
  });
});

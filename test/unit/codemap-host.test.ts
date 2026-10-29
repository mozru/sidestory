// The extension host half of code links and cursor lighting (docs/AUTHORING-PLAN.md §8.1, §8.2, §0): openCode's
// backstops, link resolution, `here`, and cursor-follow over sections only.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToWebview } from '../../src/shared/protocol.ts';
import { EventEmitter, events, fakeDocument, modal, shown, statusMessages, Uri, window, workspace, config } from './vscode-stub.ts';

vi.mock('vscode', () => import('./vscode-stub.ts'));

const { ExplainerSession } = await import('../../src/extension/session.ts');
const { refFromDir } = await import('../../src/extension/explainers.ts');
const { OpenCodeGate, checkCodePath, matchProviderSymbol, resolveLink, SymbolTables } = await import('../../src/extension/code-links.ts');

let root = '';
let outside = '';
beforeAll(() => {
  // The native real path: on Windows the temp folder may be an 8.3 short name (RUNNER~1) that only it expands.
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cx-codemap-')));
  outside = realpathSync.native(mkdtempSync(join(tmpdir(), 'cx-outside-')));
  cpSync('fixtures/sample-workspace', root, { recursive: true });
  workspace.root = Uri.file(root);
  writeFileSync(join(outside, 'leak.sv'), 'module leak; endmodule\n');
  symlinkSync(join(outside, 'leak.sv'), join(root, 'rtl/leak.sv'));
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, '.git/config'), '[core]\n');
  symlinkSync(join(root, '.git/config'), join(root, 'rtl/cfg.sv'));
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'config/secrets.json'), '{}\n');
  writeFileSync(join(root, '.env'), 'X=1\n');
  symlinkSync(join(root, '.env'), join(root, 'config/notes.txt'));
});

const panels: { dispose(): void }[] = [];
afterEach(() => {
  for (const p of panels.splice(0)) p.dispose();
  modal.answer = undefined;
  modal.asked.length = 0;
  (window as { visibleTextEditors: unknown[] }).visibleTextEditors = [];
  (window as { activeTextEditor: unknown }).activeTextEditor = undefined;
  delete config['sidestory.followCursorInDiagrams'];
});
beforeEach(() => {
  shown.length = 0;
  statusMessages.length = 0;
});

function open(name: string) {
  const ref = refFromDir(Uri.file(`${root}/.sidestory/${name}`) as never)!;
  const posted: ToWebview[] = [];
  const messages = new EventEmitter<unknown>();
  const disposed = new EventEmitter<void>();
  const viewState = new EventEmitter<void>();
  const panel = {
    visible: true,
    title: '',
    viewColumn: 2,
    webview: { html: '', cspSource: 'test:', asWebviewUri: (u: Uri) => u, onDidReceiveMessage: messages.event, postMessage: async (m: ToWebview) => posted.push(m) > 0 },
    onDidDispose: disposed.event,
    onDidChangeViewState: viewState.event,
    dispose: () => disposed.fire(),
  };
  panels.push(panel);
  const decorations = { set() {}, setWidget() {}, isDimmed: () => false, refresh() {}, flash() {}, clearFlash() {} };
  const session = new ExplainerSession([ref], panel as never, Uri.file('/ext') as never, decorations as never, { memento: { get: <T>(_k: string, d: T) => d, update: async () => {} } as never, reanchor() {} });
  const send = (m: unknown) => messages.fire(m);
  const hide = () => {
    panel.visible = false;
    viewState.fire();
  };
  return { session, posted, send, hide, panel };
}

async function ready(name: string) {
  const o = open(name);
  await o.session.load();
  o.send({ type: 'ready' });
  await vi.waitFor(() => expect((o.posted.filter((m) => m.type === 'init').at(-1) as { anchors: { state: string }[] } | undefined)?.anchors.every((a) => a.state !== 'pending')).toBe(true));
  return o;
}

const bitReader = () => fakeDocument(Uri.file(`${root}/rtl/bit_reader.sv`), readFileSync(join(root, 'rtl/bit_reader.sv'), 'utf8'));
const cursor = (doc: unknown, line1: number, kind = 2) => events.selectionChanged.fire({ textEditor: { document: doc }, selections: [{ active: { line: line1 - 1 } }], kind });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lastHere = (posted: ToWebview[]) => posted.filter((m) => m.type === 'here').at(-1);

describe('cursor-follow counts only sections (§0)', () => {
  it('before codeTargets every anchor counts; after, a ref-only anchor lights its boxes and leaves the step alone', async () => {
    const { posted, send } = await ready('bit-reader');
    const doc = bitReader();
    cursor(doc, 32); // in `consume` (31–34)
    await vi.waitFor(() => expect(posted).toContainEqual({ type: 'syncTo', anchorId: 'consume' }));
    // The page now says `consume` isn't a section, only a ref.
    send({ type: 'codeTargets', sections: ['interface', 'state', 'handshakes', 'refill'], refs: ['consume'], links: [] });
    posted.length = 0;
    cursor(doc, 36); // refill: a section
    await vi.waitFor(() => expect(posted).toContainEqual({ type: 'syncTo', anchorId: 'refill' }));
    posted.length = 0;
    cursor(doc, 32);
    await vi.waitFor(() => expect(lastHere(posted)).toEqual({ type: 'here', ref: 'consume' }));
    await sleep(200);
    expect(posted.some((m) => m.type === 'syncTo')).toBe(false);
  });

  it('a hidden panel forgets what its page linked to: every anchor counts again, and nothing is lit', async () => {
    const { posted, send, hide, panel } = await ready('bit-reader');
    send({ type: 'codeTargets', sections: ['interface'], refs: ['consume'], links: [] });
    hide();
    panel.visible = true;
    send({ type: 'ready' });
    posted.length = 0;
    cursor(bitReader(), 32);
    await vi.waitFor(() => expect(posted).toContainEqual({ type: 'syncTo', anchorId: 'consume' }));
    expect(posted.some((m) => m.type === 'here' && (m.ref || m.link))).toBe(false);
  });
});

describe('code-to-box lighting (`here`, §8.2)', () => {
  const links = ['rtl/bit_reader.sv#driver(cnt_q)', 'rtl/bit_reader.sv#L18', 'rtl/bit_reader.sv', 'rtl/bit_reader.sv#nope'];
  it('the tightest target containing the cursor lights, links and refs alike, and only changes are posted', async () => {
    const { posted, send } = await ready('bit-reader');
    send({ type: 'codeTargets', sections: ['interface', 'state', 'handshakes', 'consume', 'refill'], refs: ['state'], links });
    const doc = bitReader();
    cursor(doc, 26); // inside the always_ff, which drives cnt_q
    await vi.waitFor(() => expect(lastHere(posted)).toEqual({ type: 'here', link: 'rtl/bit_reader.sv#driver(cnt_q)' }));
    cursor(doc, 18);
    await vi.waitFor(() => expect(lastHere(posted)).toEqual({ type: 'here', link: 'rtl/bit_reader.sv#L18' }));
    cursor(doc, 16); // the `state` anchor (16–17) is tighter than the whole file
    await vi.waitFor(() => expect(lastHere(posted)).toEqual({ type: 'here', ref: 'state' }));
    const count = posted.filter((m) => m.type === 'here').length;
    cursor(doc, 17);
    await sleep(250);
    expect(posted.filter((m) => m.type === 'here').length).toBe(count);
    // Another file nothing links into: nothing lit.
    cursor(fakeDocument(Uri.file(`${root}/README.md`), 'x\n'), 1);
    await vi.waitFor(() => expect(lastHere(posted)).toEqual({ type: 'here' }));
  });

  it('lights at once when the targets arrive, from where the cursor already is; off with the setting', async () => {
    const { posted, send } = await ready('bit-reader');
    const doc = bitReader();
    (window as { activeTextEditor: unknown }).activeTextEditor = { document: doc, selection: { active: { line: 17 } } };
    send({ type: 'codeTargets', sections: [], refs: [], links });
    await vi.waitFor(() => expect(lastHere(posted)).toEqual({ type: 'here', link: 'rtl/bit_reader.sv#L18' }));
    config['sidestory.followCursorInDiagrams'] = false;
    events.configurationChanged.fire({ affectsConfiguration: (s: string) => s === 'sidestory.followCursorInDiagrams' });
    await vi.waitFor(() => expect(lastHere(posted)).toEqual({ type: 'here' }));
    cursor(doc, 26);
    await sleep(250);
    expect(lastHere(posted)).toEqual({ type: 'here' });
  });
});

describe('openCode (§8.1)', () => {
  it('opens a symbol at its first line, and the box it came from lights', async () => {
    const { send, posted } = await ready('bit-reader');
    send({ type: 'codeTargets', sections: [], refs: [], links: ['rtl/bit_reader.sv#driver(cnt_q)'] });
    send({ type: 'openCode', path: 'rtl/bit_reader.sv', target: 'driver(cnt_q)' });
    await vi.waitFor(() => expect(shown).toHaveLength(1));
    expect(shown[0]!.document.uri.fsPath).toBe(Uri.file(join(root, 'rtl/bit_reader.sv')).fsPath);
    expect((shown[0]!.editor.selection as { start: { line: number } }).start.line).toBe(22);
    await vi.waitFor(() => expect(lastHere(posted)).toEqual({ type: 'here', link: 'rtl/bit_reader.sv#driver(cnt_q)' }));
  });

  it('lines and whole files; a missing target says so in the status bar and opens nothing', async () => {
    const { send } = await ready('bit-reader');
    send({ type: 'openCode', path: 'rtl/bit_reader.sv', target: 'L5-L7' });
    await vi.waitFor(() => expect(shown).toHaveLength(1));
    expect((shown[0]!.editor.selection as { start: { line: number } }).start.line).toBe(4);
    send({ type: 'openCode', path: 'rtl/bit_reader.sv' });
    await vi.waitFor(() => expect(shown).toHaveLength(2));
    send({ type: 'openCode', path: 'rtl/bit_reader.sv', target: 'i_order_q' });
    send({ type: 'openCode', path: 'rtl/bit_reader.sv', target: 'L900' });
    await vi.waitFor(() => expect(statusMessages.filter((s) => s.includes('not found'))).toHaveLength(2));
    expect(statusMessages).toContain('“i_order_q” not found in bit_reader.sv');
    expect(shown).toHaveLength(2);
  });

  it('identical requests within 300 ms are one; at most 10 a second, checked before any file is touched', async () => {
    const { send } = await ready('bit-reader');
    send({ type: 'openCode', path: 'rtl/bit_reader.sv', target: 'L3' });
    send({ type: 'openCode', path: 'rtl/bit_reader.sv', target: 'L3' });
    await sleep(300);
    expect(shown).toHaveLength(1);
    shown.length = 0;
    await sleep(1000);
    for (let i = 1; i <= 15; i++) send({ type: 'openCode', path: 'rtl/bit_reader.sv', target: `L${i}` });
    await sleep(500);
    expect(shown).toHaveLength(10);
  });

  it('refuses links out of the repository and into .git, and schema-invalid paths never arrive', async () => {
    const { send } = await ready('bit-reader');
    send({ type: 'openCode', path: 'rtl/leak.sv' });
    send({ type: 'openCode', path: 'rtl/cfg.sv' });
    send({ type: 'openCode', path: '.git/config' });
    send({ type: 'openCode', path: '../outside/leak.sv' });
    send({ type: 'openCode', path: 'rtl/bit_reader.sv', target: 'L0' });
    await sleep(300);
    expect(shown).toHaveLength(0);
    expect([...statusMessages].sort()).toEqual(["Can't open cfg.sv: it is inside .git.", "Can't open leak.sv: it isn't a file inside the repository."]);
  });

  it('asks before opening a secret-looking file, by the link\'s name or the real file\'s', async () => {
    const { send } = await ready('bit-reader');
    send({ type: 'openCode', path: 'config/secrets.json' });
    await vi.waitFor(() => expect(modal.asked).toEqual(['This sidestory links to secrets.json. Open it?']));
    await sleep(100);
    expect(shown).toHaveLength(0);
    send({ type: 'openCode', path: 'config/notes.txt' }); // a link to .env
    await vi.waitFor(() => expect(modal.asked).toHaveLength(2));
    expect(shown).toHaveLength(0);
    modal.answer = 'Open';
    await sleep(350);
    send({ type: 'openCode', path: 'config/secrets.json' });
    await vi.waitFor(() => expect(shown).toHaveLength(1));
  });
});

describe('the first step at open', () => {
  it('with no editor open, the step the page chose shows its code; with one open, nothing takes the editor over', async () => {
    const { send } = await ready('bit-reader');
    (window as { visibleTextEditors: unknown[] }).visibleTextEditors = [{ viewColumn: 1, document: bitReader() }];
    send({ type: 'focusAnchor', anchorId: 'interface', source: 'initial' });
    await sleep(200);
    expect(shown).toHaveLength(0);
    (window as { visibleTextEditors: unknown[] }).visibleTextEditors = [{ viewColumn: undefined }]; // an output pane isn't a code editor
    send({ type: 'focusAnchor', anchorId: 'interface', source: 'initial' });
    await vi.waitFor(() => expect(shown).toHaveLength(1));
  });

  it('reveals once the step resolves when the page asked before it did', async () => {
    const o = open('bit-reader');
    o.send({ type: 'ready' }); // init before anything is loaded
    o.send({ type: 'focusAnchor', anchorId: 'interface', source: 'initial' }); // unknown yet: ignored
    await o.session.load();
    o.send({ type: 'focusAnchor', anchorId: 'interface', source: 'initial' });
    await vi.waitFor(() => expect(shown).toHaveLength(1));
  });
});

describe('review round 1', () => {
  it('a document closed and opened again (version 1 again, other text) gets a new table, not the old one', async () => {
    const tables = new SymbolTables();
    const uri = Uri.file(`${root}/rtl/x.sv`);
    const before = fakeDocument(uri, 'module a; logic one; endmodule\n');
    expect(await resolveLink(before as never, { path: 'rtl/x.sv', target: 'one' }, tables, false)).toMatchObject({ ok: true });
    events.documentClosed.fire(before);
    const after = fakeDocument(uri, '\n\nmodule a; logic two; endmodule\n');
    expect(await resolveLink(after as never, { path: 'rtl/x.sv', target: 'one' }, tables, false)).toMatchObject({ ok: false });
    expect(await resolveLink(after as never, { path: 'rtl/x.sv', target: 'two' }, tables, false)).toEqual({ ok: true, range: { start: 3, end: 3 } });
    // a new document object with the same version (no close event seen) isn't trusted either
    const again = fakeDocument(uri, 'module a; logic three; endmodule\n');
    expect(await resolveLink(again as never, { path: 'rtl/x.sv', target: 'three' }, tables, false)).toMatchObject({ ok: true });
    tables.dispose();
  });

  it('codeTargets from the page of the sidestory shown before are ignored while the next one loads', async () => {
    const { posted, send, session } = await ready('bit-reader');
    void session.show([refFromDir(Uri.file(`${root}/.sidestory/overview`) as never)!]);
    send({ type: 'codeTargets', sections: [], refs: ['consume'], links: [] }); // the old page, mid-switch
    await vi.waitFor(() => expect(posted.filter((m) => m.type === 'init').at(-1)).toMatchObject({ dir: expect.stringMatching(/overview$/) }));
    // Until the new page reports, every anchor counts for cursor-follow (no sections list from the old page).
    expect((session as unknown as { targets: unknown }).targets).toBeUndefined();
  });

  it('a link to a file over 10 MB opens nothing', async () => {
    writeFileSync(join(root, 'rtl/huge.sv'), Buffer.alloc(10_000_001, 0x20));
    const { send } = await ready('bit-reader');
    send({ type: 'openCode', path: 'rtl/huge.sv' });
    await vi.waitFor(() => expect(statusMessages).toEqual(["Can't open huge.sv: it is larger than 10 MB."]));
    expect(shown).toHaveLength(0);
  });
});

describe('code-links helpers', () => {
  it('OpenCodeGate: dedupe and the per-second cap', () => {
    const g = new OpenCodeGate();
    expect(g.allow('a', 0)).toBe(true);
    expect(g.allow('a', 100)).toBe(false);
    expect(g.allow('a', 400)).toBe(true);
    for (let i = 0; i < 8; i++) expect(g.allow(`b${i}`, 500 + i)).toBe(true);
    expect(g.allow('c', 600)).toBe(false);
    expect(g.allow('c', 1500)).toBe(true);
  });
  it('checkCodePath', async () => {
    expect(await checkCodePath(root, 'rtl/bit_reader.sv')).toMatchObject({ ok: true, real: join(root, 'rtl/bit_reader.sv'), secret: false, direct: true });
    // a symlink inside the repository to another file in it: allowed, but opened by its real path
    expect(await checkCodePath(root, 'config/notes.txt')).toMatchObject({ ok: true, real: join(root, '.env'), direct: false });
    expect((await checkCodePath(root, 'rtl')).ok).toBe(false);
    expect((await checkCodePath(root, 'rtl/missing.sv')).ok).toBe(false);
    expect(await checkCodePath(root, 'config/notes.txt')).toMatchObject({ ok: true, secret: true });
  });
  it('matchProviderSymbol: the whole chain, else a unique suffix', () => {
    const syms = [
      { chain: ['RetryClient'], range: { start: 1, end: 20 } },
      { chain: ['RetryClient', 'send'], range: { start: 5, end: 9 } },
      { chain: ['Other', 'send'], range: { start: 30, end: 31 } },
      { chain: ['send'], range: { start: 40, end: 41 } },
    ];
    expect(matchProviderSymbol(syms, 'RetryClient.send')).toEqual({ ok: true, range: { start: 5, end: 9 } });
    expect(matchProviderSymbol(syms, 'send')).toEqual({ ok: true, range: { start: 40, end: 41 } });
    expect(matchProviderSymbol(syms, 'RetryClient')).toEqual({ ok: true, range: { start: 1, end: 20 } });
    expect(matchProviderSymbol(syms.slice(0, 3), 'send').ok).toBe(false);
    expect(matchProviderSymbol(syms, 'nope').ok).toBe(false);
  });
  it('resolveLink: non-SV symbols ask the provider only when allowed', async () => {
    const tables = new SymbolTables();
    const doc = fakeDocument(Uri.file(`${root}/src/x.ts`), 'a\nb\nc\n');
    expect(await resolveLink(doc as never, { path: 'src/x.ts', target: 'Foo.bar' }, tables, false)).toMatchObject({ ok: false, unavailable: true });
    expect(await resolveLink(doc as never, { path: 'src/x.ts', target: 'L2-L9' }, tables, false)).toEqual({ ok: true, range: { start: 2, end: 4 } });
    expect(await resolveLink(doc as never, { path: 'src/x.ts' }, tables, false)).toEqual({ ok: true, range: { start: 1, end: 4 } });
    tables.dispose();
  });
});

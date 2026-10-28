// A sidestory's `highlight` (manifest) and an anchor's `dim`: parsed leniently, and applied under the reader's own
// settings (src/extension/highlight-options.ts), per panel.
import { cpSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseHighlight, parseManifest } from '../../src/core/manifest.ts';
import type { ToWebview } from '../../src/shared/protocol.ts';
import { config, EventEmitter, events, Uri, watchers, workspace } from './vscode-stub.ts';

vi.mock('vscode', () => import('./vscode-stub.ts'));

const { effectiveHighlight, HIGHLIGHT_DEFAULTS } = await import('../../src/extension/highlight-options.ts');
const { ExplainerSession } = await import('../../src/extension/session.ts');
const { refFromDir } = await import('../../src/extension/explainers.ts');

const KEYS = ['sidestory.dimUnfocused', 'sidestory.clickHighlightSeconds', 'sidestory.clickFrame', 'sidestory.hoverPreview'];
afterEach(() => {
  for (const k of KEYS) delete config[k];
});

const manifest = (top: Record<string, unknown>, anchor: Record<string, unknown> = {}) =>
  JSON.stringify({ version: 1, title: 'T', ...top, anchors: { a: { file: 'x.ts', range: [1, 2], ...anchor } } });

describe('highlight in the manifest', () => {
  it('reads the four keys, each of its type', () => {
    const p = parseManifest(manifest({ highlight: { dim: false, clickSeconds: 3, clickFrame: false, hoverPreview: 'both' } }, { dim: true }));
    expect(p.ok && p.diagnostics).toEqual([]);
    expect(p.ok && p.manifest.highlight).toEqual({ dim: false, clickSeconds: 3, clickFrame: false, hoverPreview: 'both' });
    expect(p.ok && p.manifest.anchors.get('a')!.dim).toBe(true);
    const none = parseManifest(manifest({}));
    expect(none.ok && none.manifest.highlight).toBeUndefined();
    expect(none.ok && 'dim' in none.manifest.anchors.get('a')!).toBe(false);
  });

  it('drops wrong types with a diagnostic, and the rest still apply; the manifest still loads', () => {
    const p = parseManifest(manifest({ highlight: { dim: 'no', clickSeconds: '3', clickFrame: 1, hoverPreview: 'sideways' } }, { dim: 0 }));
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.manifest.highlight).toEqual({});
    expect(p.manifest.anchors.get('a')).toBeDefined();
    expect(p.manifest.anchors.get('a')!.dim).toBeUndefined();
    expect(p.diagnostics.map((d) => d.message)).toEqual([
      'highlight: dim must be true or false; ignored',
      'highlight: clickSeconds must be a number of seconds from 0 to 3600 (0 keeps it until the next one); ignored',
      'highlight: clickFrame must be true or false; ignored',
      'highlight: hoverPreview must be "card", "editor", "both", "off"; ignored',
      'dim: must be true or false; ignored',
    ]);
    expect(p.diagnostics.at(-1)!.anchor).toBe('a');
    for (const bad of [[], 'dim', null, 3]) expect(parseHighlight(bad)).toEqual({ errors: ['must be an object like {"dim": false}; ignored'] });
  });

  it('clamps clickSeconds above 3600, refuses negative and non-finite ones', () => {
    expect(parseHighlight({ clickSeconds: 1e9 })).toEqual({ value: { clickSeconds: 3600 }, errors: ['clickSeconds is more than 3600; 3600 is used'] });
    expect(parseHighlight({ clickSeconds: 0 })).toEqual({ value: { clickSeconds: 0 }, errors: [] });
    expect(parseHighlight({ clickSeconds: -1 }).value).toEqual({});
    expect(JSON.parse('{"x": 1e999}').x).toBe(Infinity);
    expect(parseHighlight({ clickSeconds: Infinity }).value).toEqual({});
  });

  it('names unknown keys (at most five, cut short) and ignores them', () => {
    expect(parseHighlight({ dim: true, color: 'red' })).toEqual({ value: { dim: true }, errors: ['unknown key "color" (known: dim, clickSeconds, clickFrame, hoverPreview); ignored'] });
    const many = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`${'k'.repeat(50)}${i}`, 1]));
    const [e] = parseHighlight(many).errors;
    expect(e).toContain('and 2 more');
    expect(e).toContain(`"${'k'.repeat(40)}"`);
    expect(e).not.toContain('k'.repeat(41));
  });
});

describe('effectiveHighlight', () => {
  it('defaults, then the sidestory, then the step (dim), then the reader’s own setting', () => {
    expect(effectiveHighlight()).toEqual(HIGHLIGHT_DEFAULTS);
    expect(effectiveHighlight({ dim: false, clickSeconds: 3, clickFrame: false, hoverPreview: 'both' })).toEqual({ dim: false, clickSeconds: 3, clickFrame: false, hoverPreview: 'both' });
    expect(effectiveHighlight({ dim: false }, { dim: true }).dim).toBe(true);
    expect(effectiveHighlight({ dim: true }, { dim: false }).dim).toBe(false);
    expect(effectiveHighlight({ dim: true }, {}).dim).toBe(true);
    config['sidestory.dimUnfocused'] = true;
    config['sidestory.clickHighlightSeconds'] = 0;
    config['sidestory.clickFrame'] = true;
    config['sidestory.hoverPreview'] = 'off';
    expect(effectiveHighlight({ dim: false, clickSeconds: 3, clickFrame: false, hoverPreview: 'both' }, { dim: false })).toEqual({ dim: true, clickSeconds: 0, clickFrame: true, hoverPreview: 'off' });
  });

  it('skips a reader’s value of the wrong type, and clamps theirs too', () => {
    config['sidestory.hoverPreview'] = 'sideways';
    config['sidestory.clickHighlightSeconds'] = 'abc';
    expect(effectiveHighlight({ hoverPreview: 'editor' })).toMatchObject({ hoverPreview: 'editor', clickSeconds: 1.5 });
    config['sidestory.clickHighlightSeconds'] = 99_999;
    expect(effectiveHighlight().clickSeconds).toBe(3600);
  });
});

describe('a panel', () => {
  let root = '';
  let dir = '';
  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cx-hl-')));
    cpSync('fixtures/sample-workspace', root, { recursive: true });
    workspace.root = Uri.file(root);
    dir = join(root, '.sidestory/bit-reader');
  });
  const panels: { dispose(): void }[] = [];
  afterEach(() => {
    for (const p of panels.splice(0)) p.dispose();
  });

  const writeManifest = (edit: (m: { title?: string; highlight?: unknown; anchors: Record<string, Record<string, unknown>> }) => void) => {
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    edit(m);
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m));
  };

  async function open(at = dir) {
    const ref = refFromDir(Uri.file(at) as never)!;
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
    const focus: { dim: boolean }[] = [];
    const flashes: unknown[] = [];
    const decorations = { set: (f: { dim: boolean } | undefined) => f && focus.push(f), setWidget() {}, isDimmed: () => focus.at(-1)?.dim ?? false, refresh() {}, flash: (_e: unknown, _r: unknown, o: unknown) => flashes.push(o), clearFlash() {}, setHover() {} };
    const session = new ExplainerSession([ref], panel as never, Uri.file('/ext') as never, decorations as never, { memento: { get: <T>(_k: string, d: T) => d, update: async () => {} } as never, reanchor() {} });
    await session.load();
    messages.fire({ type: 'ready' });
    await vi.waitFor(() => expect((posted.filter((m) => m.type === 'init').at(-1) as { anchors: { state: string }[] } | undefined)?.anchors.every((a) => a.state !== 'pending')).toBe(true));
    const settings = () => posted.filter((m) => m.type === 'settings').at(-1);
    return { session, posted, send: (m: unknown) => messages.fire(m), focus, flashes, settings };
  }

  it('sends the page the sidestory’s hover mode, and the click highlight and step fading use its values', async () => {
    writeManifest((m) => {
      m.highlight = { dim: false, clickSeconds: 4, clickFrame: false, hoverPreview: 'both' };
      m.anchors.state!.dim = true;
    });
    const { session, send, focus, flashes, settings } = await open();
    expect(settings()).toEqual({ type: 'settings', hoverPreview: 'both' });
    expect(session.highlightFor()).toEqual({ dim: false, clickSeconds: 4, clickFrame: false, hoverPreview: 'both' });

    send({ type: 'focusAnchor', anchorId: 'interface', source: 'click' });
    await vi.waitFor(() => expect(focus.length).toBeGreaterThan(0));
    expect(focus.at(-1)!.dim).toBe(false);
    send({ type: 'focusAnchor', anchorId: 'state', source: 'click' }); // its own dim wins
    await vi.waitFor(() => expect(focus.at(-1)!.dim).toBe(true));

    send({ type: 'codeTargets', sections: [], refs: [], links: ['rtl/bit_reader.sv#L3-L5'] });
    send({ type: 'openCode', path: 'rtl/bit_reader.sv', target: 'L3-L5' });
    await vi.waitFor(() => expect(flashes).toEqual([{ seconds: 4, frame: false }]));

    // The reader's own setting wins, and reaches the page.
    config['sidestory.hoverPreview'] = 'off';
    events.configurationChanged.fire({ affectsConfiguration: (k: string) => k === 'sidestory.hoverPreview' });
    expect(settings()).toEqual({ type: 'settings', hoverPreview: 'off' });
  });

  it('a manifest edit updates the values, and the page gets the new hover mode', async () => {
    const { session, posted, settings } = await open();
    expect(settings()).toEqual({ type: 'settings', hoverPreview: 'card' });
    expect(session.highlightFor()).toEqual(HIGHLIGHT_DEFAULTS);
    writeManifest((m) => {
      m.highlight = { hoverPreview: 'editor', clickSeconds: 10 };
    });
    for (const w of watchers.filter((x) => (x.pattern as { base?: { fsPath?: string } }).base?.fsPath === Uri.file(dir).fsPath)) w.fireChange(Uri.file(join(dir, 'manifest.json')));
    await vi.waitFor(() => expect(settings()).toEqual({ type: 'settings', hoverPreview: 'editor' }));
    expect(session.highlightFor()).toMatchObject({ hoverPreview: 'editor', clickSeconds: 10, dim: true });
    const sent = posted.filter((m) => m.type === 'settings').length;
    writeManifest((m) => {
      m.title = 'Renamed';
    });
    for (const w of watchers) w.fireChange(Uri.file(join(dir, 'manifest.json')));
    await vi.waitFor(() => expect(posted.some((m) => m.type === 'content' && m.title === 'Renamed')).toBe(true));
    expect(posted.filter((m) => m.type === 'settings').length).toBe(sent); // unchanged: not sent again
  });

  it('a dive uses the detail’s values, and Back the overview’s again', async () => {
    writeManifest((m) => {
      m.highlight = { hoverPreview: 'both', clickSeconds: 7 };
    });
    const { session, send, settings } = await open(join(root, '.sidestory/overview'));
    expect(settings()).toEqual({ type: 'settings', hoverPreview: 'card' });
    send({ type: 'dive', name: 'bit-reader' });
    await vi.waitFor(() => expect(settings()).toEqual({ type: 'settings', hoverPreview: 'both' }));
    expect(session.highlightFor().clickSeconds).toBe(7);
    send({ type: 'goTo', depth: 0 });
    await vi.waitFor(() => expect(settings()).toEqual({ type: 'settings', hoverPreview: 'card' }));
    expect(session.highlightFor().clickSeconds).toBe(1.5);
  });
});

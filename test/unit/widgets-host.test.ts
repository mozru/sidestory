// The rules behind widgets in the extension and the panel that need no browser or VS Code: consent hashing
// and the git re-ask rule, what useAnchorCode may serve, state caps, the activation evidence, the watchdog's
// escalation, and the extension's view of placeholders in explainer.html.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Anchor } from '../../src/core/manifest.ts';
import type { Resolution } from '../../src/core/resolve.ts';
import { decideCodeAccess, matchedInFull, quoteIn, type CodeAccessInput } from '../../src/extension/widgets/code-access.ts';
import { acknowledge, contentHash, decideConsent, EMPTY_CONSENT, type WidgetFile } from '../../src/extension/widgets/consent.ts';
import { anchorsRead, scanWidgets, widgetSources } from '../../src/extension/widgets/html.ts';
import { Escalations, HeartbeatWatchdog } from '../../src/extension/widgets/watchdog.ts';
import { WIDGET_BOOTSTRAP } from '../../src/shared/widget-bootstrap.ts';
import { ActivationEvidence, rayHits } from '../../src/webview/activation.ts';
import { closeWidgetTags } from '../../src/webview/sanitize.ts';
import { MAX_STATE_PER_PANEL, MAX_STATE_PER_WIDGET, WidgetStates } from '../../src/webview/widget-state.ts';

describe('consent', () => {
  const file = (path: string, hash: string, git: WidgetFile['git'] = { kind: 'none' }): WidgetFile => ({ path, hash, git });
  /** Git's view: the blob at HEAD, and the content hash of HEAD's text (null when not in HEAD). */
  const repo = (headBlob: string | null, headHash: string | null = headBlob) => ({ kind: 'repo' as const, headBlob, headHash });

  it('asks before the first run in a workspace', () => {
    expect(decideConsent(EMPTY_CONSENT, [file('a.tsx', 'h1')])).toMatchObject({ ask: true });
  });

  it('hashes the exact bytes, with line endings normalized', () => {
    expect(contentHash(new TextEncoder().encode('a\r\nb'))).toBe(contentHash('a\nb'));
    expect(contentHash(new TextEncoder().encode('é'))).toBe(contentHash('é'));
    expect(contentHash('a')).not.toBe(contentHash('b'));
  });

  it('without git, consent is per workspace: changed code is recorded as the user’s own', () => {
    const rec = acknowledge(EMPTY_CONSENT, [file('a.tsx', 'h1')], true);
    const d = decideConsent(rec, [file('a.tsx', 'h2'), file('b.tsx', 'h3')]);
    expect(d.ask).toBe(false);
    expect(d.observed.map((f) => f.path)).toEqual(['a.tsx', 'b.tsx']);
  });

  it('a .git the git extension doesn’t know: changed code always asks, unchanged code doesn’t', () => {
    const rec = acknowledge(EMPTY_CONSENT, [file('a.tsx', 'h1', { kind: 'unknown' })], true);
    expect(decideConsent(rec, [file('a.tsx', 'h1', { kind: 'unknown' })]).ask).toBe(false);
    expect(decideConsent(rec, [file('a.tsx', 'h2', { kind: 'unknown' })])).toMatchObject({ ask: true, changed: ['a.tsx'] });
  });

  it('git: new code after git’s own version of the file changed asks; edits while it stays put are the user’s', () => {
    const rec = acknowledge(EMPTY_CONSENT, [file('a.tsx', 'h1', repo('b1', 'h1'))], true);
    // Edited in the working tree: recorded, no question.
    const edit = decideConsent(rec, [file('a.tsx', 'h2', repo('b1', 'h1'))]);
    expect(edit).toMatchObject({ ask: false });
    expect(edit.observed).toHaveLength(1);
    // A checkout or pull: git's blob changed, and the new bytes came with it.
    expect(decideConsent(rec, [file('a.tsx', 'h3', repo('b3', 'h3'))])).toMatchObject({ ask: true, changed: ['a.tsx'] });
    // The user reverted their own edit: git's blob didn't change, so theirs.
    expect(decideConsent(rec, [file('a.tsx', 'h9', repo('b1', 'h1'))]).ask).toBe(false);
  });

  it('git: working-tree bytes that differ from git’s (CRLF checkout, ident or smudge filters, a symlink) still ask after a pull', () => {
    const rec = acknowledge(EMPTY_CONSENT, [file('a.tsx', 'h1', repo('b1', 'h1'))], true);
    // HEAD's text decodes to something else than the working tree (filters), but git's blob moved: asks.
    expect(decideConsent(rec, [file('a.tsx', 'h2-expanded', repo('b2', 'h2'))])).toMatchObject({ ask: true, changed: ['a.tsx'] });
    // The text couldn't even be compared (invalid UTF-8, LFS pointer): asks.
    expect(decideConsent(rec, [file('a.tsx', 'h2', repo('b2', null))]).ask).toBe(true);
  });

  it('git: committing already-observed edits doesn’t ask, then or at the next edit', () => {
    let rec = acknowledge(EMPTY_CONSENT, [file('a.tsx', 'h1', repo('b1', 'h1'))], true);
    rec = acknowledge(rec, decideConsent(rec, [file('a.tsx', 'h2', repo('b1', 'h1'))]).observed, false);
    // Committed: git's blob is now the acknowledged code.
    const committed = decideConsent(rec, [file('a.tsx', 'h2', repo('b2', 'h2'))]);
    expect(committed.ask).toBe(false);
    // Edited again without anything seeing the commit: still the user's.
    expect(decideConsent(rec, [file('a.tsx', 'h3', repo('b2', 'h2'))]).ask).toBe(false);
    rec = acknowledge(rec, committed.observed, false);
    expect(decideConsent(rec, [file('a.tsx', 'h3', repo('b2', 'h2'))]).ask).toBe(false);
  });

  it('git: a file never seen that is in HEAD (a pull brought a new widget, or a clone) asks as new; a new untracked file doesn’t', () => {
    const rec = acknowledge(EMPTY_CONSENT, [file('a.tsx', 'h1', repo('b1', 'h1'))], true);
    expect(decideConsent(rec, [file('new.tsx', 'n1', repo('nb', 'n1'))])).toMatchObject({ ask: true, changed: [], added: ['new.tsx'] });
    expect(decideConsent(rec, [file('new.tsx', 'n1', repo(null))]).ask).toBe(false);
  });

  it('records from before git blobs were kept ask once', () => {
    const rec = { granted: true, files: { 'a.tsx': { hash: 'h1' } } };
    expect(decideConsent(rec, [file('a.tsx', 'h2', repo('b1', 'h0'))]).ask).toBe(true);
    expect(decideConsent(rec, [file('a.tsx', 'h1', repo('b1', 'h1'))]).ask).toBe(false);
  });

  it('keeps the most recent acknowledged files', () => {
    let rec = acknowledge(EMPTY_CONSENT, Array.from({ length: 4990 }, (_, i) => file(`f${i}`, 'h')), true);
    for (let i = 4990; i < 5100; i++) rec = acknowledge(rec, [file(`f${i}`, 'h')], false);
    expect(Object.keys(rec.files)).toHaveLength(5000);
    expect(rec.files.f5099).toBeDefined();
    expect(rec.files.f0).toBeUndefined();
  });
});

describe('what widgets may read (useAnchorCode)', () => {
  const lines = ['export function f() {', '  const secret = 1;', '  return secret;', '}', ''];
  const anchor = (over: Partial<Anchor> = {}): Anchor => ({
    id: 'a', file: 'src/f.ts', range: { start: 1, end: 4 }, highlight: [],
    quote: { exact: lines.slice(0, 4).join('\n'), prefix: '', suffix: '', norm: 'ws' }, ...over,
  });
  const full: Resolution = { state: 'exact', range: { start: 1, end: 4 }, location: 1, similarity: 1, ambiguous: false, method: 'exact' };
  const changed: Resolution = { state: 'changed', range: { start: 1, end: 4 }, location: 1, similarity: 0.9, ambiguous: false, method: 'fuzzy' };
  const input = (over: Partial<CodeAccessInput> = {}): CodeAccessInput => ({
    anchor: anchor(), resolution: full, lines, realName: 'f.ts', quoteAtHead: true, confirmed: false,
    git: { kind: 'repo', tracked: true, ignored: false, headText: lines.join('\n') }, language: 'typescript', ...over,
  });
  const reason = (over: Partial<CodeAccessInput>) => decideCodeAccess(input(over)).reason;

  it('serves a pinned, committed quote matched in full', () => {
    expect(decideCodeAccess(input())).toEqual({ anchor: 'a', status: 'ok', text: lines.slice(0, 4).join('\n'), startLine: 1, language: 'typescript', state: 'exact' });
  });

  it('refuses range-only, v1 snippet and case-insensitive quotes as not pinned', () => {
    expect(reason({ anchor: anchor({ quote: undefined }) })).toBe('not-pinned');
    expect(reason({ anchor: anchor({ quote: undefined, snippet: 'export function f' }) })).toBe('not-pinned');
    expect(reason({ anchor: anchor({ quote: { ...anchor().quote!, norm: 'ws-ci' } }) })).toBe('not-pinned');
  });

  it('a quote neither committed at HEAD nor confirmed is unconfirmed; a confirmed one is served', () => {
    expect(reason({ quoteAtHead: false })).toBe('unconfirmed');
    expect(decideCodeAccess(input({ quoteAtHead: false, confirmed: true })).status).toBe('ok');
  });

  it('never secret-looking files: by the anchor path or the real file’s name (symlinks)', () => {
    expect(reason({ anchor: anchor({ file: 'config/.env.local' }) })).toBe('secret-file');
    expect(reason({ anchor: anchor({ file: 'src/deploy.key' }) })).toBe('secret-file');
    // A quote shaped like ordinary code, over a link whose target holds secrets.
    expect(reason({ realName: 'credentials.json' })).toBe('secret-file');
  });

  it('an ignored file is refused also when the code matched only approximately', () => {
    // A symlinked anchor file whose target git ignores: git is asked about the target (host.ts), and the
    // approximate path checks `ignored` too.
    expect(reason({ resolution: changed, git: { kind: 'repo', tracked: true, ignored: true, headText: 'password:' }, quoteAtHead: true })).toBe('ignored');
  });

  it('lost, too large, and ignored files are refused', () => {
    expect(reason({ resolution: { ...full, state: 'lost', range: null } })).toBe('lost');
    expect(reason({ resolution: { ...full, range: { start: 1, end: 2500 } } })).toBe('too-large');
    expect(reason({ git: { kind: 'repo', tracked: false, ignored: true, headText: null } })).toBe('ignored');
    expect(reason({ git: { kind: 'unknown' } })).toBe('ignored');
    // Untracked but not ignored, and no repository at all: the current text is served.
    expect(decideCodeAccess(input({ git: { kind: 'repo', tracked: false, ignored: false, headText: null } })).status).toBe('ok');
    expect(decideCodeAccess(input({ git: { kind: 'none' } })).status).toBe('ok');
  });

  it('changed or stale code is served only from tracked files whose HEAD text holds the quote exactly', () => {
    expect(decideCodeAccess(input({ resolution: changed })).status).toBe('ok');
    expect(reason({ resolution: changed, git: { kind: 'repo', tracked: true, ignored: false, headText: 'something else' } })).toBe('changed-since-commit');
    expect(reason({ resolution: changed, git: { kind: 'repo', tracked: false, ignored: false, headText: null } })).toBe('changed-untracked');
    expect(reason({ resolution: changed, git: { kind: 'none' } })).toBe('changed-untracked');
  });

  it('knows which matches are full', () => {
    expect(matchedInFull(full)).toBe(true);
    expect(matchedInFull({ ...full, method: 'hint' })).toBe(true);
    expect(matchedInFull({ ...full, method: 'fuzzy', similarity: 1 })).toBe(true);
    expect(matchedInFull(changed)).toBe(false);
    expect(matchedInFull({ ...full, method: 'range' })).toBe(false);
    expect(quoteIn('a\n  b  \nc', 'b\nc')).toBe(true);
    expect(quoteIn('a\nb', 'b\nc')).toBe(false);
  });
});

describe('widget state caps (panel)', () => {
  it('refuses a widget’s state over 64 KB', () => {
    const s = new WidgetStates();
    expect(s.set('k', 'x'.repeat(MAX_STATE_PER_WIDGET + 1))).toBe(false);
    expect(s.get('k')).toBeNull();
    expect(s.set('k', 'x'.repeat(MAX_STATE_PER_WIDGET - 10))).toBe(true);
  });

  it('keeps at most 256 KB per panel, dropping the least recently used', () => {
    const s = new WidgetStates();
    for (let i = 0; i < 5; i++) s.set(`w${i}`, 'x'.repeat(60_000));
    expect(s.bytes).toBeLessThanOrEqual(MAX_STATE_PER_PANEL);
    expect(s.get('w0')).toBeNull();
    expect(s.get('w4')).not.toBeNull();
    // Reading counts as use.
    const t = new WidgetStates();
    for (let i = 0; i < 4; i++) t.set(`w${i}`, 'x'.repeat(60_000));
    t.get('w0');
    t.set('w4', 'x'.repeat(60_000));
    expect(t.get('w0')).not.toBeNull();
    expect(t.get('w1')).toBeNull();
  });

  it('round-trips through the saved form, ignoring junk', () => {
    const s = new WidgetStates();
    s.set('a', '{"n":1}');
    expect(new WidgetStates([...s.save(), 'junk', [1, 2]]).get('a')).toBe('{"n":1}');
  });
});

describe('activation evidence (§5.3)', () => {
  const box = { left: 100, top: 100, right: 300, bottom: 200 };
  const vp = { width: 600, height: 900 };

  it('no gesture of the panel’s own in the window: the activation was in a widget, accepted', () => {
    expect(new ActivationEvidence().allows(box, 10_000, vp)).toBe(true);
    const e = new ActivationEvidence();
    e.gesture(1000, { x: 10, y: 10 });
    expect(e.allows(box, 7000, vp)).toBe(true); // older than the 5 s window
  });

  it('a panel gesture with the pointer resting, or moving away, is refused; travel toward the widget is accepted', () => {
    const e = new ActivationEvidence();
    e.gesture(1000, { x: 200, y: 260 });
    expect(e.allows(box, 1100, vp)).toBe(false);
    e.sample({ x: 200, y: 280, t: 1050 }); // away
    expect(e.allows(box, 1100, vp)).toBe(false);
    e.sample({ x: 200, y: 240, t: 1080 }); // toward
    expect(e.allows(box, 1100, vp)).toBe(true);
  });

  it('the same position again (boundary events under a resting pointer) isn’t travel', () => {
    const e = new ActivationEvidence();
    e.gesture(1000, { x: 200, y: 210 });
    e.sample({ x: 200, y: 210, t: 1200 });
    expect(e.allows(box, 1300, vp)).toBe(false);
  });

  it('a last sample near the panel’s edge (the pointer left the webview) never counts', () => {
    const e = new ActivationEvidence();
    e.gesture(1000, { x: 400, y: 150 });
    e.sample({ x: 590, y: 150, t: 1050 });
    expect(e.allows({ left: 450, top: 100, right: 600, bottom: 200 }, 1100, vp)).toBe(false);
  });

  it('the panel moving focus itself uses up the gestures before it', () => {
    const e = new ActivationEvidence();
    e.gesture(1000);
    e.panelMove(1001);
    expect(e.allows(box, 1100, vp)).toBe(true);
    e.gesture(1200);
    expect(e.allows(box, 1300, vp)).toBe(false);
  });

  it('a key in the panel with the pointer resting on the widget all along is accepted; one the widget moved under is unsure', () => {
    const frame = {};
    const e = new ActivationEvidence();
    e.sample({ x: 150, y: 150, t: 900, hit: frame }); // the pointer arrived on the widget
    e.gesture(1000); // a key pressed in the panel
    expect(e.judge(box, 1100, vp, frame)).toBe('allow');
    expect(e.judge({ ...box, top: 160 }, 1100, vp, frame)).toBe('refuse'); // no longer under the pointer
    const f = new ActivationEvidence();
    f.sample({ x: 150, y: 150, t: 900 }); // on the prose; the widget then moved or grew under it
    f.gesture(1000);
    expect(f.judge(box, 1100, vp, frame)).toBe('unsure');
    expect(f.allows(box, 1100, vp, frame)).toBe(false);
  });

  it('a widget that isn’t visible is never credited', () => {
    const e = new ActivationEvidence();
    e.gesture(1000, { x: 200, y: 50 });
    e.sample({ x: 200, y: 80, t: 1050 });
    expect(e.allows(null, 1100, vp, {})).toBe(false);
  });

  it('rays: a fast move that skips past the edge still hits', () => {
    expect(rayHits({ x: 0, y: 150 }, { x: 50, y: 150 }, box)).toBe(true);
    expect(rayHits({ x: 50, y: 150 }, { x: 0, y: 150 }, box)).toBe(false);
    expect(rayHits({ x: 0, y: 0 }, { x: 10, y: 5 }, box)).toBe(true);
    expect(rayHits({ x: 0, y: 0 }, { x: 10, y: 1 }, box)).toBe(false);
  });
});

describe('watchdog (§4)', () => {
  const beat = (delay = 0, visible = true) => ({ delay, visible, mounted: ['w/a.tsx'], mounting: null, recent: 'w/a.tsx' });

  it('trips when beats stop for 10 s from a visible panel with widgets', () => {
    const w = new HeartbeatWatchdog();
    w.beat(beat(), 0);
    for (let t = 1000; t < 10_000; t += 1000) expect(w.tick(t)).toBeUndefined();
    expect(w.tick(10_000)).toBe('trip');
    expect(w.tick(11_000)).toBeUndefined(); // once
    expect(w.suspect()).toBe('w/a.tsx');
  });

  it('isn’t armed by a hidden panel or one without widgets; ignores gaps its own timer saw too', () => {
    const w = new HeartbeatWatchdog();
    w.beat(beat(0, false), 0);
    expect(w.tick(20_000)).toBeUndefined();
    const v = new HeartbeatWatchdog();
    v.beat(beat(), 0);
    v.tick(1000);
    expect(v.tick(15_000)).toBeUndefined(); // the extension host was frozen too
    expect(v.tick(16_000)).toBeUndefined();
  });

  it('trips on 3 beats in 60 s more than 2 s late', () => {
    const w = new HeartbeatWatchdog();
    expect(w.beat(beat(2500), 0)).toBeUndefined();
    expect(w.beat(beat(10), 1000)).toBeUndefined();
    expect(w.beat(beat(3000), 20_000)).toBeUndefined();
    expect(w.beat(beat(9000), 50_000)).toBe('trip');
  });

  it('escalates: the suspect, then all of the explainer’s widgets within 5 minutes, then stops', () => {
    const e = new Escalations();
    expect(e.record('x', 0)).toBe('suspect');
    expect(e.record('x', 60_000)).toBe('all');
    expect(e.record('x', 120_000)).toBe('stop');
    expect(e.record('y', 120_000)).toBe('suspect');
    expect(e.record('x', 1_000_000)).toBe('suspect');
  });
});

describe('placeholders in explainer.html (extension side)', () => {
  it('finds widget sources, and reports self-closing tags, bad src and broken props by line', () => {
    const html = [
      '<section>',
      '<explain-widget src="w/a.tsx" props=\'{"n": 1}\'></explain-widget>',
      '<explain-widget src="../x.tsx"></explain-widget>',
      '<explain-widget src="w/b.tsx"/>',
      '<explain-widget src="w/a.tsx">',
      '  <script type="application/json">{"n": }</script>',
      '</explain-widget>',
    ].join('\n');
    const { widgets, problems } = scanWidgets(html);
    expect(widgets.map((w) => [w.src, w.line])).toEqual([['w/a.tsx', 2], ['w/b.tsx', 4], ['w/a.tsx', 5]]);
    expect(problems.map((p) => [p.line, p.severity, p.message.slice(0, 30)])).toEqual([
      [3, 'error', '<explain-widget src="../x.tsx"'],
      [4, 'warning', '<explain-widget …/> is not sel'],
      [6, 'error', "w/a.tsx: props aren't valid JS"],
    ]);
    expect(widgetSources(html)).toEqual(['w/a.tsx', 'w/b.tsx']);
  });

  it('stays linear on hostile input', () => {
    const t0 = performance.now();
    scanWidgets('<explain-widget "'.repeat(200_000));
    closeWidgetTags('<explain-widget "'.repeat(200_000));
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it('rewrites self-closing placeholders (quotes respected) and leaves the rest', () => {
    expect(closeWidgetTags('<p><explain-widget src="a/b.tsx" title="x/>y"/><b>after</b>')).toEqual({ html: '<p><explain-widget src="a/b.tsx" title="x/>y"></explain-widget><b>after</b>', count: 1 });
    expect(closeWidgetTags('<explain-widget src="a.tsx"></explain-widget>').count).toBe(0);
  });

  it('finds the anchors widgets read: literal ids, or all when computed', () => {
    expect(anchorsRead({ 'a.tsx': 'const c = (0, _explainer.useAnchorCode)("refill"); useAnchorCode(\'drain\');' })).toEqual(new Set(['refill', 'drain']));
    expect(anchorsRead({ 'a.tsx': "_explainer.useAnchorCode.call(void 0, 'delay')" })).toEqual(new Set(['delay']));
    expect(anchorsRead({ 'a.tsx': 'useAnchorCode(id)' })).toBe('all');
    expect(anchorsRead({ 'a.tsx': '_explainer.useAnchorCode.call(void 0, props.anchor)' })).toBe('all');
  });
});

it('the webview harness allows exactly the bootstrap by hash, as the panel does', () => {
  const hash = `sha256-${createHash('sha256').update(WIDGET_BOOTSTRAP, 'utf8').digest('base64')}`;
  expect(readFileSync('test/webview/harness.html', 'utf8')).toContain(`'${hash}'`);
});

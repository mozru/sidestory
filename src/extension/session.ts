// One explainer panel: keeps the current explainer's anchors resolved against live buffers and the
// webview in sync. The panel can dive into detail explainers and come back (the trail).
import * as vscode from 'vscode';
import type { Anchor, LineRange, Manifest } from '../core/manifest.ts';
import { explainerNameSchema, parseManifest } from '../core/manifest.ts';
import type { Resolution } from '../core/resolve.ts';
import { resolveAnchor } from '../core/resolve.ts';
import { anchorAtLine } from '../core/sections.ts';
import { PreparedText } from '../core/text.ts';
import { trackRange } from '../core/tracking.ts';
import type { AnchorView, DetailInfo, FromWebview, ToWebview } from '../shared/protocol.ts';
import { assetMime, fromWebviewSchema, MAX_TRAIL, safeExternalUrl, themeColorVar } from '../shared/protocol.ts';
import type { GroupView } from './columns.ts';
import { codeColumnFor } from './columns.ts';
import type { Decorations } from './decorations.ts';
import type { ExplainerRef } from './explainers.ts';
import { refFromDir, htmlUri, manifestUri, MAX_ASSET_BYTES, MAX_CODE_BYTES, MAX_HTML_BYTES, MAX_MANIFEST_BYTES, readBytesInside, readInside, uriKey } from './explainers.ts';
import { log } from './log.ts';
import { shellHtml, VIEW_TYPE } from './panel.ts';
import { realPathInside } from './paths.ts';
import type { AnchorStates } from './pin.ts';
import type { PanelWidgets, WidgetHost, WidgetSessionPort } from './widgets/host.ts';

const RELOAD_DELAY = 120;
const RESOLVE_DELAY = 150;
const CURSOR_DELAY = 100;
/** Give the extension host back control after this much resolving. */
const SLICE_MS = 15;
const MAX_ASSETS_IN_FLIGHT = 4;
/** Asset bytes one panel may receive before its content or assets change again. */
const MAX_ASSET_BUDGET = 20_000_000;
/** Asset requests one panel may make before its content or assets change again. */
const MAX_ASSET_REQUESTS = 500;

const LOST: Resolution = { state: 'lost', range: null, location: 0, similarity: 0, ambiguous: false, method: 'none' };
/** Workspace state: explainers already told that their anchors aren't pinned. */
const UNPINNED_NOTICE_KEY = 'codeExplainer.unpinnedNoticeShown';

/** What a session needs from the extension. */
export interface SessionHost {
  /** Workspace state, for one-time notices. */
  memento: vscode.Memento;
  /** The panel asked to point a section at the code selected in the editor. */
  reanchor(ref: ExplainerRef, anchorId: string): void;
  /** Widgets (docs/WIDGETS-PLAN.md); without it, widget placeholders show their fallback. */
  widgets?: WidgetHost;
}

export interface SessionOptions {
  /** The section to show first. */
  active?: string;
  /** Recreated by the widget watchdog: no second recovery. */
  recovered?: boolean;
}

export class ExplainerSession implements vscode.Disposable {
  /** The root explainer, then each detail dived into; the last one is shown. */
  private trail: ExplainerRef[];
  readonly panel: vscode.WebviewPanel;
  /** Where the reader was in each explainer of the trail, so going back returns there. */
  private readonly positions = new Map<string, string | undefined>();
  /** Titles of explainers seen, for the trail. */
  private readonly titles = new Map<string, string>();
  /** Files that each described detail explainer covers, for "the cursor is in a detail" hints. */
  private readonly detailFiles = new Map<string, { title: string; files: Set<string> }>();
  private lastHint: string | undefined;
  /** Bumped by every dive or Back, so an older navigation still waiting gives way to the newer one. */
  private navRequest = 0;
  /** Bumped whenever the trail changes, so work started for the explainer shown before stops. */
  private generation = 0;
  /** The generation the page last got `init` for. Until it's the current one, half-updated state isn't sent. */
  private initGeneration = 0;
  private explainerWatchers: vscode.Disposable[] = [];
  private readonly decorations: Decorations;

  private manifest: Manifest | undefined;
  private manifestText = '';
  /** manifest.json doesn't parse now: this error stays up, over the last good version's warnings. */
  private manifestError: string | null = null;
  /** The current error (or warnings) banner, resent when a hidden panel is rebuilt. */
  private lastError: string | null = null;
  /** Warnings from the last successful parse: shown again once a transient read failure clears. */
  private warnings: string | null = null;
  private title = '';
  private html = '';
  private readonly resolutions = new Map<string, Resolution>();
  /**
   * Where each anchor's code is believed to be: moved along with every edit, and updated
   * only from confident resolutions, so a guess never becomes trusted evidence.
   */
  private readonly hints = new Map<string, LineRange>();
  /** Anchors whose whole region an edit replaced since the last resolve. */
  private readonly orphaned = new Set<string>();
  private readonly changedAssets = new Set<string>();
  /** Bytes of assets sent to the panel since the content or its assets last changed. */
  private assetBytes = 0;
  private assetsInFlight = 0;
  private assetRequests = 0;
  private readonly assetQueue: (() => void)[] = [];
  /** Anchors by their file's URI, for the manifest loaded: looked up on every edit and cursor move in any file. */
  private byFile: { manifest: Manifest | undefined; anchors: Map<string, Anchor[]> } = { manifest: undefined, anchors: new Map() };
  /** Bumped per file on every resolve, so a slower, older resolve can't overwrite a newer one. */
  private readonly fileSeq = new Map<string, number>();
  private active: string | undefined;
  private reveal: { id: string; moveCursor: boolean; running: boolean; next?: { id: string; moveCursor: boolean } } = { id: '', moveCursor: false, running: false };
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private fileWatchers: vscode.Disposable[] = [];
  private disposed = false;
  /** Our own cursor move (an inline reference) shouldn't count as the reader moving to that section. */
  private ignoreSelectionUntil = 0;
  private readonly onDisposeEmitter = new vscode.EventEmitter<void>();
  readonly onDidDispose = this.onDisposeEmitter.event;

  private readonly host: SessionHost;
  private readonly widgets: PanelWidgets | undefined;
  /** Bumped by every widget focus question, so a late answer to an old one is ignored. */
  private focusQueries = 0;
  /** Recreated by the watchdog, and not yet seen working again. */
  private recovered = false;

  /** `trail`: the root explainer, then the details dived into (restored after a restart); the last is shown. */
  constructor(trail: readonly [ExplainerRef, ...ExplainerRef[]], panel: vscode.WebviewPanel, extensionUri: vscode.Uri, decorations: Decorations, host: SessionHost, opts: SessionOptions = {}) {
    this.trail = [...trail];
    this.panel = panel;
    this.decorations = decorations;
    this.host = host;
    this.active = opts.active;
    panel.webview.html = shellHtml(panel.webview, extensionUri, this.ref);
    if (host.widgets) {
      this.widgets = host.widgets.attach(this.widgetPort(opts.recovered === true));
      // A hidden panel's frames are gone (retainContextWhenHidden is off): nothing to watch until it is shown.
      this.subscriptions.push(panel.onDidChangeViewState(() => {
        if (!panel.visible) this.widgets?.watchdog.disarm();
      }));
    }
    this.watchExplainer();
    this.subscriptions.push(
      panel.webview.onDidReceiveMessage((m: unknown) => this.onMessage(m)),
      panel.onDidDispose(() => this.dispose()),
      vscode.workspace.onDidChangeTextDocument((e) => this.onDocumentChange(e)),
      vscode.window.onDidChangeTextEditorSelection((e) => this.onSelection(e)),
      vscode.window.onDidChangeVisibleTextEditors(() => this.decorations.refresh()),
    );
  }

  /** The explainer shown now. */
  get ref(): ExplainerRef {
    return this.trail[this.trail.length - 1]!;
  }

  /** The trail (root first) and the active section, to recreate this panel elsewhere. */
  place(): { trail: [ExplainerRef, ...ExplainerRef[]]; active: string | undefined } {
    return { trail: this.trail as [ExplainerRef, ...ExplainerRef[]], active: this.active };
  }

  /** What the widget host sees of this session. */
  private widgetPort(recovered: boolean): WidgetSessionPort {
    this.recovered = recovered;
    const session = this;
    return {
      panel: this.panel,
      // A recreated panel gets no second recovery, until it works again (or shows another explainer).
      get recovered() {
        return session.recovered;
      },
      healthy: () => {
        this.recovered = false;
      },
      focusQuery: () => this.focusQueries,
      ref: () => this.ref,
      generation: () => this.generation,
      post: (m) => this.post(m),
      manifest: () => this.manifest,
      html: () => this.html,
      title: () => this.title,
      resolution: (id) => this.resolutions.get(id),
      reveal: (anchor, lines, identifiers) => {
        this.requestReveal(anchor, true);
        if (lines || identifiers?.length) this.widgets?.handle({ type: 'widgetHighlight', anchor, lines, identifiers });
      },
      highlight: (h) => {
        const a = h ? this.manifest?.anchors.get(h.anchor) : undefined;
        this.decorations.setWidget(a && h ? { uri: this.fileUri(a.file), range: h.range, identifiers: h.identifiers } : undefined);
      },
    };
  }

  /** The panel just became active: if a widget holds focus, ask whether it got there legitimately (§5.3). */
  queryFocus(): void {
    if (!this.widgets?.watchdog.last?.mounted.length) return;
    this.post({ type: 'focusQuery', id: ++this.focusQueries });
  }

  async load(): Promise<void> {
    await this.reload();
  }

  /** Everything in the explainer folder: its two files reload the explainer; anything else is an asset. */
  private watchExplainer(): void {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.ref.dir, '**/*'));
    const changed = (uri: vscode.Uri) => this.onExplainerFileChange(uri);
    this.explainerWatchers = [watcher, watcher.onDidChange(changed), watcher.onDidCreate(changed), watcher.onDidDelete(changed)];
  }

  // ---- the trail: diving into details and coming back ----

  /** A detail explainer: a sibling folder under the same `.explain/`. */
  private detailRef(name: string): ExplainerRef | undefined {
    if (!explainerNameSchema.safeParse(name).success) return undefined;
    return refFromDir(vscode.Uri.joinPath(this.ref.dir, '..', name));
  }

  private async dive(name: string, section?: string): Promise<void> {
    const child = this.detailRef(name);
    if (!child) return;
    const request = ++this.navRequest;
    const onTrail = (t: ExplainerRef) => t.dir.toString() === child.dir.toString();
    // Already on the trail (a detail that links back to its overview): go back up to it, no loops.
    const at = this.trail.findIndex(onTrail);
    if (at >= 0) {
      if (at < this.trail.length - 1) await this.switchTo(this.trail.slice(0, at + 1), section);
      return;
    }
    if (this.trail.length >= MAX_TRAIL) {
      void vscode.window.showInformationMessage(`Can't open "${name}": details nest at most ${MAX_TRAIL} levels deep.`);
      return;
    }
    const found = (await readInside(manifestUri(child), child.root, MAX_MANIFEST_BYTES)) !== undefined;
    // Another dive or Back came in meanwhile (a double click, say): the newer one wins.
    if (request !== this.navRequest || this.disposed || this.trail.some(onTrail)) return;
    if (!found) {
      void vscode.window.showWarningMessage(`There's no explainer called "${name}" next to this one.`);
      return;
    }
    await this.switchTo([...this.trail, child], section);
  }

  /** Shows another explainer in this panel: resets everything that belongs to the current one. */
  private async switchTo(trail: ExplainerRef[], active?: string): Promise<void> {
    const generation = ++this.generation;
    this.widgets?.onSwitch();
    this.recovered = false;
    this.positions.set(this.ref.dir.toString(), this.active);
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const d of [...this.explainerWatchers, ...this.fileWatchers]) d.dispose();
    this.fileWatchers = [];
    this.trail = trail;
    this.manifest = undefined;
    this.manifestText = '';
    this.manifestError = null;
    this.html = '';
    this.title = this.titles.get(this.ref.dir.toString()) ?? '';
    this.panel.title = `Explainer: ${this.title || this.ref.name}`;
    this.lastError = null;
    this.warnings = null;
    this.resolutions.clear();
    this.hints.clear();
    this.orphaned.clear();
    // fileSeq keeps counting up: a resolve still running for the old explainer must never match.
    this.changedAssets.clear();
    this.detailFiles.clear();
    this.lastHint = undefined;
    this.assetBytes = 0;
    this.assetRequests = 0;
    this.active = active ?? this.positions.get(this.ref.dir.toString());
    this.decorations.set(undefined);
    this.watchExplainer();
    await this.reload();
    // A later switch took over while this one loaded: it sends its own `init`.
    if (generation !== this.generation || this.disposed) return;
    this.initGeneration = generation;
    this.sendInit();
  }

  private sendInit(): void {
    this.post({
      type: 'init',
      title: this.title,
      html: this.html,
      anchors: this.anchorViews(),
      active: this.active,
      dir: this.ref.dir.toString(),
      base: `${this.panel.webview.asWebviewUri(this.ref.dir).toString()}/`,
      trail: this.trail.map((t) => ({ name: t.name, title: this.titles.get(t.dir.toString()) || t.name })),
    });
    if (this.lastError) this.post({ type: 'error', message: this.lastError });
    this.widgets?.onInit();
  }

  /** Title, summary and size of detail explainers, for the parent's "peek" and "+N steps". */
  private async describe(names: string[]): Promise<void> {
    const generation = this.generation;
    const items: DetailInfo[] = [];
    for (const name of new Set(names)) {
      const child = this.detailRef(name);
      const text = child ? await readInside(manifestUri(child), child.root, MAX_MANIFEST_BYTES) : undefined;
      // Moved to another explainer meanwhile: these details are the old one's.
      if (generation !== this.generation) return;
      const parsed = text === undefined ? undefined : parseManifest(text);
      if (!child || !parsed?.ok) {
        items.push({ name, found: false, title: name, summary: '', steps: 0 });
        continue;
      }
      const m = parsed.manifest;
      this.titles.set(child.dir.toString(), m.title);
      this.detailFiles.set(name, { title: m.title || name, files: new Set([...m.anchors.values()].map((a) => vscode.Uri.joinPath(child.root, a.file).toString())) });
      items.push({ name, found: true, title: m.title || name, summary: m.summary ?? '', steps: m.anchors.size });
    }
    this.post({ type: 'details', items });
  }

  /** Anchor states as the panel shows them, and the active section. */
  anchorStates(): AnchorStates {
    return { states: new Map(this.anchorViews().map((a) => [a.id, a.state])), active: this.active };
  }

  /** Where live tracking last saw an anchor's code (only trusted positions are kept). */
  liveHint(id: string): LineRange | undefined {
    return this.hints.get(id);
  }

  navigate(delta: 1 | -1): void {
    this.post({ type: 'navigate', delta });
  }

  // ---- loading ----

  private onExplainerFileChange(uri: vscode.Uri): void {
    const own = [manifestUri(this.ref).toString(), htmlUri(this.ref).toString()];
    if (own.includes(uri.toString())) {
      this.scheduleReload();
      return;
    }
    const prefix = this.ref.dir.path.replace(/\/?$/, '/');
    if (!uri.path.startsWith(prefix)) return;
    this.changedAssets.add(uri.path.slice(prefix.length));
    this.debounce('assets', RELOAD_DELAY, () => {
      const paths = [...this.changedAssets];
      this.changedAssets.clear();
      this.assetBytes = 0; // the panel re-requests what it still uses
      this.assetRequests = 0;
      this.post({ type: 'assetsChanged', paths });
      // Widget code may be among them: compile again, and send live widgets their new code.
      this.widgets?.onFileChanged();
    });
  }

  private scheduleReload(): void {
    this.debounce('reload', RELOAD_DELAY, () => void this.reload());
  }

  private async reload(): Promise<void> {
    const generation = this.generation;
    const [manifestText, html] = await Promise.all([
      readInside(manifestUri(this.ref), this.ref.root, MAX_MANIFEST_BYTES),
      readInside(htmlUri(this.ref), this.ref.root, MAX_HTML_BYTES),
    ]);
    // Read for an explainer the panel has since left.
    if (this.disposed || generation !== this.generation) return;
    if (manifestText === undefined || html === undefined) {
      const which = manifestText === undefined ? 'manifest.json' : 'explainer.html';
      // The title still comes from the manifest, so the tab and trail name the right explainer.
      const parsed = manifestText === undefined ? undefined : parseManifest(manifestText);
      if (parsed?.ok) this.setTitle(parsed.manifest.title);
      this.showError(`Can't read ${which}: it is missing, outside the repository, or too large. Details in Output › Code Explainer.`);
      return;
    }
    const manifestChanged = manifestText !== this.manifestText;
    if (!manifestChanged && this.manifest) {
      // Both files read fine again: replace any "can't read" banner with the manifest's own warnings
      // (or its parse error, if it is still broken and the last good version is showing).
      const banner = this.manifestError ?? this.warnings;
      if (this.lastError !== banner) this.showError(banner);
      // Only the HTML changed: no need to re-read every anchored file or rebuild watchers.
      if (html !== this.html) {
        this.html = html;
        this.assetBytes = 0;
        this.assetRequests = 0;
        this.post({ type: 'content', title: this.title, html });
        void this.widgets?.refreshGate();
      }
      return;
    }
    this.manifestText = manifestText;
    const parsed = parseManifest(manifestText);
    if (!parsed.ok) {
      this.manifestError = this.manifest ? `${parsed.error}\nThe panel keeps showing the last good version until manifest.json is fixed.` : parsed.error;
      this.showError(this.manifestError);
      return;
    }
    this.manifestError = null;
    const previous = this.manifest;
    this.manifest = parsed.manifest;
    for (const id of [...this.hints.keys()]) {
      const a = parsed.manifest.anchors.get(id);
      const before = previous?.anchors.get(id);
      // Forget what we knew when the anchor was removed or rewritten.
      if (!a || !before || a.file !== before.file || a.range.start !== before.range.start || a.range.end !== before.range.end || a.quote?.exact !== before.quote?.exact) {
        this.hints.delete(id);
        this.orphaned.delete(id);
        this.resolutions.delete(id);
      }
    }
    for (const id of this.resolutions.keys()) if (!parsed.manifest.anchors.has(id)) this.resolutions.delete(id);
    if (this.active && !parsed.manifest.anchors.has(this.active)) this.setActive(undefined);

    const warnings = parsed.diagnostics.map((d) => (d.anchor ? `Anchor "${d.anchor}": ${d.message}` : d.message));
    const contentChanged = html !== this.html || parsed.manifest.title !== this.title;
    this.html = html;
    this.setTitle(parsed.manifest.title);
    this.warnings = warnings.length ? `Some sections aren't linked:\n${warnings.join('\n')}` : null;
    this.showError(this.warnings);
    if (contentChanged) {
      this.assetBytes = 0;
      this.assetRequests = 0;
      this.post({ type: 'content', title: this.title, html: this.html });
      void this.widgets?.refreshGate();
    }
    this.watchAnchorFiles();
    if ([...parsed.manifest.anchors.values()].some((a) => !a.quote)) this.noteUnpinned();
    await this.resolveAll();
  }

  private setTitle(title: string): void {
    this.title = title;
    this.titles.set(this.ref.dir.toString(), title);
    this.panel.title = `Explainer: ${title || this.ref.name}`;
  }

  /**
   * Without a quote, an anchor is just a line range: its section can't tell when the code changes.
   * Says so once per explainer (remembered per workspace), with a way to pin.
   */
  private noteUnpinned(): void {
    const ref = this.ref;
    const seen = this.host.memento.get<string[]>(UNPINNED_NOTICE_KEY, []);
    if (seen.includes(ref.dir.toString())) return;
    void this.host.memento.update(UNPINNED_NOTICE_KEY, [...seen, ref.dir.toString()].slice(-200));
    const pin = 'Pin Anchors';
    void vscode.window
      .showInformationMessage(`Sections of “${this.title || ref.name}” can't tell when their code changes until its anchors are pinned.`, pin)
      .then((choice) => {
        if (choice === pin) void vscode.commands.executeCommand('codeExplainer.pin', ref.dir);
      });
  }

  private watchAnchorFiles(): void {
    for (const w of this.fileWatchers) w.dispose();
    this.fileWatchers = [];
    // Paths are validated to contain no glob syntax, so each pattern matches exactly one file.
    for (const file of new Set(this.anchorList().map((a) => a.file))) {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.ref.root, file));
      const uri = this.fileUri(file).toString();
      const changed = () => this.scheduleResolve(uri);
      this.fileWatchers.push(w, w.onDidChange(changed), w.onDidCreate(changed), w.onDidDelete(changed));
    }
  }

  // ---- resolving ----

  private anchorList(): Anchor[] {
    return [...(this.manifest?.anchors.values() ?? [])];
  }

  private fileUri(file: string): vscode.Uri {
    return vscode.Uri.joinPath(this.ref.root, file);
  }

  private anchorsIn(uri: string): Anchor[] {
    if (this.byFile.manifest !== this.manifest) {
      const anchors = new Map<string, Anchor[]>();
      for (const a of this.anchorList()) {
        const key = uriKey(this.fileUri(a.file));
        const list = anchors.get(key);
        if (list) list.push(a);
        else anchors.set(key, [a]);
      }
      this.byFile = { manifest: this.manifest, anchors };
    }
    return this.byFile.anchors.get(uriKey(uri)) ?? [];
  }

  private async resolveAll(): Promise<void> {
    const generation = this.generation;
    const files = new Set(this.anchorList().map((a) => this.fileUri(a.file).toString()));
    for (const f of files) {
      await this.resolveFile(f, false);
      if (generation !== this.generation || this.disposed) return;
    }
    this.publishAnchors();
  }

  private scheduleResolve(uri: string): void {
    this.debounce(`resolve:${uri}`, RESOLVE_DELAY, () => void this.resolveFile(uri, true));
  }

  private async resolveFile(uri: string, publish: boolean): Promise<void> {
    const seq = (this.fileSeq.get(uri) ?? 0) + 1;
    this.fileSeq.set(uri, seq);
    const generation = this.generation;
    const stillCurrent = () => !this.disposed && this.generation === generation && this.fileSeq.get(uri) === seq;

    const source = await readInside(vscode.Uri.parse(uri), this.ref.root, MAX_CODE_BYTES);
    if (!stillCurrent()) return;
    const text = source === undefined ? undefined : PreparedText.from(source);
    let changed = false;
    let sliceStart = Date.now();
    for (const a of this.anchorsIn(uri)) {
      if (Date.now() - sliceStart > SLICE_MS) {
        await new Promise((r) => setImmediate(r));
        if (!stillCurrent()) return;
        sliceStart = Date.now();
      }
      const prev = this.resolutions.get(a.id);
      const next = text ? resolveAnchor(text, a, { hint: this.hints.get(a.id), previous: prev?.state, orphaned: this.orphaned.has(a.id) }) : LOST;
      this.orphaned.delete(a.id);
      if (next.range && !next.ambiguous && next.state !== 'stale') this.hints.set(a.id, next.range);
      if (!prev || prev.state !== next.state || prev.range?.start !== next.range?.start || prev.range?.end !== next.range?.end) changed = true;
      this.resolutions.set(a.id, next);
    }
    if (changed && publish) this.publishAnchors();
    if (changed && this.active && this.anchorsIn(uri).some((a) => a.id === this.active)) this.decorateActive(this.decorations.isDimmed());
    this.widgets?.onResolved(uri);
  }

  private publishAnchors(): void {
    this.post({ type: 'anchors', anchors: this.anchorViews() });
  }

  private anchorViews(): AnchorView[] {
    return this.anchorList().map((a) => {
      const r = this.resolutions.get(a.id);
      return { id: a.id, file: a.file, range: r?.range ?? null, state: r?.state ?? 'pending', colorVar: a.color ? themeColorVar(a.color) : undefined };
    });
  }

  // ---- live edits ----

  private onDocumentChange(e: vscode.TextDocumentChangeEvent): void {
    const uri = e.document.uri.toString();
    if (uri === manifestUri(this.ref).toString() || uri === htmlUri(this.ref).toString()) {
      if (e.contentChanges.length) this.scheduleReload();
      return;
    }
    const anchors = this.anchorsIn(uri);
    if (anchors.length === 0 || e.contentChanges.length === 0) return;
    // Any resolve still running for this file is now working on old text: stop it at its next slice.
    this.fileSeq.set(uri, (this.fileSeq.get(uri) ?? 0) + 1);
    if (this.decorations.isDimmed()) this.decorateActive(false); // typing: stop fading the rest of the file
    const tails = endTails(e.document, e.contentChanges);
    // Positions in one event refer to the document before the event and don't overlap,
    // so applying them bottom-up keeps each later one valid.
    const changes = [...e.contentChanges].sort((x, y) => y.range.start.compareTo(x.range.start));
    for (const a of anchors) {
      // Only trusted positions are tracked: tracking a guess would turn it into evidence.
      let hint = this.hints.get(a.id);
      if (!hint) continue;
      for (const c of changes) {
        const tracked = trackRange(hint, {
          start: { line: c.range.start.line + 1, col: c.range.start.character },
          end: { line: c.range.end.line + 1, col: c.range.end.character },
          text: c.text,
          endTail: tails.get(c),
        });
        hint = tracked.range;
        if (tracked.orphaned) this.orphaned.add(a.id);
      }
      this.hints.set(a.id, hint);
    }
    this.scheduleResolve(uri);
  }

  private onSelection(e: vscode.TextEditorSelectionChangeEvent): void {
    const uri = e.textEditor.document.uri.toString();
    const ids = new Set(this.anchorsIn(uri).map((a) => a.id));
    if (Date.now() < this.ignoreSelectionUntil) return;
    // Code a detail explainer covers: when none of this explainer's sections do, offer to dive.
    const detail = [...this.detailFiles].find(([, d]) => d.files.has(uri));
    if (ids.size === 0 && !detail) {
      this.lastHint = undefined; // left the detail's code: offer it again when the cursor comes back
      return;
    }
    const line = e.selections[0]!.active.line + 1;
    // The reader clicked or typed in the code: stop fading the rest of the file.
    const byUser = e.kind === vscode.TextEditorSelectionChangeKind.Keyboard || e.kind === vscode.TextEditorSelectionChangeKind.Mouse;
    if (byUser && ids.size && this.decorations.isDimmed()) this.decorateActive(false);
    this.debounce('cursor', CURSOR_DELAY, () => {
      const id = ids.size ? anchorAtLine(new Map([...this.resolutions].filter(([k]) => ids.has(k))), line) : undefined;
      if (!id) {
        // Remembered only once the page got it: a hidden panel gets the hint next time.
        if (detail && detail[0] !== this.lastHint && this.post({ type: 'childHint', name: detail[0], title: detail[1].title })) {
          this.lastHint = detail[0];
        }
        return;
      }
      this.lastHint = undefined;
      if (id === this.active) return;
      this.setActive(id);
      this.decorateActive(false);
      this.post({ type: 'syncTo', anchorId: id });
    });
  }

  // ---- webview ----

  private onMessage(raw: unknown): void {
    const parsed = fromWebviewSchema.safeParse(raw);
    if (!parsed.success) return; // the webview renders untrusted HTML; ignore anything malformed
    const m: FromWebview = parsed.data;
    if (this.widgets?.handle(m)) return;
    switch (m.type) {
      case 'ready':
        // A rebuilt panel (hidden, then shown) starts with an empty cache: give it a fresh budget.
        this.assetBytes = 0;
        this.assetRequests = 0;
        // While switching explainers, the switch sends `init` when it's done.
        if (this.initGeneration === this.generation) this.sendInit();
        break;
      case 'dive':
        void this.dive(m.name, m.section);
        break;
      case 'goTo':
        if (m.depth < this.trail.length - 1) {
          this.navRequest++; // a dive still waiting is overtaken
          void this.switchTo(this.trail.slice(0, m.depth + 1));
        }
        break;
      case 'describe':
        void this.describe(m.names);
        break;
      case 'focusAnchor':
        if (!this.manifest?.anchors.has(m.anchorId)) return;
        this.setActive(m.anchorId);
        this.requestReveal(m.anchorId, false);
        break;
      case 'openExternal':
        void this.openExternal(m.url);
        break;
      case 'openFile':
        void this.openExplainerFile(m.path);
        break;
      case 'requestAsset':
        void this.sendAsset(m.id, m.path);
        break;
      case 'openRef':
        // A reference inside a section jumps to other code; the section being read stays active.
        if (!this.manifest?.anchors.has(m.anchorId)) return;
        if (this.resolutions.get(m.anchorId)?.state === 'lost') {
          vscode.window.setStatusBarMessage(`“${m.anchorId}” — code not found`, 4000);
          return;
        }
        this.requestReveal(m.anchorId, true);
        break;
      case 'reanchor':
        // Only starts the flow: the user confirms in a dialog before anything is written.
        if (!this.manifest?.anchors.has(m.anchorId)) return;
        this.host.reanchor(this.ref, m.anchorId);
        break;
    }
  }

  private showError(message: string | null): void {
    this.lastError = message;
    if (message) log.warn(`${this.ref.name}: ${message}`);
    this.post({ type: 'error', message });
  }

  private setActive(id: string | undefined): void {
    if (id !== this.active) this.decorations.setWidget(undefined); // widget highlights belong to the step they were made in
    this.active = id;
    if (!id) this.decorations.set(undefined);
  }

  /**
   * Sends a file from the explainer folder to the content frame (it can't load files itself).
   * A few at a time, and within a per-panel byte budget, so an explainer can't flood the host.
   */
  private async sendAsset(id: number, path: string): Promise<void> {
    // A hard cap on requests, so a page can't keep the host busy reading files.
    if (++this.assetRequests > MAX_ASSET_REQUESTS) {
      this.post({ type: 'asset', id, mime: '', data: null });
      return;
    }
    while (this.assetsInFlight >= MAX_ASSETS_IN_FLIGHT) await new Promise<void>((r) => this.assetQueue.push(r));
    this.assetsInFlight++;
    try {
      const mime = assetMime(path);
      const room = MAX_ASSET_BUDGET - this.assetBytes;
      const uri = vscode.Uri.joinPath(this.ref.dir, path);
      // Inside the explainer folder *and* the repository (the folder itself could be a link elsewhere).
      const inside = mime && room > 0 && (uri.scheme !== 'file' || (await realPathInside(uri.fsPath, this.ref.root.fsPath)));
      const data = inside ? await readBytesInside(uri, this.ref.dir, Math.min(MAX_ASSET_BYTES, room)) : undefined;
      if (data) this.assetBytes += data.byteLength;
      this.post({ type: 'asset', id, mime: mime ?? '', data: data ? Buffer.from(data).toString('base64') : null });
    } finally {
      this.assetsInFlight--;
      this.assetQueue.shift()?.();
    }
  }

  /**
   * Opens a web or mail link from the explainer, after the user confirms the full address.
   * (The schema already refused local and private hosts, credentials and nested URLs.)
   */
  private async openExternal(raw: string): Promise<void> {
    const url = safeExternalUrl(raw);
    if (!url) return;
    const open = 'Open';
    const choice = await vscode.window.showInformationMessage(`The explainer links to:\n\n${url}`, { modal: true, detail: 'It will open outside VS Code.' }, open);
    if (choice === open) await vscode.env.openExternal(vscode.Uri.parse(url, true));
  }

  /** Opens a file the explainer links to (relative to its folder), if it is inside the repo. */
  private async openExplainerFile(path: string): Promise<void> {
    const uri = vscode.Uri.joinPath(this.ref.dir, path);
    if (uri.scheme === 'file' && !(await realPathInside(uri.fsPath, this.ref.root.fsPath))) return;
    await vscode.commands.executeCommand('vscode.open', uri, { viewColumn: this.codeColumn(uri), preview: true });
  }

  /** Highlights the active anchor's code; `dim` fades the rest. */
  private decorateActive(dim: boolean): void {
    const a = this.active ? this.manifest?.anchors.get(this.active) : undefined;
    const r = a ? this.resolutions.get(a.id) : undefined;
    if (!a || !r?.range) {
      this.decorations.set(undefined);
      return;
    }
    this.decorations.set({ uri: this.fileUri(a.file), range: r.range, color: a.color, highlight: a.highlight, dim });
  }

  /** Reveals one anchor at a time; while one is opening, only the latest request waits. */
  private requestReveal(id: string, moveCursor: boolean): void {
    if (this.reveal.running) {
      this.reveal.next = { id, moveCursor };
      return;
    }
    this.reveal = { id, moveCursor, running: true };
    void this.revealNow(id, moveCursor).finally(() => {
      const next = this.reveal.next;
      this.reveal = { id: '', moveCursor: false, running: false };
      if (next && !this.disposed) this.requestReveal(next.id, next.moveCursor);
    });
  }

  /** Shows the anchor's code. `moveCursor` puts the cursor there (inline refs); otherwise only scrolls. */
  private async revealNow(id: string, moveCursor: boolean): Promise<void> {
    const a = this.manifest?.anchors.get(id);
    const r = this.resolutions.get(id);
    if (!a || !r?.range) {
      this.decorateActive(false);
      return;
    }
    const kind = vscode.window.activeColorTheme.kind;
    const highContrast = kind === vscode.ColorThemeKind.HighContrast || kind === vscode.ColorThemeKind.HighContrastLight;
    // No fading in high contrast themes, where it would cut contrast below what the theme promises.
    const dim = !moveCursor && !highContrast && vscode.workspace.getConfiguration('codeExplainer').get<boolean>('dimUnfocused', true);
    const uri = this.fileUri(a.file);
    const range = new vscode.Range(r.range.start - 1, 0, r.range.end - 1, 0);
    try {
      if (moveCursor) this.ignoreSelectionUntil = Date.now() + 500;
      const editor = await vscode.window.showTextDocument(uri, {
        viewColumn: this.codeColumn(uri),
        preserveFocus: !moveCursor,
        preview: true,
        selection: moveCursor ? new vscode.Range(range.start, range.start) : undefined,
      });
      if (this.disposed) return;
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      if (moveCursor) this.decorations.flash(editor, new vscode.Range(range.start, new vscode.Position(r.range.end - 1, 0)));
      else if (this.active === id) this.decorateActive(dim); // unless the reader moved on while the file opened
    } catch (e) {
      void vscode.window.showWarningMessage(`Can't open ${a.file}: ${(e as Error).message}`);
    }
  }

  /** An editor column for code that never covers a visible explainer panel, this one or another. */
  private codeColumn(uri: vscode.Uri): vscode.ViewColumn {
    const groups = vscode.window.tabGroups.all.map((g): GroupView => {
      const input = g.activeTab?.input;
      let shows: GroupView['shows'];
      if (input instanceof vscode.TabInputText) shows = { kind: 'text', uri: input.uri.toString() };
      else if (input instanceof vscode.TabInputWebview && input.viewType.endsWith(VIEW_TYPE)) shows = { kind: 'explainer' };
      else if (g.activeTab) shows = { kind: 'other' };
      return { column: g.viewColumn, shows };
    });
    return codeColumnFor(groups, this.panel.viewColumn, uri.toString());
  }

  /** Whether the message was handed to the page. */
  private post(message: ToWebview): boolean {
    // Messages to a hidden webview are dropped; it asks for everything again with `ready` when shown.
    // While switching explainers, half-updated state isn't sent; `init` follows.
    if (!this.panel.visible || this.disposed || this.initGeneration !== this.generation) return false;
    void this.panel.webview.postMessage(message);
    return true;
  }

  private debounce(key: string, ms: number, fn: () => void): void {
    clearTimeout(this.timers.get(key));
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      if (!this.disposed) fn();
    }, ms));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const d of [...this.subscriptions, ...this.explainerWatchers, ...this.fileWatchers]) d.dispose();
    this.widgets?.dispose();
    this.decorations.set(undefined);
    this.onDisposeEmitter.fire();
    this.onDisposeEmitter.dispose();
  }
}

/**
 * For each change, how many characters followed its end on that line before the event.
 * In the new document that tail sits right after the change's inserted text, on a line we can
 * find by adding up the line counts of the changes above it. Changes that share a line with
 * another change are skipped (their columns shift), and get no value.
 */
function endTails(doc: vscode.TextDocument, changes: readonly vscode.TextDocumentContentChangeEvent[]): Map<vscode.TextDocumentContentChangeEvent, number> {
  const out = new Map<vscode.TextDocumentContentChangeEvent, number>();
  const sorted = [...changes].sort((x, y) => x.range.start.compareTo(y.range.start));
  let shift = 0;
  sorted.forEach((c, i) => {
    const inserted = c.text.split(/\r\n|\r|\n/);
    const sharesLine = (sorted[i - 1]?.range.end.line === c.range.start.line) || (sorted[i + 1]?.range.start.line === c.range.end.line);
    const line = c.range.start.line + shift + inserted.length - 1;
    if (!sharesLine && line < doc.lineCount) {
      const insertedEnd = inserted.length === 1 ? c.range.start.character + c.text.length : inserted.at(-1)!.length;
      out.set(c, Math.max(0, doc.lineAt(line).text.length - insertedEnd));
    }
    shift += inserted.length - 1 - (c.range.end.line - c.range.start.line);
  });
  return out;
}

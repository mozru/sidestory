// One explainer panel: keeps the current explainer's anchors resolved against live buffers and the
// webview in sync. The panel can dive into detail explainers and come back (the trail).
import * as vscode from 'vscode';
import type { Anchor, LineRange, Manifest } from '../core/manifest.ts';
import { explainerNameSchema, parseManifest } from '../core/manifest.ts';
import type { Resolution } from '../core/resolve.ts';
import { resolveAnchor } from '../core/resolve.ts';
import { displayText, plainForMessage } from '../core/display-text.ts';
import { PreparedText } from '../core/text.ts';
import { trackRange } from '../core/tracking.ts';
import { parseCodeLink, type CodeLink } from '../shared/code-link.ts';
import type { AnchorView, DetailInfo, FromWebview, ToWebview } from '../shared/protocol.ts';
import { assetMime, fromWebviewSchema, MAX_TRAIL, safeExternalUrl, themeColorVar } from '../shared/protocol.ts';
import type { GroupView } from './columns.ts';
import type { Requester } from './highlight/host.ts';
import type { HighlightService } from './highlight/service.ts';
import { codeColumnFor } from './columns.ts';
import { checkCodePath, OpenCodeGate, resolveLink, SymbolTables } from './code-links.ts';
import { anchorForCursor } from './cursor.ts';
import type { Decorations } from './decorations.ts';
import type { ExplainerRef } from './explainers.ts';
import { refFromDir, htmlUri, manifestUri, MAX_ASSET_BYTES, MAX_CODE_BYTES, MAX_HTML_BYTES, MAX_MANIFEST_BYTES, readBytesInside, readInside, uriKey } from './explainers.ts';
import { log } from './log.ts';
import { shellHtml, VIEW_TYPE } from './panel.ts';
import { realPathInside } from './paths.ts';
import type { AnchorStates } from './pin.ts';
import type { PreparedTextCache } from './prepared-cache.ts';
import type { PanelWidgets, WidgetHost, WidgetSessionPort } from './widgets/host.ts';
import { ourModal } from './widgets/watchdog.ts';

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
const UNPINNED_NOTICE_KEY = 'sidestory.unpinnedNoticeShown';

/** What a session needs from the extension. */
export interface SessionHost {
  /** Workspace state, for one-time notices. */
  memento: vscode.Memento;
  /** The panel asked to point a section at the code selected in the editor. */
  reanchor(ref: ExplainerRef, anchorId: string): void;
  /** Widgets (docs/WIDGETS-PLAN.md); without it, widget placeholders show their fallback. */
  widgets?: WidgetHost;
  /** Code block highlighting (docs/HIGHLIGHT-PLAN.md); without it, code blocks stay plain. */
  highlight?: HighlightService;
  /** Prepared texts shared with the workspace index (docs/NAVIGATION-PLAN.md §7.2). */
  prepared?: PreparedTextCache;
  /** The outline's step count for a sidestory (one number in the tree and the peek, §8.2). */
  stepCount?(dir: vscode.Uri): number | undefined;
  /** A sidestory's title from the workspace index, for trail crumbs of sidestories this panel hasn't loaded. */
  titleOf?(dir: vscode.Uri): string | undefined;
  /** A sidestory was shown in this panel (open, switch, dive): the recent list (§7.5). */
  opened?(ref: ExplainerRef): void;
  /** SV symbol tables shared by every panel (docs/AUTHORING-PLAN.md §8.2); without it, the session keeps its own. */
  symbols?: SymbolTables;
}

/** What the page links to, from its last `codeTargets` (docs/AUTHORING-PLAN.md §8.2). */
interface CodeTargets {
  /** Every `data-explain-anchor`: only these steer cursor-follow. */
  sections: Set<string>;
  /** Anchors `data-explain-ref` names: they light up from the cursor. */
  refs: Set<string>;
  /** `data-explain-code` links, canonical, with the key of the file each points into. */
  links: { text: string; link: CodeLink; key: string }[];
  /** Keys of the files links point into: a cursor anywhere else costs one lookup. */
  files: Set<string>;
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
  private highlightRequester: { dir: string; who: Requester } | undefined;
  private highlightTimes: number[] = [];
  private readonly onDisposeEmitter = new vscode.EventEmitter<void>();
  readonly onDidDispose = this.onDisposeEmitter.event;
  private readonly resolveEmitter = new vscode.EventEmitter<string>();
  /** A file's anchors were resolved again (its URI string): the index's overlay reads `resolutionsFor`. */
  readonly onDidResolve = this.resolveEmitter.event;
  private readonly switchEmitter = new vscode.EventEmitter<void>();
  /** The panel moved to another sidestory (dive, Back, `openAt`): overlays from before are void. */
  readonly onDidSwitch = this.switchEmitter.event;
  private readonly navigateEmitter = new vscode.EventEmitter<void>();
  /** The reader acted in the panel (a step, a dive or Back, a widget input, a scroll that moved the section). */
  readonly onDidNavigate = this.navigateEmitter.event;
  /** A preview panel: the next sidestory opened from code or a list replaces it (§7.5). */
  private previewing = false;

  private readonly host: SessionHost;
  private readonly widgets: PanelWidgets | undefined;
  /** Bumped by every widget focus question, so a late answer to an old one is ignored. */
  private focusQueries = 0;
  /** Recreated by the watchdog, and not yet seen working again. */
  private recovered = false;

  // ---- code links and cursor lighting (docs/AUTHORING-PLAN.md §8.1, §8.2) ----
  /** What the page links to; undefined until it says (first render) and while the panel is hidden. */
  private targets: CodeTargets | undefined;
  /** The `here` the page has now, as JSON, so it's posted only when it changes. */
  private hereSent = '';
  /** Bumped per lighting request, so a slower, older one gives way. */
  private hereSeq = 0;
  /** Each linked file's link extents, for one document version. */
  private readonly linkExtents = new Map<string, { version: number; extents: Promise<Map<string, LineRange>> }>();
  private readonly openGate = new OpenCodeGate();
  /** `openCode` requests opening now: the selection changes they cause aren't the reader's. */
  private opening = 0;
  private ownSymbols: SymbolTables | undefined;
  /** The page chose this section itself at open; reveal it once it resolves. */
  private revealWhenResolved: string | undefined;

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
    host.opened?.(this.ref);
    this.subscriptions.push(
      this.resolveEmitter,
      this.switchEmitter,
      this.navigateEmitter,
      panel.webview.onDidReceiveMessage((m: unknown) => this.onMessage(m)),
      panel.onDidDispose(() => this.dispose()),
      vscode.workspace.onDidChangeTextDocument((e) => this.onDocumentChange(e)),
      vscode.window.onDidChangeTextEditorSelection((e) => this.onSelection(e)),
      vscode.window.onDidChangeVisibleTextEditors(() => this.decorations.refresh()),
      // A hidden panel's page is gone (it asks again with `ready`): what it linked to and lit is gone with it.
      panel.onDidChangeViewState(() => {
        if (!panel.visible) this.forgetTargets();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('sidestory.followCursorInDiagrams') && !this.lightingOn()) this.postHere({});
      }),
    );
  }

  /** The explainer shown now. */
  get ref(): ExplainerRef {
    return this.trail[this.trail.length - 1]!;
  }

  /** Bumped whenever the trail changes; overlays are tagged with it and checked when read. */
  get currentGeneration(): number {
    return this.generation;
  }

  /** The trail's refs, root first. */
  get trailRefs(): readonly ExplainerRef[] {
    return this.trail;
  }

  /**
   * This sidestory's resolutions in one file, while it still shows `dir` at `generation` (§7.2): the index uses
   * them instead of resolving the same anchors again. Undefined when the panel moved on, or knows nothing yet.
   */
  resolutionsFor(uri: string, dir: string, generation: number): Map<string, Resolution> | undefined {
    if (this.disposed || generation !== this.generation || this.ref.dir.toString() !== dir || !this.manifest) return undefined;
    const out = new Map<string, Resolution>();
    for (const a of this.anchorsIn(uri)) {
      const r = this.resolutions.get(a.id);
      if (r) out.set(a.id, r);
    }
    return out;
  }

  /** Whether this is a preview panel (§7.5). */
  get preview(): boolean {
    return this.previewing;
  }

  set preview(on: boolean) {
    if (on === this.previewing) return;
    this.previewing = on;
    this.post({ type: 'preview', on });
  }

  /**
   * Shows a section: makes it active, moves the panel there and reveals its code without moving the cursor.
   * During a switch (until the page has the new sidestory), only the pending `active` is set; `init` carries it.
   */
  goTo(anchorId: string): void {
    if (this.initGeneration !== this.generation || !this.manifest) {
      this.active = anchorId;
      return;
    }
    if (!this.manifest.anchors.has(anchorId)) return;
    this.setActive(anchorId);
    this.post({ type: 'syncTo', anchorId });
    this.requestReveal(anchorId, false);
  }

  /** Shows another trail in this panel (§7.5 `openAt`), at a section if given. */
  async show(trail: readonly [ExplainerRef, ...ExplainerRef[]], active?: string): Promise<void> {
    this.navRequest++; // a dive still waiting is overtaken
    await this.switchTo([...trail], active);
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

  /** A detail explainer: a sibling folder under the same `.sidestory/`. */
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
      void vscode.window.showInformationMessage(`Can't open "${plainForMessage(name, 64)}": details nest at most ${MAX_TRAIL} levels deep.`);
      return;
    }
    const found = (await readInside(manifestUri(child), child.root, MAX_MANIFEST_BYTES)) !== undefined;
    // Another dive or Back came in meanwhile (a double click, say): the newer one wins.
    if (request !== this.navRequest || this.disposed || this.trail.some(onTrail)) return;
    if (!found) {
      void vscode.window.showWarningMessage(`There's no sidestory called "${plainForMessage(name, 64)}" next to this one.`);
      return;
    }
    await this.switchTo([...this.trail, child], section);
  }

  /** Shows another explainer in this panel: resets everything that belongs to the current one. */
  private async switchTo(trail: ExplainerRef[], active?: string): Promise<void> {
    const generation = ++this.generation;
    this.switchEmitter.fire();
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
    this.panel.title = displayText(this.title || this.ref.name, 120) || 'Sidestory';
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
    this.forgetTargets();
    this.revealWhenResolved = undefined;
    this.active = active ?? this.positions.get(this.ref.dir.toString());
    this.decorations.set(undefined);
    this.watchExplainer();
    this.host.opened?.(this.ref);
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
      trail: this.trail.map((t) => ({ name: t.name, title: this.titles.get(t.dir.toString()) || this.host.titleOf?.(t.dir) || t.name })),
    });
    if (this.lastError) this.post({ type: 'error', message: this.lastError });
    if (this.previewing) this.post({ type: 'preview', on: true });
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
      // The outline's step count when the index knows it, so the tree and the peek never disagree (§8.2).
      items.push({ name, found: true, title: m.title || name, summary: m.summary ?? '', steps: this.host.stepCount?.(child.dir) ?? m.anchors.size });
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
      const which = manifestText === undefined ? 'manifest.json' : 'sidestory.html';
      // The title still comes from the manifest, so the tab and trail name the right explainer.
      const parsed = manifestText === undefined ? undefined : parseManifest(manifestText);
      if (parsed?.ok) this.setTitle(parsed.manifest.title);
      this.showError(`Can't read ${which}: it is missing, outside the repository, or too large. Details in Output › Sidestory.`);
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
    // Plain text in the tab, but still repository text: no controls or bidirectional tricks (§11.4).
    this.panel.title = displayText(title || this.ref.name, 120) || 'Sidestory';
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
      .showInformationMessage(`Sections of “${plainForMessage(this.title || ref.name, 120)}” can't tell when their code changes until its anchors are pinned.`, pin)
      .then((choice) => {
        if (choice === pin) void vscode.commands.executeCommand('sidestory.pin', ref.dir);
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
    // An open document's text is shared with the index (one PreparedText per document version, §7.2).
    const doc = source !== undefined && this.host.prepared ? vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri) : undefined;
    const text = source === undefined ? undefined : doc && !doc.isClosed && this.host.prepared ? this.host.prepared.get(uriKey(uri), doc.version, () => source) : PreparedText.from(source);
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
    const waiting = this.revealWhenResolved;
    if (waiting && this.resolutions.get(waiting)?.range) {
      this.revealWhenResolved = undefined;
      if (this.active === waiting) this.requestReveal(waiting, false);
    }
    this.resolveEmitter.fire(uri);
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
    // Only the reader's own cursor moves count: a click, typing, or a command they ran (Go to Line, Go to
    // Definition). Selections with no kind aren't theirs: a file reopening puts its cursor back where it was
    // (view state restored), which would pull the explainer back to whatever section that old cursor is in.
    const k = vscode.TextEditorSelectionChangeKind;
    if (e.kind !== k.Keyboard && e.kind !== k.Mouse && e.kind !== k.Command) return;
    // Nor do the panel's own reveals (an inline reference puts the cursor in its code): the selection changes a
    // reveal causes reach the extension before showTextDocument resolves, so while one runs, none are the reader's.
    if (this.reveal.running || this.opening > 0) return;
    const doc = e.textEditor.document;
    const uri = doc.uri.toString();
    const ids = new Set(this.anchorsIn(uri).map((a) => a.id));
    // Code a detail explainer covers: when none of this explainer's sections do, offer to dive.
    const detail = [...this.detailFiles].find(([, d]) => d.files.has(uri));
    const linked = this.targets?.files.has(uriKey(uri)) ?? false;
    if (ids.size === 0 && !detail && !linked) {
      this.lastHint = undefined; // left the detail's code: offer it again when the cursor comes back
      clearTimeout(this.timers.get('cursor'));
      this.timers.delete('cursor');
      this.hereSeq++;
      this.postHere({}); // nothing the page links to is in this file
      return;
    }
    const line = e.selections[0]!.active.line + 1;
    // The reader moved in the code: stop fading the rest of the file.
    if (ids.size && this.decorations.isDimmed()) this.decorateActive(false);
    this.debounce('cursor', CURSOR_DELAY, () => {
      void this.lightAt(doc, line);
      // The shared cursor helper (cursor.ts). Only sections steer the step (docs/AUTHORING-PLAN.md §0, §8.2): an
      // anchor used only by `data-explain-ref` lights its boxes instead. Until the page has said which ids are
      // sections (first render, hidden panel), every anchor counts, as before.
      const id = ids.size ? anchorForCursor([...this.resolutions].filter(([k]) => ids.has(k)), line, { sections: this.targets?.sections }) : undefined;
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
    if (this.previewing && endsPreview(m)) {
      this.preview = false;
      this.navigateEmitter.fire();
    }
    if (this.widgets?.handle(m)) return;
    switch (m.type) {
      case 'keepOpen':
        this.preview = false;
        this.navigateEmitter.fire();
        break;
      case 'ready':
        // A rebuilt panel (hidden, then shown) starts with an empty cache: give it a fresh budget.
        this.assetBytes = 0;
        this.assetRequests = 0;
        this.hereSent = ''; // a new page has nothing lit
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
        if (m.source === 'initial') {
          this.showInitial(m.anchorId);
          return;
        }
        this.requestReveal(m.anchorId, false);
        break;
      case 'codeTargets':
        this.setTargets(m);
        break;
      case 'openCode':
        void this.openCode(m.path, m.target);
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
      case 'highlight':
        void this.highlight(m.blocks);
        break;
      case 'reanchor':
        // Only starts the flow: the user confirms in a dialog before anything is written.
        if (!this.manifest?.anchors.has(m.anchorId)) return;
        this.host.reanchor(this.ref, m.anchorId);
        break;
    }
  }

  /**
   * The page opened at a section it chose itself (the first step, or the reader's saved place). With no code
   * editor open, show its code; with one open, only highlight it where it's visible, rather than take over the
   * editor the reader was using.
   */
  private showInitial(id: string): void {
    const editorOpen = vscode.window.visibleTextEditors.some((e) => e.viewColumn !== undefined);
    if (editorOpen) {
      this.decorateActive(false);
      return;
    }
    if (this.resolutions.get(id)?.range) this.requestReveal(id, false);
    else this.revealWhenResolved = id; // still resolving: resolveFile reveals it
  }

  // ---- code links (docs/AUTHORING-PLAN.md §8.1) and cursor lighting (§8.2) ----

  private get symbols(): SymbolTables {
    return this.host.symbols ?? (this.ownSymbols ??= new SymbolTables());
  }

  private lightingOn(): boolean {
    return vscode.workspace.getConfiguration('sidestory').get<boolean>('followCursorInDiagrams', true) !== false;
  }

  private forgetTargets(): void {
    this.targets = undefined;
    this.hereSent = '';
    this.hereSeq++;
    this.linkExtents.clear();
  }

  /** The page said what it links to (after a render that changed it). */
  private setTargets(m: Extract<FromWebview, { type: 'codeTargets' }>): void {
    const links: CodeTargets['links'] = [];
    for (const text of m.links) {
      const link = parseCodeLink(text);
      if (link) links.push({ text, link, key: uriKey(vscode.Uri.joinPath(this.ref.root, link.path)) });
    }
    this.targets = { sections: new Set(m.sections), refs: new Set(m.refs), links, files: new Set(links.map((l) => l.key)) };
    this.linkExtents.clear();
    // Light what the cursor is in now, without waiting for it to move.
    const ed = vscode.window.activeTextEditor;
    if (ed) void this.lightAt(ed.document, ed.selection.active.line + 1);
  }

  private postHere(h: { ref?: string; link?: string }): void {
    const key = JSON.stringify(h);
    if (key === this.hereSent) return;
    if (this.post({ type: 'here', ...h })) this.hereSent = key;
  }

  /**
   * Rings the tightest element target containing the cursor line (§8.2): an anchor a `data-explain-ref` names, or a
   * `data-explain-code` link. Steps don't change for these.
   */
  private async lightAt(doc: vscode.TextDocument, line: number): Promise<void> {
    const seq = ++this.hereSeq;
    const targets = this.targets;
    if (!targets || !this.lightingOn()) return this.postHere({});
    type Candidate = { ref?: string; link?: string; range: LineRange; stale: boolean };
    const found: Candidate[] = [];
    const uri = doc.uri.toString();
    if (targets.refs.size) {
      for (const a of this.anchorsIn(uri)) {
        if (!targets.refs.has(a.id)) continue;
        const r = this.resolutions.get(a.id);
        if (r?.range && r.state !== 'lost' && line >= r.range.start && line <= r.range.end) found.push({ ref: a.id, range: r.range, stale: r.state === 'stale' });
      }
    }
    const key = uriKey(uri);
    if (targets.files.has(key)) {
      const extents = await this.extentsFor(doc, key, targets);
      if (seq !== this.hereSeq || this.disposed || targets !== this.targets) return;
      for (const [link, range] of extents) if (line >= range.start && line <= range.end) found.push({ link, range, stale: false });
    }
    // The tightest wins, as for sections: trustworthy before stale, then the shortest, then the first, refs first.
    found.sort((a, b) => Number(a.stale) - Number(b.stale) || a.range.end - a.range.start - (b.range.end - b.range.start) || a.range.start - b.range.start || Number(!a.ref) - Number(!b.ref));
    const best = found[0];
    this.postHere(best ? (best.ref ? { ref: best.ref } : { link: best.link! }) : {});
  }

  /** The extents of every link into this document version, resolved once per version (lazily, on first need). */
  private extentsFor(doc: vscode.TextDocument, key: string, targets: CodeTargets): Promise<Map<string, LineRange>> {
    const hit = this.linkExtents.get(key);
    if (hit && hit.version === doc.version) return hit.extents;
    const extents = (async () => {
      const out = new Map<string, LineRange>();
      for (const l of targets.links) {
        if (l.key !== key) continue;
        // The document is open (the cursor is in it), so asking its language for symbols wakes nothing new.
        const r = await resolveLink(doc, l.link, this.symbols, true);
        if (r.ok) out.set(l.text, r.range);
      }
      return out;
    })();
    this.linkExtents.set(key, { version: doc.version, extents });
    return extents;
  }

  /**
   * Opens what a `data-explain-code` link points at (§8.1). The page posts this only from the reader's own click or
   * Enter; these checks are the backstops: a rate limit and dedupe before any file is touched, the path rules again,
   * real-path containment with no `.git` segment, and a confirmation for secret-looking files.
   */
  private async openCode(path: string, target: string | undefined): Promise<void> {
    if (!this.openGate.allow(`${path}#${target ?? ''}`)) return;
    const link = parseCodeLink(target === undefined ? path : `${path}#${target}`);
    if (!link || link.path !== path) return;
    const root = this.ref.root;
    const name = plainForMessage(path.split('/').pop() ?? path, 80);
    const say = (text: string) => vscode.window.setStatusBarMessage(text, 5000);
    if (root.scheme !== 'file') return;
    const generation = this.generation;
    const checked = await checkCodePath(root.fsPath, path);
    if (this.disposed || generation !== this.generation) return;
    if (!checked.ok) {
      say(`Can't open ${name}: ${checked.why}.`);
      log.warn(`${this.ref.name}: data-explain-code="${plainForMessage(path, 200)}" not opened: ${checked.why}.`);
      return;
    }
    if (checked.secret) {
      const open = 'Open';
      const choice = await ourModal(() => vscode.window.showWarningMessage(`This sidestory links to ${name}. Open it?`, { modal: true, detail: 'Its name looks like it holds secrets (keys, tokens, passwords).' }, open));
      if (choice !== open || this.disposed || generation !== this.generation) return;
    }
    this.opening++;
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(checked.real));
      if (this.disposed || generation !== this.generation) return;
      const r = await resolveLink(doc, link, this.symbols, true);
      if (this.disposed || generation !== this.generation) return;
      if (!r.ok) {
        const what = link.target ? plainForMessage(link.target, 80) : name;
        say(`“${what}” not found in ${name}`);
        log.warn(`${this.ref.name}: data-explain-code="${plainForMessage(link.target ? `${path}#${link.target}` : path, 300)}": ${plainForMessage(r.message, 400)}.`);
        return;
      }
      const range = new vscode.Range(r.range.start - 1, 0, r.range.end - 1, 0);
      const editor = await vscode.window.showTextDocument(doc, { viewColumn: this.codeColumn(doc.uri), preserveFocus: false, preview: true, selection: new vscode.Range(range.start, range.start) });
      if (this.disposed) return;
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      editor.revealRange(new vscode.Range(range.start, range.start), vscode.TextEditorRevealType.Default);
      this.decorations.flash(editor, range);
      // The cursor is now in the link's code: ring what links there (the box just clicked, or a tighter one).
      void this.lightAt(editor.document, r.range.start);
    } catch (e) {
      say(`Can't open ${name}.`);
      log.warn(`${this.ref.name}: can't open ${plainForMessage(path, 200)}: ${(e as Error).message}`);
    } finally {
      this.opening--;
    }
  }

  /** Colors code blocks for the panel; per explainer shown, so one explainer's slow blocks don't stop another's. */
  private async highlight(blocks: Extract<FromWebview, { type: 'highlight' }>['blocks']): Promise<void> {
    const service = this.host.highlight;
    if (!service) return;
    // A panel sends one per render at most; more than this is a loop, never the reader typing.
    const now = Date.now();
    this.highlightTimes = [...this.highlightTimes.filter((t) => now - t < 1000), now];
    if (this.highlightTimes.length > 30) return;
    const dir = this.ref.dir.toString();
    if (this.highlightRequester?.dir !== dir) {
      if (this.highlightRequester) this.highlightRequester.who.disposed = true;
      this.highlightRequester = { dir, who: service.highlighter.newRequester() };
    }
    await service.whenReady();
    const r = await service.highlighter.request(this.highlightRequester.who, blocks);
    if (r && !this.disposed) this.post({ type: 'highlighted', ...r });
  }

  /** The colors of code blocks changed: the panel asks again for its blocks. */
  highlightThemeChanged(theme: string): void {
    this.post({ type: 'highlightTheme', theme });
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
    const choice = await ourModal(() => vscode.window.showInformationMessage(`The sidestory links to:\n\n${url}`, { modal: true, detail: 'It will open outside VS Code.' }, open));
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
    // The panel's choice overtakes a cursor move still waiting to be followed.
    clearTimeout(this.timers.get('cursor'));
    this.timers.delete('cursor');
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
    const dim = !moveCursor && !highContrast && vscode.workspace.getConfiguration('sidestory').get<boolean>('dimUnfocused', true);
    const uri = this.fileUri(a.file);
    const range = new vscode.Range(r.range.start - 1, 0, r.range.end - 1, 0);
    try {
      const editor = await vscode.window.showTextDocument(uri, {
        viewColumn: this.codeColumn(uri),
        preserveFocus: !moveCursor,
        preview: true,
        selection: moveCursor ? new vscode.Range(range.start, range.start) : undefined,
      });
      if (this.disposed) return;
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      // Vertically only: a long line (the cursor's, or one in the range) can leave the editor scrolled
      // sideways, cutting off the start of every line. Revealing the first line's start scrolls back.
      editor.revealRange(new vscode.Range(range.start, range.start), vscode.TextEditorRevealType.Default);
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
    this.ownSymbols?.dispose();
    if (this.highlightRequester) this.highlightRequester.who.disposed = true;
    this.decorations.set(undefined);
    this.onDisposeEmitter.fire();
    this.onDisposeEmitter.dispose();
  }
}

/**
 * Reader actions that end a preview panel's status (§7.5): a step change, a dive or Back, a widget input, or a
 * scroll that moved the active section. A cursor sync from the code isn't one (the panel posts nothing for it).
 */
function endsPreview(m: FromWebview): boolean {
  switch (m.type) {
    case 'focusAnchor':
      return m.source !== 'initial'; // the page opening at a section isn't the reader acting
    case 'dive':
    case 'goTo':
    case 'openRef':
    case 'openCode':
    case 'widgetStates':
    case 'widgetReveal':
      return true;
    default:
      return false;
  }
}

/**
 * For each change, how many characters followed its end on that line before the event.
 * In the new document that tail sits right after the change's inserted text, on a line we can
 * find by adding up the line counts of the changes above it. Changes that share a line with
 * another change are skipped (their columns shift), and get no value.
 */
export function endTails(doc: vscode.TextDocument, changes: readonly vscode.TextDocumentContentChangeEvent[]): Map<vscode.TextDocumentContentChangeEvent, number> {
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

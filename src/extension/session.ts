// One open explainer: keeps its anchors resolved against live buffers and the webview in sync.
import * as vscode from 'vscode';
import type { Anchor, LineRange, Manifest } from '../core/manifest.ts';
import { parseManifest } from '../core/manifest.ts';
import type { Resolution } from '../core/resolve.ts';
import { resolveAnchor } from '../core/resolve.ts';
import { anchorAtLine } from '../core/sections.ts';
import { PreparedText } from '../core/text.ts';
import { trackRange } from '../core/tracking.ts';
import type { AnchorView, FromWebview, ToWebview } from '../shared/protocol.ts';
import { assetMime, fromWebviewSchema, safeExternalUrl, themeColorVar } from '../shared/protocol.ts';
import type { Decorations } from './decorations.ts';
import type { ExplainerRef } from './explainers.ts';
import { htmlUri, manifestUri, MAX_ASSET_BYTES, MAX_CODE_BYTES, MAX_HTML_BYTES, MAX_MANIFEST_BYTES, readBytesInside, readInside } from './explainers.ts';
import { shellHtml } from './panel.ts';
import { realPathInside } from './paths.ts';

const RELOAD_DELAY = 120;
const RESOLVE_DELAY = 150;
const CURSOR_DELAY = 100;
/** Give the extension host back control after this much resolving. */
const SLICE_MS = 15;

const LOST: Resolution = { state: 'lost', range: null, location: 0, similarity: 0, ambiguous: false, method: 'none' };

export class ExplainerSession implements vscode.Disposable {
  readonly ref: ExplainerRef;
  readonly panel: vscode.WebviewPanel;
  private readonly decorations: Decorations;

  private manifest: Manifest | undefined;
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

  constructor(ref: ExplainerRef, panel: vscode.WebviewPanel, extensionUri: vscode.Uri, decorations: Decorations) {
    this.ref = ref;
    this.panel = panel;
    this.decorations = decorations;
    panel.webview.html = shellHtml(panel.webview, extensionUri, ref);
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(ref.dir, '{manifest.json,explainer.html}'));
    this.subscriptions.push(
      watcher,
      watcher.onDidChange(() => this.scheduleReload()),
      watcher.onDidCreate(() => this.scheduleReload()),
      watcher.onDidDelete(() => this.scheduleReload()),
      panel.webview.onDidReceiveMessage((m: unknown) => this.onMessage(m)),
      panel.onDidChangeViewState(() => this.updateContext()),
      panel.onDidDispose(() => this.dispose()),
      vscode.workspace.onDidChangeTextDocument((e) => this.onDocumentChange(e)),
      vscode.window.onDidChangeTextEditorSelection((e) => this.onSelection(e)),
      vscode.window.onDidChangeVisibleTextEditors(() => this.decorations.refresh()),
    );
    this.updateContext();
  }

  async load(): Promise<void> {
    await this.reload();
  }

  navigate(delta: 1 | -1): void {
    this.post({ type: 'navigate', delta });
  }

  // ---- loading ----

  private scheduleReload(): void {
    this.debounce('reload', RELOAD_DELAY, () => void this.reload());
  }

  private async reload(): Promise<void> {
    const [manifestText, html] = await Promise.all([
      readInside(manifestUri(this.ref), this.ref.root, MAX_MANIFEST_BYTES),
      readInside(htmlUri(this.ref), this.ref.root, MAX_HTML_BYTES),
    ]);
    if (this.disposed) return;
    if (manifestText === undefined || html === undefined) {
      const which = manifestText === undefined ? 'manifest.json' : 'explainer.html';
      this.post({ type: 'error', message: `Can't read ${which}: it is missing, outside the repo, or too large.` });
      return;
    }
    const parsed = parseManifest(manifestText);
    if (!parsed.ok) {
      this.post({ type: 'error', message: parsed.error });
      return;
    }
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
    this.title = parsed.manifest.title;
    this.panel.title = `Explainer: ${this.title || this.ref.name}`;
    this.post({ type: 'error', message: warnings.length ? `Some sections aren't linked:\n${warnings.join('\n')}` : null });
    if (contentChanged) this.post({ type: 'content', title: this.title, html: this.html });
    this.watchAnchorFiles();
    await this.resolveAll();
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
    return this.anchorList().filter((a) => this.fileUri(a.file).toString() === uri);
  }

  private async resolveAll(): Promise<void> {
    const files = new Set(this.anchorList().map((a) => this.fileUri(a.file).toString()));
    for (const f of files) await this.resolveFile(f, false);
    this.publishAnchors();
  }

  private scheduleResolve(uri: string): void {
    this.debounce(`resolve:${uri}`, RESOLVE_DELAY, () => void this.resolveFile(uri, true));
  }

  private async resolveFile(uri: string, publish: boolean): Promise<void> {
    const seq = (this.fileSeq.get(uri) ?? 0) + 1;
    this.fileSeq.set(uri, seq);
    const stillCurrent = () => !this.disposed && this.fileSeq.get(uri) === seq;

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
    if (ids.size === 0 || Date.now() < this.ignoreSelectionUntil) return;
    const line = e.selections[0]!.active.line + 1;
    // The reader clicked or typed in the code: stop fading the rest of the file.
    const byUser = e.kind === vscode.TextEditorSelectionChangeKind.Keyboard || e.kind === vscode.TextEditorSelectionChangeKind.Mouse;
    if (byUser && this.decorations.isDimmed()) this.decorateActive(false);
    this.debounce('cursor', CURSOR_DELAY, () => {
      const id = anchorAtLine(new Map([...this.resolutions].filter(([k]) => ids.has(k))), line);
      if (!id || id === this.active) return;
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
    switch (m.type) {
      case 'ready':
        this.post({ type: 'init', title: this.title, html: this.html, anchors: this.anchorViews(), active: this.active });
        break;
      case 'focusAnchor':
        if (!this.manifest?.anchors.has(m.anchorId)) return;
        this.setActive(m.anchorId);
        this.requestReveal(m.anchorId, false);
        break;
      case 'openExternal': {
        // The schema already refused local hosts and credentials; open the normalized form.
        const url = safeExternalUrl(m.url);
        if (url) void vscode.env.openExternal(vscode.Uri.parse(url, true));
        break;
      }
      case 'openFile':
        void this.openExplainerFile(m.path);
        break;
      case 'requestAsset':
        void this.sendAsset(m.id, m.path);
        break;
      case 'openRef':
        // A reference inside a section jumps to other code; the section being read stays active.
        if (!this.manifest?.anchors.has(m.anchorId)) return;
        this.requestReveal(m.anchorId, true);
        break;
    }
  }

  private setActive(id: string | undefined): void {
    this.active = id;
    if (!id) this.decorations.set(undefined);
  }

  /** Sends a file from the explainer folder to the content frame (it can't load files itself). */
  private async sendAsset(id: number, path: string): Promise<void> {
    const mime = assetMime(path);
    const data = mime ? await readBytesInside(vscode.Uri.joinPath(this.ref.dir, path), this.ref.dir, MAX_ASSET_BYTES) : undefined;
    this.post({ type: 'asset', id, mime: mime ?? '', data: data ? Buffer.from(data).toString('base64') : null });
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

  /** An editor column that isn't the explainer's. */
  private codeColumn(uri: vscode.Uri): vscode.ViewColumn {
    const editors = vscode.window.visibleTextEditors.filter((e) => e.viewColumn !== undefined && e.viewColumn !== this.panel.viewColumn);
    const same = editors.find((e) => e.document.uri.toString() === uri.toString());
    const column = (same ?? editors[0])?.viewColumn;
    if (column) return column;
    return this.panel.viewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One;
  }

  private post(message: ToWebview): void {
    // Messages to a hidden webview are dropped; it asks for everything again with `ready` when shown.
    if (this.panel.visible && !this.disposed) void this.panel.webview.postMessage(message);
  }

  private updateContext(): void {
    if (!this.disposed) void vscode.commands.executeCommand('setContext', 'codeExplainer.active', this.panel.visible);
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
    for (const d of [...this.subscriptions, ...this.fileWatchers]) d.dispose();
    this.decorations.set(undefined);
    void vscode.commands.executeCommand('setContext', 'codeExplainer.active', false);
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

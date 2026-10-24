// Explained here (docs/NAVIGATION-PLAN.md §7): CodeLens above code that sidestories cover, an optional gutter
// glyph, and a status bar item for the cursor's line. Anchors are resolved only for documents shown in
// editors (at most 8 at a time), with quotes read as slices of their manifests (§7.2); results are kept for
// 60 s after a document is hidden, in a 20-document LRU. Nothing here reads files that aren't anchored.
import * as vscode from 'vscode';
import { displayText, escapeIcons, middleTruncate } from '../../core/display-text.ts';
import type { LineRange, Quote } from '../../core/manifest.ts';
import type { AnchorState, Resolution } from '../../core/resolve.ts';
import { resolveAnchor } from '../../core/resolve.ts';
import { trackRange } from '../../core/tracking.ts';
import { coveringAnchors } from '../cursor.ts';
import { MAX_CODE_BYTES, uriKey } from '../explainers.ts';
import type { PreparedTextCache } from '../prepared-cache.ts';
import type { ExplainerSession } from '../session.ts';
import { endTails } from '../session.ts';
import type { IndexEntry, SidestoryIndex } from './index.ts';

export const HERE_LIMITS = {
  lensLines: 30,
  resolving: 8,
  keptDocs: 20,
  keptMs: 60_000,
  lensWaitMs: 50,
  editDelayMs: 400,
  cursorDelayMs: 100,
  sliceMs: 15,
  statusChars: 60,
  /** Past this many changes in one edit event, hints aren't tracked: the re-resolve places the lenses. */
  trackedChanges: 100,
} as const;

/** "Show Sidestories for This Code" with nothing to show (worded as the command's "explain"). */
export const NO_SIDESTORY_HERE = 'No sidestory explains this code.';

/** One anchor's place in one document. */
export interface HereItem {
  entry: IndexEntry;
  index: number;
  id: string;
  range: LineRange | null;
  state: AnchorState | 'pending';
  /** Trusted position, moved with edits until the next resolve. */
  hint?: LineRange;
}

interface DocResult {
  version: number;
  items: HereItem[];
  /** Hidden since (ms), or 0 while visible. */
  hiddenAt: number;
  /** A snapshot of what the lenses showed, to fire a change only when it differs. */
  shape: string;
}

/** What Explained here needs from the extension. */
export interface HereHost {
  sessions(): readonly ExplainerSession[];
  prepared: PreparedTextCache;
}

export class ExplainedHere implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly index: SidestoryIndex;
  private readonly host: HereHost;
  private readonly results = new Map<string, DocResult>();
  /** Bumped per document on every edit and resolve: work that finds it changed stops at its next slice. */
  private readonly seq = new Map<string, number>();
  /** The resolve running per document, with the version it started for. */
  private readonly inflight = new Map<string, { version: number; gen: number; p: Promise<void> }>();
  /** Bumped when the index or a panel changes: a resolve started before then is stale even for the same version. */
  private gen = 0;
  /** Documents whose lenses VS Code asked for before the results were ready (it got []): told when they are. */
  private readonly servedEarly = new Set<string>();
  /** Resolves waiting for one of the 8 slots. */
  private readonly queue: (() => void)[] = [];
  private running = 0;
  private readonly lensEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.lensEmitter.event;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private status: vscode.StatusBarItem | undefined;
  private gutter: vscode.TextEditorDecorationType | undefined;
  private disposed = false;
  private coveredKey = false;
  private readonly sessionSubs = new Map<ExplainerSession, vscode.Disposable[]>();
  /** For the status item's command. */
  private statusTarget: { dir: string; anchor: string; trail: string[] } | undefined;

  constructor(index: SidestoryIndex, host: HereHost, extensionUri: vscode.Uri) {
    this.index = index;
    this.host = host;
    this.subscriptions.push(
      this.lensEmitter,
      vscode.languages.registerCodeLensProvider({ scheme: 'file' }, this),
      vscode.workspace.onDidChangeTextDocument((e) => this.onEdit(e)),
      vscode.workspace.onDidCloseTextDocument((d) => this.drop(d.uri)),
      vscode.window.onDidChangeVisibleTextEditors(() => this.onVisible()),
      vscode.window.onDidChangeTextEditorSelection((e) => this.onSelection(e.textEditor)),
      vscode.window.onDidChangeActiveTextEditor((ed) => {
        // The context key right away, as on a selection change; the status bar after the pause.
        this.setCovered(!!ed && ed.document.uri.scheme === 'file' && this.anyCovering(ed.document.uri, ed.selection.active.line + 1));
        this.scheduleStatus();
      }),
      index.onDidChange(() => this.reresolveVisible()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('sidestory.codeLens.enabled')) this.lensEmitter.fire();
        if (e.affectsConfiguration('sidestory.statusBar.enabled')) this.scheduleStatus();
        if (e.affectsConfiguration('sidestory.gutter.enabled')) this.paintGutter();
      }),
    );
    this.extensionUri = extensionUri;
    this.onVisible();
  }

  private readonly extensionUri: vscode.Uri;

  /** A panel was created: its resolutions are an overlay for its sidestory, and its visibility hides lenses. */
  attach(s: ExplainerSession): void {
    const refresh = () => this.reresolveVisible();
    const subs = [
      s.onDidResolve((uri) => {
        if (this.results.has(uriKey(uri))) this.debounce(`overlay:${uriKey(uri)}`, 200, refresh);
      }),
      s.onDidSwitch(() => this.debounce('switch', 50, () => this.refreshShown())),
      s.panel.onDidChangeViewState(() => this.debounce('switch', 50, () => this.refreshShown())),
      s.onDidDispose(() => {
        for (const d of this.sessionSubs.get(s) ?? []) d.dispose();
        this.sessionSubs.delete(s);
        this.debounce('switch', 50, () => this.refreshShown());
      }),
    ];
    this.sessionSubs.set(s, subs);
    this.debounce('switch', 50, () => this.refreshShown());
  }

  /** Lenses, status and gutter depend on which sidestories visible panels show. */
  private refreshShown(): void {
    this.lensEmitter.fire();
    this.paintGutter();
    this.scheduleStatus();
  }

  /** Sidestories shown in visible panels: their lenses are hidden (§7.1), and the status bar skips them. */
  private shownKeys(): Set<string> {
    const out = new Set<string>();
    for (const s of this.host.sessions()) if (s.panel.visible) out.add(uriKey(s.ref.dir));
    return out;
  }

  /** Details the visible panels already offer through `childHint`. */
  private hintedKeys(shown: Set<string>): Set<string> {
    const out = new Set<string>();
    for (const k of shown) {
      const e = this.index.entry(k);
      const pkg = e && this.index.packageOf(e);
      if (!e || !pkg) continue;
      for (const child of pkg.graph.children(e.ref.name)) {
        const c = this.index.sibling(e, child);
        if (c) out.add(c.key);
      }
    }
    return out;
  }

  private lensesOn(doc: vscode.TextDocument): boolean {
    return vscode.workspace.getConfiguration('sidestory', doc).get<boolean>('codeLens.enabled', true);
  }

  // ---- CodeLens ----

  async provideCodeLenses(doc: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
    if (doc.uri.scheme !== 'file' || !this.lensesOn(doc)) return [];
    const key = uriKey(doc.uri);
    if (!this.index.isAnchored(key)) return [];
    let r = this.results.get(key);
    if (!r || r.version !== doc.version) {
      // Wait at most 50 ms: VS Code collects every provider's lenses before showing any (§7.3).
      const work = this.resolve(doc);
      await Promise.race([work, new Promise((res) => setTimeout(res, HERE_LIMITS.lensWaitMs))]);
      if (token.isCancellationRequested) return [];
      r = this.results.get(key);
      if (!r || r.version !== doc.version) {
        // VS Code now shows nothing; when this resolve lands, it must ask again even if nothing else changed.
        this.servedEarly.add(key);
        return [];
      }
    }
    return this.lenses(doc, r);
  }

  /** The lens items: sections only, not lost, not shown in a visible panel, one per anchor. */
  private visibleItems(r: DocResult): HereItem[] {
    const shown = this.shownKeys();
    return r.items.filter((it) => it.range && it.state !== 'lost' && it.state !== 'pending' && !shown.has(it.entry.key) && this.isSection(it));
  }

  private isSection(it: HereItem): boolean {
    return !it.entry.outlined || it.entry.stepOf[it.index]! >= 0;
  }

  private lenses(doc: vscode.TextDocument, r: DocResult): vscode.CodeLens[] {
    const items = this.visibleItems(r);
    const byLine = new Map<number, HereItem[]>();
    for (const it of items) {
      const line = Math.min(it.range!.start, doc.lineCount) - 1;
      const list = byLine.get(line);
      if (list) list.push(it);
      else byLine.set(line, [it]);
    }
    const lines = [...byLine.keys()].sort((a, b) => a - b);
    const out: vscode.CodeLens[] = [];
    for (const line of lines.slice(0, HERE_LIMITS.lensLines)) {
      // One entry per (sidestory, step): nested anchors of one step starting on the same line count once.
      const list = uniqueSteps(sortTightest(byLine.get(line)!), (it) => this.stepKey(it));
      const first = list[0]!;
      const range = new vscode.Range(line, 0, line, 0);
      const more = list.length - 1;
      const title = `$(book) ${escapeIcons(this.describe(first))}${first.state === 'stale' ? ' (code changed a lot)' : ''}${more ? ` and ${more} more` : ''}`;
      // "and N more" opens exactly the steps it counted.
      const command: vscode.Command = more
        ? { title, command: 'sidestory.showHere', arguments: [{ uri: doc.uri.toString(), line: line + 1, keys: list.map((it) => this.stepKey(it)) }] }
        : { title, command: 'sidestory.openAt', arguments: [this.openArgs(first, 'lens')] };
      out.push(new vscode.CodeLens(range, command));
    }
    if (lines.length > HERE_LIMITS.lensLines) {
      const line = lines[HERE_LIMITS.lensLines]!;
      // It lists every step in the file, so it counts them all, not just those past the cut.
      const all = new Set(lines.flatMap((l) => byLine.get(l)!.map((it) => this.stepKey(it)))).size;
      const title = `$(book) All ${all} sidestory step${all === 1 ? '' : 's'} in this file`;
      out.push(new vscode.CodeLens(new vscode.Range(line, 0, line, 0), { title, command: 'sidestory.showHere', arguments: [{ uri: doc.uri.toString(), all: true }] }));
    }
    return out;
  }

  /** `Stream DMA engine › DMA controller · step 3: FSM states` */
  describe(it: HereItem, withTitle = true): string {
    const e = it.entry;
    const path = this.index.pathLabel(e);
    const step = e.outlined ? e.stepOf[it.index]! : -1;
    if (step < 0) return path;
    const s = e.steps[step]!;
    return withTitle ? `${path} · step ${step + 1}: ${s.title}` : `${path} · step ${step + 1}`;
  }

  /** The step title of an item (its own anchor's step), or the anchor id before the outline is known. */
  stepTitle(it: HereItem): string {
    const step = it.entry.outlined ? it.entry.stepOf[it.index]! : -1;
    return step >= 0 ? it.entry.steps[step]!.title : it.id;
  }

  /** Identifies an item's (sidestory, step): nested anchors fold into their step. */
  stepKey(it: HereItem): string {
    return `${it.entry.key}\u0000${anchorOf(it)}`;
  }

  /** Items of a document whose step keys are given (what an "and N more" lens counted), in that order. */
  byKeys(uri: vscode.Uri, keys: readonly string[]): HereItem[] {
    const r = this.results.get(uriKey(uri));
    if (!r) return [];
    const found = new Map<string, HereItem>();
    for (const it of this.visibleItems(r)) {
      const k = this.stepKey(it);
      if (!found.has(k)) found.set(k, it);
    }
    return keys.map((k) => found.get(k)).filter((x): x is HereItem => !!x);
  }

  openArgs(it: HereItem, source: string): { dir: string; anchor: string; trail: string[]; source: string } {
    return { dir: it.entry.ref.dir.toString(), anchor: anchorOf(it), trail: this.index.trail(it.entry), source };
  }

  // ---- resolving ----

  /** Resolves a document's anchors (once per version), queued so at most 8 resolve at a time. */
  private resolve(doc: vscode.TextDocument): Promise<void> {
    const key = uriKey(doc.uri);
    const running = this.inflight.get(key);
    if (running) {
      // Reused only for the same version and generation; an older one gives up at its next check, then this starts.
      if (running.version === doc.version && running.gen === this.gen) return running.p;
      return running.p.then(() => (this.results.get(key)?.version === doc.version || doc.isClosed || this.disposed ? undefined : this.resolve(doc)));
    }
    const version = doc.version;
    const gen = this.gen;
    const p = new Promise<void>((done) => {
      const go = () => {
        this.running++;
        void this.resolveNow(doc)
          .catch(() => {})
          .finally(() => {
            this.running--;
            this.inflight.delete(key);
            done();
            this.queue.shift()?.();
          });
      };
      if (this.running < HERE_LIMITS.resolving) go();
      else this.queue.push(go);
    });
    this.inflight.set(key, { version, gen, p });
    return p;
  }

  private async resolveNow(doc: vscode.TextDocument): Promise<void> {
    const key = uriKey(doc.uri);
    const seq = (this.seq.get(key) ?? 0) + 1;
    this.seq.set(key, seq);
    const version = doc.version;
    const gen = this.gen;
    const slots = this.index.anchorsIn(key);
    // The index replaces an entry's arrays when it re-reads it (and then fires onDidChange, which resolves again):
    // work on old ones stops at the next check. Not `version`: it is bumped by every event, also when the re-read
    // finds nothing changed, and no change event then follows to restart the work.
    const arrays = new Map(slots.map((s) => [s.entry, { ids: s.entry.ids, file: s.entry.file }]));
    const entriesSame = () => {
      for (const [e, a] of arrays) if (e.ids !== a.ids || e.file !== a.file) return false;
      return true;
    };
    const current = () => !this.disposed && !doc.isClosed && this.seq.get(key) === seq && doc.version === version && this.gen === gen && entriesSame();
    const previous = this.results.get(key);
    const prevItems = new Map((previous?.items ?? []).map((it) => [`${it.entry.key}\u0000${it.id}`, it]));
    if (!slots.length) {
      this.store(key, { version, items: [], hiddenAt: 0, shape: '' });
      return;
    }
    // Documents too large to compare are skipped (§7.1).
    // (Measured without copying the buffer: characters, a lower bound on bytes.)
    if (doc.offsetAt(doc.lineAt(Math.max(0, doc.lineCount - 1)).range.end) > MAX_CODE_BYTES) {
      this.store(key, { version, items: [], hiddenAt: 0, shape: '' });
      return;
    }
    // Panels showing a sidestory already resolve its anchors here: use theirs (checked against their generation).
    const overlays = new Map<string, Map<string, Resolution>>();
    for (const s of this.host.sessions()) {
      const k = uriKey(s.ref.dir);
      if (overlays.has(k)) continue;
      const res = s.resolutionsFor(doc.uri.toString(), s.ref.dir.toString(), s.currentGeneration);
      if (res && res.size) overlays.set(k, res);
    }
    // Quotes for pinned anchors, per sidestory (cache or slices, within the shared budget).
    const byEntry = new Map<IndexEntry, number[]>();
    for (const s of slots) {
      if (overlays.has(s.entry.key)) continue;
      const list = byEntry.get(s.entry);
      if (list) list.push(s.index);
      else byEntry.set(s.entry, [s.index]);
    }
    const quotes = new Map<IndexEntry, Map<number, Quote | null>>();
    for (const [e, idxs] of byEntry) {
      const pinned = idxs.filter((i) => e.qLen[i] !== 0);
      if (pinned.length) quotes.set(e, await this.index.quotesFor(e, pinned, current));
      if (!current()) return;
    }
    const text = this.host.prepared.get(key, version, () => doc.getText());
    const items: HereItem[] = [];
    let slice = Date.now();
    for (const s of slots) {
      if (Date.now() - slice > HERE_LIMITS.sliceMs) {
        await new Promise((r) => setImmediate(r));
        if (!current()) return;
        slice = Date.now();
      }
      const e = s.entry;
      const id = e.ids[s.index]!;
      const prev = prevItems.get(`${e.key}\u0000${id}`);
      const overlay = overlays.get(e.key)?.get(id);
      if (overlay) {
        items.push({ entry: e, index: s.index, id, range: overlay.range, state: overlay.state, hint: overlay.range && overlay.state !== 'stale' && !overlay.ambiguous ? overlay.range : undefined });
        continue;
      }
      const pinned = e.qLen[s.index] !== 0;
      const q = quotes.get(e)?.get(s.index);
      if (pinned && !q) {
        // A lens on the wrong lines is worse than a late one: never place a pinned anchor by its manifest range.
        items.push({ entry: e, index: s.index, id, range: null, state: 'pending' });
        continue;
      }
      const r = resolveAnchor(text, this.index.anchorAt(e, s.index, q ?? undefined), { hint: prev?.hint, previous: prev?.state === 'pending' ? undefined : prev?.state });
      items.push({ entry: e, index: s.index, id, range: r.range, state: r.state, hint: r.range && !r.ambiguous && r.state !== 'stale' ? r.range : undefined });
    }
    if (!current()) return;
    this.store(key, { version, items, hiddenAt: 0, shape: '' });
  }

  private store(key: string, r: DocResult): void {
    const old = this.results.get(key);
    r.shape = shapeOf(r.items);
    this.results.delete(key);
    this.results.set(key, r);
    // At most 20 documents' results (never their texts); the oldest hidden go first.
    if (this.results.size > HERE_LIMITS.keptDocs) {
      const visible = this.visibleKeys();
      for (const k of this.results.keys()) {
        if (this.results.size <= HERE_LIMITS.keptDocs) break;
        if (!visible.has(k)) this.results.delete(k);
      }
    }
    const early = this.servedEarly.delete(key);
    if (!old || old.shape !== r.shape || early) this.lensEmitter.fire();
    this.paintGutter();
    this.scheduleStatus();
  }

  private visibleKeys(): Set<string> {
    return new Set(vscode.window.visibleTextEditors.filter((e) => e.document.uri.scheme === 'file').map((e) => uriKey(e.document.uri)));
  }

  /** Resolving starts when a document is shown, before VS Code asks for lenses (§7.3). */
  private onVisible(): void {
    const visible = this.visibleKeys();
    const now = Date.now();
    for (const [k, r] of this.results) {
      if (visible.has(k)) r.hiddenAt = 0;
      else if (!r.hiddenAt) r.hiddenAt = now;
    }
    this.debounce('expire', HERE_LIMITS.keptMs, () => this.expire());
    for (const ed of vscode.window.visibleTextEditors) {
      const doc = ed.document;
      if (doc.uri.scheme !== 'file' || !this.index.isAnchored(uriKey(doc.uri))) continue;
      const r = this.results.get(uriKey(doc.uri));
      if (!r || r.version !== doc.version) void this.resolve(doc);
    }
    this.paintGutter();
    this.scheduleStatus();
  }

  private expire(): void {
    const now = Date.now();
    for (const [k, r] of [...this.results]) if (r.hiddenAt && now - r.hiddenAt >= HERE_LIMITS.keptMs) this.results.delete(k);
    if ([...this.results.values()].some((r) => r.hiddenAt)) this.debounce('expire', HERE_LIMITS.keptMs, () => this.expire());
  }

  private drop(uri: vscode.Uri): void {
    const k = uriKey(uri);
    this.results.delete(k);
    this.seq.delete(k);
    this.servedEarly.delete(k);
  }

  /** The index or a panel changed: resolve shown documents again. */
  private reresolveVisible(): void {
    this.gen++;
    for (const r of this.results.values()) r.version = -1;
    this.onVisible();
    this.lensEmitter.fire();
  }

  // ---- live edits ----

  private onEdit(e: vscode.TextDocumentChangeEvent): void {
    // Every keystroke in every document: the cheapest checks first.
    if (e.document.uri.scheme !== 'file' || e.contentChanges.length === 0) return;
    const key = uriKey(e.document.uri);
    const r = this.results.get(key);
    if (!r) return;
    // Work in flight is now on old text.
    this.seq.set(key, (this.seq.get(key) ?? 0) + 1);
    // A huge multi-edit (replace all): tracking every hint through every change costs more than resolving again.
    const many = e.contentChanges.length > HERE_LIMITS.trackedChanges;
    const tails = many ? new Map() : endTails(e.document, e.contentChanges);
    const changes = many ? [] : [...e.contentChanges].sort((x, y) => y.range.start.compareTo(x.range.start));
    for (const it of r.items) {
      if (!it.hint) continue;
      if (many) {
        it.hint = undefined;
        continue;
      }
      let hint = it.hint;
      for (const c of changes) {
        const t = trackRange(hint, {
          start: { line: c.range.start.line + 1, col: c.range.start.character },
          end: { line: c.range.end.line + 1, col: c.range.end.character },
          text: c.text,
          endTail: tails.get(c),
        });
        hint = t.range;
        if (t.orphaned) break;
      }
      it.hint = hint;
    }
    this.debounce(`edit:${key}`, HERE_LIMITS.editDelayMs, () => {
      const doc = vscode.window.visibleTextEditors.find((ed) => uriKey(ed.document.uri) === key)?.document;
      if (doc) void this.resolve(doc);
    });
  }

  // ---- the cursor: status bar and the context key ----

  private onSelection(editor: vscode.TextEditor): void {
    if (editor.document.uri.scheme !== 'file') return;
    // The context key now (a right-click follows the click that moved the cursor); the status bar after a pause.
    if (editor === vscode.window.activeTextEditor) this.setCovered(this.anyCovering(editor.document.uri, editor.selection.active.line + 1));
    this.scheduleStatus();
  }

  /** `sidestory.coveredHere`, for "Show Sidestories for This Code" in the editor context menu. */
  private setCovered(anyHere: boolean): void {
    if (anyHere === this.coveredKey) return;
    this.coveredKey = anyHere;
    void vscode.commands.executeCommand('setContext', 'sidestory.coveredHere', anyHere);
  }

  private scheduleStatus(): void {
    this.debounce('status', HERE_LIMITS.cursorDelayMs, () => this.updateStatus());
  }

  /** Items covering a line of a document, best first, from results already in memory (no I/O). */
  covering(uri: vscode.Uri, line: number, opts: { forStatus?: boolean } = {}): HereItem[] {
    const r = this.results.get(uriKey(uri));
    if (!r) return [];
    const shown = opts.forStatus ? this.shownKeys() : new Set<string>();
    const hinted = opts.forStatus ? this.hintedKeys(shown) : new Set<string>();
    const pool = r.items.filter((it) => it.range && it.state !== 'lost' && it.state !== 'pending' && this.isSection(it) && !shown.has(it.entry.key) && !hinted.has(it.entry.key));
    const byKey = new Map(pool.map((it) => [`${it.entry.key}\u0000${it.id}`, it]));
    const order = coveringAnchors(
      pool.map((it) => [`${it.entry.key}\u0000${it.id}`, { range: it.range, state: it.state }] as const),
      line,
      { includeStale: !opts.forStatus },
    );
    return order.map((c) => byKey.get(c.id)!);
  }

  /** Whether `covering(uri, line)` would return anything: the first hit returns, nothing is allocated. */
  anyCovering(uri: vscode.Uri, line: number): boolean {
    const r = this.results.get(uriKey(uri));
    if (!r) return false;
    for (const it of r.items) {
      if (!it.range || line < it.range.start || line > it.range.end) continue;
      if (it.state !== 'lost' && it.state !== 'pending' && this.isSection(it)) return true;
    }
    return false;
  }

  /** Every resolved item of a document, any sidestory, shown in a panel or not (This File, docs/CHANGES-PLAN.md §9.10). */
  resolvedItems(uri: vscode.Uri): readonly HereItem[] {
    return this.results.get(uriKey(uri))?.items ?? [];
  }

  /** Every item in a document (for the lens that lists them all), by start line, tightest first within a line. */
  all(uri: vscode.Uri): HereItem[] {
    const r = this.results.get(uriKey(uri));
    if (!r) return [];
    return this.visibleItems(r).sort((a, b) => a.range!.start - b.range!.start || a.range!.end - a.range!.start - (b.range!.end - b.range!.start));
  }

  private updateStatus(): void {
    if (this.disposed) return;
    const editor = vscode.window.activeTextEditor;
    const on = vscode.workspace.getConfiguration('sidestory').get<boolean>('statusBar.enabled', true);
    const line = editor ? editor.selection.active.line + 1 : 0;
    const anyHere = editor && editor.document.uri.scheme === 'file' ? this.anyCovering(editor.document.uri, line) : false;
    this.setCovered(anyHere);
    if (!on) {
      this.status?.dispose();
      this.status = undefined;
      return;
    }
    const items = editor && editor.document.uri.scheme === 'file' ? this.covering(editor.document.uri, line, { forStatus: true }) : [];
    const first = items[0];
    if (!first) {
      this.status?.hide();
      this.statusTarget = undefined;
      return;
    }
    if (!this.status) {
      // Right side, next to Ln/Col: it is about the cursor. `name` lets the status bar's menu hide it.
      this.status = vscode.window.createStatusBarItem('sidestory.here', vscode.StatusBarAlignment.Right, 100);
      this.status.name = 'Sidestory';
      this.status.command = { title: 'Open', command: 'sidestory.statusOpen' };
    }
    const panelOpen = this.host.sessions().some((s) => s.panel.visible);
    const label = panelOpen ? `Also in: ${this.index.pathLabel(first.entry)}` : this.describe(first, false);
    const text = `$(book) ${escapeIcons(middleTruncate(label, HERE_LIMITS.statusChars))}`;
    const parents = this.index.packageOf(first.entry)?.graph.parents(first.entry.ref.name) ?? [];
    const tooltip = [
      this.index.pathLabel(first.entry),
      this.stepTitle(first),
      parents.length ? `Also under ${parents.slice(0, 5).map((n) => (this.index.sibling(first.entry, n) ? this.index.name(this.index.sibling(first.entry, n)!) : displayText(n, 64))).join(', ')}${parents.length > 5 ? ` and ${parents.length - 5} more` : ''}` : '',
      ...(() => {
        const more = new Set(items.map((it) => this.stepKey(it))).size - 1;
        return more > 0 ? [`${more} more cover this line`] : [];
      })(),
      'Click to open',
    ]
      .filter(Boolean)
      .join('\n');
    if (this.status.text !== text) this.status.text = text;
    // Plain text only: never a MarkdownString (§11.4).
    if (this.status.tooltip !== tooltip) this.status.tooltip = tooltip;
    this.statusTarget = this.openArgs(first, 'status');
    this.status.show();
  }

  /** The status item's click. */
  statusOpenArgs(): { dir: string; anchor: string; trail: string[] } | undefined {
    return this.statusTarget;
  }

  // ---- gutter ----

  private paintGutter(): void {
    const on = vscode.workspace.getConfiguration('sidestory').get<boolean>('gutter.enabled', false);
    if (!on) {
      this.gutter?.dispose();
      this.gutter = undefined;
      return;
    }
    this.gutter ??= vscode.window.createTextEditorDecorationType({
      gutterIconPath: vscode.Uri.joinPath(this.extensionUri, 'media', 'gutter.svg'),
      gutterIconSize: '70%',
      overviewRulerColor: new vscode.ThemeColor('sidestory.explainedRuler'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    for (const ed of vscode.window.visibleTextEditors) {
      const r = ed.document.uri.scheme === 'file' ? this.results.get(uriKey(ed.document.uri)) : undefined;
      const lines = r && r.version === ed.document.version ? [...new Set(this.visibleItems(r).map((it) => it.range!.start - 1))] : [];
      ed.setDecorations(
        this.gutter,
        lines.map((l) => new vscode.Range(l, 0, l, 0)),
      );
    }
  }

  private debounce(key: string, ms: number, fn: () => void): void {
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        if (!this.disposed) fn();
      }, ms),
    );
  }

  /** Numbers for tests. */
  stats() {
    return { documents: this.results.size, resolving: this.running, queued: this.queue.length };
  }

  dispose(): void {
    this.disposed = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const d of this.subscriptions) d.dispose();
    for (const subs of this.sessionSubs.values()) for (const d of subs) d.dispose();
    this.sessionSubs.clear();
    this.status?.dispose();
    this.gutter?.dispose();
    this.results.clear();
    this.queue.length = 0;
  }
}

/** The anchor an item opens at: nested anchors fold into their step, as the panel's navigator would. */
function anchorOf(it: HereItem): string {
  const step = it.entry.outlined ? it.entry.stepOf[it.index]! : -1;
  return step >= 0 ? it.entry.steps[step]!.id : it.id;
}

function uniqueSteps(list: HereItem[], key: (it: HereItem) => string): HereItem[] {
  const seen = new Set<string>();
  return list.filter((it) => {
    const k = key(it);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function sortTightest(list: HereItem[]): HereItem[] {
  return [...list].sort((a, b) => Number(a.state === 'stale') - Number(b.state === 'stale') || a.range!.end - a.range!.start - (b.range!.end - b.range!.start) || a.entry.ref.name.localeCompare(b.entry.ref.name));
}

/** What the lenses would show: start lines and states, per anchor. */
function shapeOf(items: HereItem[]): string {
  return items.map((it) => `${it.entry.key}\u0000${it.id}:${it.range?.start ?? 0}:${it.state}`).join('\n');
}

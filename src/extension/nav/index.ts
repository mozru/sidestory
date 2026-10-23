// The workspace index (docs/NAVIGATION-PLAN.md §6): every sidestory in the window, with its title, summary,
// group, anchors (packed) and outline (steps and detail links), the detail graph per package, and which anchors
// each code file has. One per window, owned by the extension; the sidebar, Explained here, Go to Step and Open
// Sidestory read from it. It only reads repository text, never runs it, and every read and scan is bounded
// (§6.5, §11.1), so it runs in Restricted Mode too.
import * as vscode from 'vscode';
import { buildDetailGraph, MAX_GRAPH_EDGES, mergeGroups, type DetailGraph } from '../../core/detail-graph.ts';
import { displayText } from '../../core/display-text.ts';
import { excludePatterns, globMatcher, joinGlobs } from '../../core/glob.ts';
import { OutlineScanner, type OutlineStep } from '../../core/html-scan.ts';
import { anchorSpecSchema, parseManifest, type Anchor, type Quote } from '../../core/manifest.ts';
import { quoteHash, quotePositions } from '../../core/quote-positions.ts';
import type { ExplainerRef } from '../explainers.ts';
import { htmlUri, manifestUri, MAX_HTML_BYTES, MAX_MANIFEST_BYTES, readBytesInside, readSliceInside, refFromDir, uriKey } from '../explainers.ts';
import { log } from '../log.ts';
import { packageKeyOf, packageLabel, longestPrefixPackage } from './packages.ts';
import type { SidestoryEvent, SidestoryWatcher } from './watcher.ts';

/** Aggregate caps (§6.1, §11.1): a hostile repository can otherwise reach millions. */
export const INDEX_LIMITS = {
  sidestories: 5000,
  discoveryRequest: 20_000,
  anchors: 100_000,
  steps: 100_000,
  anchorsPerFile: 2000,
  anchorsPerFilePerSidestory: 200,
  edges: MAX_GRAPH_EDGES,
  manifestBytesPerBatch: 100_000_000,
  pageBytesPerBatch: 200_000_000,
  scanMsPerBatch: 10_000,
  readsInFlight: 4,
  sliceMs: 15,
  debounceMs: 300,
  debounceMaxMs: 2000,
  followUpMs: 30_000,
  followUpMaxMs: 600_000,
  reconcileThrottleMs: 30_000,
  reconcileBatch: 50,
  quoteBudgetBytes: 4_000_000,
  quoteRefillPerSec: 1_000_000,
  quoteCacheChars: 10_000_000, // 20 MB as UTF-16
} as const;

export type EntryState = 'discovered' | 'ready' | 'not-read' | 'not-outlined';

/** One sidestory in the index. Arrays are packed per sidestory (§6.1); no quote text is kept. */
export interface IndexEntry {
  readonly ref: ExplainerRef;
  readonly key: string;
  readonly pkg: string;
  /** Bumped on every event for its files: a read applies only if it is unchanged. */
  version: number;
  manifestStamp?: string;
  pageStamp?: string;
  title: string;
  summary: string;
  group?: string;
  top?: boolean;
  /** Anchor ids, with their file ids (into the index's file table), manifest ranges and quote positions. */
  ids: string[];
  file: Int32Array;
  start: Int32Array;
  end: Int32Array;
  /** Quote byte offset and length in manifest.json (−1 when unpinned or unknown), and the quote's hash. */
  qOff: Int32Array;
  qLen: Int32Array;
  qHash: Int32Array;
  /** Step index per anchor (−1: not inside a step, so not a section). */
  stepOf: Int16Array;
  steps: OutlineStep[];
  /** Detail links in document order (raw names; the graph validates them). */
  details: string[];
  /** Outline known (the page was scanned). */
  outlined: boolean;
  truncated: boolean;
  /** Anchors or steps cut by an aggregate cap. */
  capped: boolean;
  state: EntryState;
  errors: string[];
  /** manifest.json had bytes that aren't UTF-8: offsets can't be trusted, quotes come from whole reads. */
  noSlices: boolean;
}

export interface IndexPackage {
  readonly key: string;
  /** The `.sidestory` folder. */
  readonly folder: vscode.Uri;
  readonly root: vscode.Uri;
  readonly rootKey: string;
  label: string;
  entries: Map<string, IndexEntry>;
  /** The same entries by folder name. */
  byName: Map<string, IndexEntry>;
  graph: DetailGraph;
  groups: { key: string; label: string; members: string[] }[];
  edges: number;
}

export interface FileSlot {
  entry: IndexEntry;
  /** Index into the entry's anchor arrays. */
  index: number;
}

const EMPTY_GRAPH = buildDetailGraph([]);
const quoteSchema = anchorSpecSchema.shape.quote;

/** Holds every sidestory, keeps it current, and answers the navigation features' questions. */
export class SidestoryIndex implements vscode.Disposable {
  private readonly entries = new Map<string, IndexEntry>();
  private readonly packagesByKey = new Map<string, IndexPackage>();
  /** Interned file keys (`uriKey`): anchors store the number. */
  private readonly fileIds = new Map<string, number>();
  private readonly fileKeys: string[] = [];
  /** Which sidestories anchor each file. */
  private readonly fileRefs = new Map<number, Set<string>>();
  /** Per file: the anchors kept for it (fair, capped), built lazily. */
  private readonly fileTables = new Map<number, FileSlot[]>();
  private readonly dirty = new Set<string>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly emitter = new vscode.EventEmitter<{ packages: Set<string> }>();
  /** Fires once per batch with the packages it changed. */
  readonly onDidChange = this.emitter.event;
  private readonly stateEmitter = new vscode.EventEmitter<'loading' | 'empty' | 'ready'>();
  readonly onDidChangeState = this.stateEmitter.event;
  private epoch = 0;
  private disposed = false;
  private debounce: { timer: ReturnType<typeof setTimeout>; first: number } | undefined;
  private followUp: { timer: ReturnType<typeof setTimeout>; delay: number } | undefined;
  private running: Promise<void> | undefined;
  private rerun = false;
  private lastReconcile = 0;
  private totals = { anchors: 0, steps: 0 };
  /** Discovery found more than the cap: "Showing the first 5,000" (and "at least 20,000" past the request). */
  discoveryCut: { found: number; atLeast: boolean } | undefined;
  /** An aggregate cap stopped indexing for the rest. */
  capped = false;
  private stateValue: 'loading' | 'empty' | 'ready' = 'loading';
  private readyResolve!: () => void;
  /** Settles when discovery and the first metadata batch are done. */
  readonly ready = new Promise<void>((r) => (this.readyResolve = r));
  private readonly quotes: QuoteStore;
  /** Lower sorts first: sidestories in use (open panels, recently opened) before the rest. Set by the extension. */
  priority: (key: string) => number = () => Number.MAX_SAFE_INTEGER;
  private exclude: (rel: string) => boolean = () => false;

  constructor(watcher: SidestoryWatcher) {
    this.quotes = new QuoteStore(this);
    this.subscriptions.push(
      watcher.onDidChange((e) => this.onWatch(e)),
      vscode.workspace.onDidChangeTextDocument((e) => this.onDocument(e.document, e.contentChanges.length > 0)),
      vscode.workspace.onDidCloseTextDocument((d) => this.onDocument(d, true)),
      vscode.workspace.onDidDeleteFiles((e) => this.removeUnder(e.files)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.refresh()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('files.exclude')) void this.refresh();
      }),
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused) void this.reconcile();
      }),
      this.emitter,
      this.stateEmitter,
      this.quotes,
    );
  }

  // ---- what readers ask ----

  get state(): 'loading' | 'empty' | 'ready' {
    return this.stateValue;
  }

  all(): IterableIterator<IndexEntry> {
    return this.entries.values();
  }

  get size(): number {
    return this.entries.size;
  }

  entry(dir: vscode.Uri | string): IndexEntry | undefined {
    return this.entries.get(typeof dir === 'string' ? dir : uriKey(dir));
  }

  packages(): IndexPackage[] {
    return [...this.packagesByKey.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }) || a.key.localeCompare(b.key));
  }

  packageOf(e: IndexEntry): IndexPackage | undefined {
    return this.packagesByKey.get(e.pkg);
  }

  /** The sidestory's display name: its title, else its folder name. */
  name(e: IndexEntry): string {
    return e.title || displayText(e.ref.name, 120);
  }

  /** Names on the primary path, top first (§4.3); just the sidestory when it is a top or unknown. */
  primaryPath(e: IndexEntry): string[] {
    const p = this.packageOf(e)?.graph.primaryPath(e.ref.name);
    return p ? [...p] : [e.ref.name];
  }

  /** Refs on the primary path, top first: a trail for the panel. */
  primaryTrail(e: IndexEntry): [ExplainerRef, ...ExplainerRef[]] {
    const pkg = this.packageOf(e);
    const refs = this.primaryPath(e).map((n) => pkg?.byName.get(n)?.ref ?? refFromDir(vscode.Uri.joinPath(e.ref.dir, '..', n)));
    if (refs.some((r) => !r) || refs.length === 0) return [e.ref];
    return refs as [ExplainerRef, ...ExplainerRef[]];
  }

  /** "Top › Detail": the primary path's titles. */
  pathLabel(e: IndexEntry): string {
    const pkg = this.packageOf(e);
    return this.primaryPath(e)
      .map((n) => {
        const x = pkg?.byName.get(n);
        return x ? this.name(x) : displayText(n, 120);
      })
      .join(' › ');
  }

  /** The entry for a sibling name in the same package. */
  sibling(e: IndexEntry, name: string): IndexEntry | undefined {
    return this.packageOf(e)?.byName.get(name);
  }

  /** Step count from the outline (§8.2), or undefined before it is known. */
  stepCount(dir: vscode.Uri | string): number | undefined {
    const e = this.entry(dir);
    return e?.outlined ? e.steps.length : undefined;
  }

  /** The ids that are sections (inside a step), or undefined before the outline is known. */
  sections(e: IndexEntry): Set<string> | undefined {
    if (!e.outlined) return undefined;
    const s = new Set<string>();
    e.ids.forEach((id, i) => {
      if (e.stepOf[i]! >= 0) s.add(id);
    });
    return s;
  }

  isAnchored(fileKey: string): boolean {
    const id = this.fileIds.get(fileKey);
    return id !== undefined && (this.fileRefs.get(id)?.size ?? 0) > 0;
  }

  /**
   * The anchors kept for a file (§6.1): deterministic order (in use first, then package and name), at most
   * 200 from any one sidestory and 2,000 in all.
   */
  anchorsIn(fileKey: string): readonly FileSlot[] {
    const id = this.fileIds.get(fileKey);
    if (id === undefined) return [];
    let table = this.fileTables.get(id);
    if (!table) {
      table = [];
      const refs = [...(this.fileRefs.get(id) ?? [])].map((k) => this.entries.get(k)).filter((e): e is IndexEntry => !!e);
      refs.sort((a, b) => this.priority(a.key) - this.priority(b.key) || a.pkg.localeCompare(b.pkg) || a.ref.name.localeCompare(b.ref.name));
      for (const e of refs) {
        let n = 0;
        for (let i = 0; i < e.ids.length && n < INDEX_LIMITS.anchorsPerFilePerSidestory && table.length < INDEX_LIMITS.anchorsPerFile; i++) {
          if (e.file[i] === id) {
            table.push({ entry: e, index: i });
            n++;
          }
        }
        if (table.length >= INDEX_LIMITS.anchorsPerFile) break;
      }
      this.fileTables.set(id, table);
    }
    return table;
  }

  /**
   * The anchors whose manifest ranges overlap lines `start`–`end` (1-based, inclusive) of a file: a cheap answer
   * from memory, no I/O, O(anchors kept for the file). For callers outside CodeLens too (a future "Changes"
   * view asking which changed hunks are explained). Live positions in an open document come from
   * ExplainedHere.covering / .all, which resolve against the buffer.
   */
  anchorsCovering(fileKey: string, start: number, end: number): FileSlot[] {
    return this.anchorsIn(fileKey).filter((s) => s.entry.start[s.index]! <= end && s.entry.end[s.index]! >= start);
  }

  /** An anchor as the resolver needs it, with its quote (fetched by `quotesFor`). */
  anchorAt(e: IndexEntry, i: number, quote?: Quote): Anchor {
    return { id: e.ids[i]!, file: '', range: { start: e.start[i]!, end: e.end[i]! }, quote, highlight: [] };
  }

  /** Quotes of pinned anchors, from the cache or read as slices within the shared budget (§7.2). */
  quotesFor(e: IndexEntry, indexes: readonly number[], isCurrent: () => boolean): Promise<Map<number, Quote | null>> {
    return this.quotes.fetch(e, indexes, isCurrent);
  }

  /** The packages that count for a file (§5.1): the longest-prefix package, plus every package anchoring it. */
  packagesForFile(fileKey: string): Set<string> {
    const out = new Set<string>();
    const roots = new Map([...this.packagesByKey.values()].map((p) => [p.key, p.rootKey]));
    const longest = longestPrefixPackage(fileKey, roots);
    if (longest) out.add(longest);
    const id = this.fileIds.get(fileKey);
    for (const k of (id !== undefined && this.fileRefs.get(id)) || []) {
      const e = this.entries.get(k);
      if (e) out.add(e.pkg);
    }
    return out;
  }

  /** Numbers for tests and the perf smoke (`sidestory._indexStats`). */
  stats() {
    let anchors = 0;
    let steps = 0;
    for (const e of this.entries.values()) {
      anchors += e.ids.length;
      steps += e.steps.length;
    }
    return { sidestories: this.entries.size, packages: this.packagesByKey.size, files: this.fileKeys.length, anchors, steps, state: this.stateValue, capped: this.capped, discoveryCut: this.discoveryCut };
  }

  // ---- building ----

  /** Discovers everything again (startup, Refresh, folders or exclusions changed). */
  async refresh(): Promise<void> {
    const epoch = ++this.epoch;
    this.setState(this.entries.size ? this.stateValue : 'loading');
    const patterns = excludePatterns(vscode.workspace.getConfiguration('files').get('exclude'));
    this.exclude = globMatcher(patterns);
    let found: vscode.Uri[] = [];
    try {
      found = await vscode.workspace.findFiles('**/.sidestory/*/manifest.json', joinGlobs(patterns), INDEX_LIMITS.discoveryRequest);
    } catch (e) {
      log.warn(`Sidestory discovery failed: ${(e as Error).message}`);
    }
    if (epoch !== this.epoch || this.disposed) return;
    // A stable cut: sort every path found, then keep the first 5,000 (§6.3).
    const refs = found
      .map((m) => refFromDir(vscode.Uri.joinPath(m, '..')))
      .filter((r): r is ExplainerRef => !!r)
      .sort((a, b) => (a.dir.toString() < b.dir.toString() ? -1 : a.dir.toString() > b.dir.toString() ? 1 : 0));
    this.discoveryCut = refs.length > INDEX_LIMITS.sidestories ? { found: refs.length, atLeast: found.length >= INDEX_LIMITS.discoveryRequest } : undefined;
    const kept = refs.slice(0, INDEX_LIMITS.sidestories);
    if (this.discoveryCut) log.warn(`Found ${this.discoveryCut.atLeast ? 'at least ' : ''}${refs.length} sidestories; indexing the first ${INDEX_LIMITS.sidestories}.`);
    const keep = new Set(kept.map((r) => uriKey(r.dir)));
    for (const k of [...this.entries.keys()]) if (!keep.has(k)) this.removeEntry(k);
    for (const r of kept) {
      const k = uriKey(r.dir);
      if (!this.entries.has(k)) this.addEntry(r);
      this.dirty.add(k);
    }
    const pkgs = new Set([...this.packagesByKey.keys()]);
    this.rebuildGraphs(pkgs);
    this.emitter.fire({ packages: pkgs });
    log.info(`Sidestory index: ${kept.length} sidestories in ${this.packagesByKey.size} packages.`);
    if (kept.length === 0) this.setState('empty');
    await this.runNow();
    if (epoch === this.epoch) this.readyResolve();
  }

  private setState(s: 'loading' | 'empty' | 'ready'): void {
    if (s === this.stateValue) return;
    this.stateValue = s;
    this.stateEmitter.fire(s);
  }

  private addEntry(ref: ExplainerRef): IndexEntry | undefined {
    const key = uriKey(ref.dir);
    const existing = this.entries.get(key);
    if (existing) return existing;
    if (this.entries.size >= INDEX_LIMITS.sidestories) {
      this.discoveryCut ??= { found: this.entries.size + 1, atLeast: false };
      return undefined;
    }
    const pkgKey = packageKeyOf(ref.dir);
    const e: IndexEntry = {
      ref,
      key,
      pkg: pkgKey,
      version: 0,
      title: '',
      summary: '',
      ids: [],
      file: new Int32Array(0),
      start: new Int32Array(0),
      end: new Int32Array(0),
      qOff: new Int32Array(0),
      qLen: new Int32Array(0),
      qHash: new Int32Array(0),
      stepOf: new Int16Array(0),
      steps: [],
      details: [],
      outlined: false,
      truncated: false,
      capped: false,
      state: 'discovered',
      errors: [],
      noSlices: false,
    };
    this.entries.set(key, e);
    let pkg = this.packagesByKey.get(pkgKey);
    if (!pkg) {
      const folder = vscode.Uri.joinPath(ref.dir, '..');
      pkg = { key: pkgKey, folder, root: ref.root, rootKey: uriKey(ref.root), label: packageLabel(ref.root), entries: new Map(), byName: new Map(), graph: EMPTY_GRAPH, groups: [], edges: 0 };
      this.packagesByKey.set(pkgKey, pkg);
    }
    pkg.entries.set(key, e);
    pkg.byName.set(ref.name, e);
    return e;
  }

  private removeEntry(key: string): void {
    const e = this.entries.get(key);
    if (!e) return;
    e.version++;
    this.setAnchors(e, [], new Map());
    this.totals.steps -= e.steps.length;
    this.entries.delete(key);
    this.dirty.delete(key);
    this.quotes.forget(e);
    const pkg = this.packagesByKey.get(e.pkg);
    if (pkg) {
      pkg.entries.delete(key);
      if (pkg.byName.get(e.ref.name) === e) pkg.byName.delete(e.ref.name);
      if (pkg.entries.size === 0) this.packagesByKey.delete(pkg.key);
    }
  }

  private onWatch(ev: SidestoryEvent): void {
    if (this.disposed) return;
    if (ev.sidestoryFolder || (ev.ref && ev.rel === '' && ev.kind === 'delete')) {
      if (ev.kind === 'delete') {
        this.removeUnder([ev.uri]);
        return;
      }
    }
    if (!ev.ref) return;
    const rel = ev.rel;
    if (rel === '' || rel === 'manifest.json' || rel === 'sidestory.html') {
      const rootRel = vscode.workspace.asRelativePath(ev.ref.dir, false);
      if (this.exclude(`${rootRel}/manifest.json`)) return;
      const k = uriKey(ev.ref.dir);
      const e = this.entries.get(k) ?? (ev.kind !== 'delete' ? this.addEntry(ev.ref) : undefined);
      if (!e) return;
      e.version++;
      this.dirty.add(k);
      this.schedule();
    }
  }

  private onDocument(doc: vscode.TextDocument, changed: boolean): void {
    if (!changed || doc.uri.scheme !== 'file') return;
    const p = doc.uri.path;
    if (!p.endsWith('/manifest.json') && !p.endsWith('/sidestory.html')) return;
    const ref = refFromDir(vscode.Uri.joinPath(doc.uri, '..'));
    if (!ref) return;
    const e = this.entries.get(uriKey(ref.dir));
    if (!e) return;
    e.version++;
    this.dirty.add(e.key);
    this.schedule();
  }

  /** Deletes of folders above sidestories (rm -r services/auth): everything under them goes (§6.4). */
  private removeUnder(uris: readonly vscode.Uri[]): void {
    let removed = false;
    for (const u of uris) {
      const prefix = uriKey(u).replace(/\/?$/, '/');
      for (const k of [...this.entries.keys()]) {
        if (k === uriKey(u) || k.startsWith(prefix)) {
          this.removeEntry(k);
          removed = true;
        }
      }
    }
    if (removed) this.commit(new Set([...this.packagesByKey.keys()]));
  }

  /**
   * Drops sidestories whose manifest is gone (deletes the watcher can't see: a checkout, an ancestor folder
   * deleted outside VS Code). On a git HEAD change and when the window regains focus, at most every 30 s.
   */
  async reconcile(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastReconcile < INDEX_LIMITS.reconcileThrottleMs) return;
    this.lastReconcile = now;
    const epoch = this.epoch;
    const all = [...this.entries.values()];
    const gone: string[] = [];
    for (let i = 0; i < all.length; i += INDEX_LIMITS.reconcileBatch) {
      const batch = all.slice(i, i + INDEX_LIMITS.reconcileBatch);
      const stats = await Promise.all(batch.map((e) => statOf(manifestUri(e.ref))));
      if (epoch !== this.epoch || this.disposed) return;
      batch.forEach((e, j) => {
        const s = stats[j];
        if (!s) gone.push(e.key);
        else if (`${s.mtime}:${s.size}` !== e.manifestStamp && !e.manifestStamp?.startsWith('d')) {
          e.version++;
          this.dirty.add(e.key);
        }
      });
    }
    for (const k of gone) this.removeEntry(k);
    if (gone.length) this.commit(new Set([...this.packagesByKey.keys()]));
    if (this.dirty.size) this.schedule();
  }

  /** Marks one sidestory for a re-read (a slice that no longer matched its manifest). */
  markDirty(e: IndexEntry): void {
    if (!this.entries.has(e.key)) return;
    e.version++;
    // Forget the stamp: a same-size edit within the stamp's granularity looks unchanged, and must be re-read.
    e.manifestStamp = undefined;
    this.dirty.add(e.key);
    this.schedule();
  }

  /** Re-reads after 300 ms, extended up to 2 s while events keep arriving, so a checkout is one batch. */
  private schedule(): void {
    if (this.disposed) return;
    const now = Date.now();
    const first = this.debounce?.first ?? now;
    if (this.debounce) clearTimeout(this.debounce.timer);
    const wait = Math.max(0, Math.min(INDEX_LIMITS.debounceMs, first + INDEX_LIMITS.debounceMaxMs - now));
    this.debounce = {
      first,
      timer: setTimeout(() => {
        this.debounce = undefined;
        void this.runNow();
      }, wait),
    };
  }

  /** Runs a batch now, or once more after the one running. */
  private async runNow(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.rerun = false;
        await this.batch();
      } while (this.rerun && !this.disposed);
    })().finally(() => (this.running = undefined));
    return this.running;
  }

  private async batch(): Promise<void> {
    const epoch = this.epoch;
    const keys = [...this.dirty].filter((k) => this.entries.has(k));
    this.dirty.clear();
    if (keys.length === 0) {
      this.setState(this.entries.size ? 'ready' : 'empty');
      return;
    }
    // Sidestories in use first, then in sidebar order, so the visible part fills first (§6.5).
    const order = keys
      .map((k) => this.entries.get(k)!)
      .sort((a, b) => this.priority(a.key) - this.priority(b.key) || this.packageOrder(a.pkg) - this.packageOrder(b.pkg) || a.ref.name.localeCompare(b.ref.name));
    const budget: Budget = { manifestBytes: INDEX_LIMITS.manifestBytesPerBatch, pageBytes: INDEX_LIMITS.pageBytesPerBatch, scanMs: INDEX_LIMITS.scanMsPerBatch };
    const touched = new Set<string>();
    const skipped: IndexEntry[] = [];
    let next = 0;
    const worker = async () => {
      while (next < order.length) {
        const e = order[next++]!;
        if (epoch !== this.epoch || this.disposed) return;
        const r = await this.read(e, budget);
        if (r === 'changed') touched.add(e.pkg);
        else if (r === 'budget') skipped.push(e);
        else if (r === 'gone') {
          touched.add(e.pkg);
          this.removeEntry(e.key);
        }
      }
    };
    await Promise.all(Array.from({ length: INDEX_LIMITS.readsInFlight }, worker));
    if (epoch !== this.epoch || this.disposed) return;
    if (touched.size) this.commit(touched);
    this.setState(this.entries.size ? 'ready' : 'empty');
    if (skipped.length) {
      log.warn(`Sidestory index: ${skipped.length} sidestories not read or outlined this time (budget): ${skipped.slice(0, 20).map((e) => e.ref.name).join(', ')}${skipped.length > 20 ? ', …' : ''}`);
      this.scheduleFollowUp(skipped);
    } else if (this.followUp) {
      clearTimeout(this.followUp.timer);
      this.followUp = undefined;
    }
  }

  /** Skipped entries come back 30 s later, then with backoff up to every 10 minutes (§6.5). */
  private scheduleFollowUp(skipped: IndexEntry[]): void {
    const delay = this.followUp ? Math.min(this.followUp.delay * 2, INDEX_LIMITS.followUpMaxMs) : INDEX_LIMITS.followUpMs;
    if (this.followUp) clearTimeout(this.followUp.timer);
    this.followUp = {
      delay,
      timer: setTimeout(() => {
        for (const e of skipped) if (this.entries.has(e.key)) this.dirty.add(e.key);
        void this.runNow();
      }, delay),
    };
  }

  private packageOrder(pkg: string): number {
    return this.packageRank.get(pkg) ?? 0;
  }
  private packageRank = new Map<string, number>();

  /** Rebuilds the graphs of changed packages, forgets stale file tables, and tells readers once. */
  private commit(packages: Set<string>): void {
    this.rebuildGraphs(packages);
    this.fileTables.clear();
    this.emitter.fire({ packages });
  }

  private rebuildGraphs(packages: Set<string>): void {
    const sorted = this.packages();
    this.packageRank = new Map(sorted.map((p, i) => [p.key, i]));
    // The total edge cap, shared in package order.
    let used = 0;
    for (const p of sorted) {
      if (packages.has(p.key)) {
        const nodes = [...p.entries.values()].map((e) => ({ name: e.ref.name, title: this.name(e), group: e.group, top: e.top, details: e.details }));
        p.graph = buildDetailGraph(nodes, { maxEdges: Math.max(0, INDEX_LIMITS.edges - used) });
        p.edges = p.graph.edgeCount;
        if (p.graph.edgesCapped) this.capped = true;
        p.groups = mergeGroups(nodes);
      }
      used += p.edges;
    }
  }

  /** Reads one sidestory's manifest and page if they changed. */
  private async read(e: IndexEntry, budget: Budget): Promise<'changed' | 'same' | 'budget' | 'gone'> {
    const version = e.version;
    const current = () => !this.disposed && e.version === version && this.entries.get(e.key) === e;
    let changed = false;

    // ---- manifest ----
    const mUri = manifestUri(e.ref);
    const open = openDoc(mUri);
    let stamp: string;
    let text: string | undefined;
    let bomBytes = 0;
    let slicesOk = true;
    if (open?.isDirty) {
      stamp = `d${open.version}`;
      if (stamp !== e.manifestStamp) text = open.getText();
      slicesOk = false;
    } else {
      const s = await statOf(mUri);
      if (!current()) return 'same';
      if (!s) return 'gone';
      stamp = `${s.mtime}:${s.size}`;
      if (stamp !== e.manifestStamp) {
        if (s.size > budget.manifestBytes) {
          e.state = 'not-read';
          return 'budget';
        }
        budget.manifestBytes -= s.size;
        const bytes = await readBytesInside(mUri, e.ref.root, MAX_MANIFEST_BYTES);
        if (!current()) return 'same';
        if (!bytes) {
          e.errors = ["manifest.json can't be read (missing, outside the repository, or too large)."];
          e.manifestStamp = stamp;
          this.setAnchors(e, [], new Map());
          return 'changed';
        }
        bomBytes = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
          text = new TextDecoder().decode(bytes);
          slicesOk = false;
        }
      }
    }
    if (text !== undefined) {
      const parsed = parseManifest(text);
      e.manifestStamp = stamp;
      e.noSlices = !slicesOk;
      if (parsed.ok) {
        const m = parsed.manifest;
        e.title = displayText(m.title, 120);
        e.summary = displayText(m.summary ?? '', 300);
        e.group = m.group !== undefined ? displayText(m.group, 60) || undefined : undefined;
        e.top = m.top;
        e.errors = parsed.diagnostics.slice(0, 5).map((d) => displayText(d.anchor ? `${d.anchor}: ${d.message}` : d.message, 200));
        const positions = slicesOk ? quotePositions(text.replace(/^﻿/, ''), bomBytes) : new Map();
        this.setAnchors(e, [...m.anchors.values()], positions);
      } else {
        e.errors = [displayText(parsed.error, 300)];
        this.setAnchors(e, [], new Map());
      }
      this.quotes.forget(e);
      changed = true;
    }

    // ---- page ----
    const pUri = htmlUri(e.ref);
    const openPage = openDoc(pUri);
    let pageStamp: string;
    let html: string | undefined;
    if (openPage?.isDirty) {
      pageStamp = `d${openPage.version}`;
      if (pageStamp !== e.pageStamp || changed) html = openPage.getText();
    } else {
      const s = await statOf(pUri);
      if (!current()) return 'same';
      pageStamp = s ? `${s.mtime}:${s.size}` : 'missing';
      if (s && (pageStamp !== e.pageStamp || !e.outlined)) {
        if (s.size > MAX_HTML_BYTES) {
          html = '';
          e.errors = [...e.errors, 'sidestory.html is too large to outline.'].slice(0, 6);
        } else if (s.size > budget.pageBytes) {
          e.state = 'not-read';
          return changed ? 'changed' : 'budget';
        } else {
          budget.pageBytes -= s.size;
          const bytes = await readBytesInside(pUri, e.ref.root, MAX_HTML_BYTES);
          if (!current()) return 'same';
          html = bytes ? new TextDecoder().decode(bytes) : '';
        }
      } else if (!s && e.pageStamp !== 'missing') html = '';
    }
    if (html !== undefined) {
      if (budget.scanMs <= 0) {
        e.state = 'not-outlined';
        return changed ? 'changed' : 'budget';
      }
      const scanner = new OutlineScanner(html);
      for (;;) {
        const t0 = Date.now();
        const done = scanner.feed(Math.min(INDEX_LIMITS.sliceMs, Math.max(1, budget.scanMs)));
        budget.scanMs -= Date.now() - t0;
        if (done) break;
        if (budget.scanMs <= 0) {
          e.state = 'not-outlined';
          return changed ? 'changed' : 'budget';
        }
        await new Promise((r) => setImmediate(r));
        if (!current()) return 'same';
      }
      const o = scanner.result();
      e.pageStamp = pageStamp;
      this.totals.steps -= e.steps.length;
      const room = Math.max(0, INDEX_LIMITS.steps - this.totals.steps);
      e.steps = o.steps.slice(0, room).map((s) => ({ id: s.id, title: s.title, blurb: s.blurb }));
      if (o.steps.length > room) {
        e.capped = true;
        this.capped = true;
      }
      this.totals.steps += e.steps.length;
      // Raw names in document order: the graph validates them, and invalid ones show as broken links.
      e.details = o.details.map((d) => d.name);
      e.truncated = o.truncated;
      e.outlined = true;
      const stepIndex = new Map(e.steps.map((s, i) => [s.id, i]));
      const stepOf = new Int16Array(e.ids.length);
      e.ids.forEach((id, i) => {
        const s = o.anchorStep.get(id);
        stepOf[i] = s !== undefined ? (stepIndex.get(s) ?? -1) : -1;
      });
      e.stepOf = stepOf;
      changed = true;
    }
    e.state = e.outlined ? 'ready' : e.state;
    return changed ? 'changed' : 'same';
  }

  /** Packs an entry's anchors (§6.1), within the total and per-file caps; keeps file references current. */
  private setAnchors(e: IndexEntry, anchors: Anchor[], positions: Map<string, { offset: number; length: number }>): void {
    // Unlink the old files.
    for (const f of new Set(e.file)) {
      const refs = this.fileRefs.get(f);
      refs?.delete(e.key);
      this.fileTables.delete(f);
    }
    this.totals.anchors -= e.ids.length;
    const room = Math.max(0, INDEX_LIMITS.anchors - this.totals.anchors);
    if (anchors.length > room) {
      e.capped = true;
      this.capped = true;
      anchors = anchors.slice(0, room);
    }
    const n = anchors.length;
    e.ids = anchors.map((a) => a.id);
    e.file = new Int32Array(n);
    e.start = new Int32Array(n);
    e.end = new Int32Array(n);
    e.qOff = new Int32Array(n).fill(-1);
    e.qLen = new Int32Array(n);
    e.qHash = new Int32Array(n);
    anchors.forEach((a, i) => {
      e.file[i] = this.intern(uriKey(vscode.Uri.joinPath(e.ref.root, a.file)));
      e.start[i] = a.range.start;
      e.end[i] = a.range.end;
      if (a.quote) {
        const p = positions.get(a.id);
        // A pinned anchor without a usable position still counts as pinned: qLen −1 means "read the whole manifest".
        e.qOff[i] = p ? p.offset : -1;
        e.qLen[i] = p ? p.length : -1;
        e.qHash[i] = quoteHash(a.quote);
      }
    });
    // The outline's step mapping follows the ids; recomputed when the page is next outlined.
    const old = e.stepOf;
    e.stepOf = new Int16Array(n).fill(-1);
    if (e.outlined && old.length) {
      // Keep what we knew for ids that stayed: steps don't depend on the manifest.
      const stepIds = new Map(e.steps.map((s, i) => [s.id, i]));
      e.ids.forEach((id, i) => {
        const s = stepIds.get(id);
        if (s !== undefined) e.stepOf[i] = s;
      });
      // Nested anchors need the page again.
      e.pageStamp = undefined;
    }
    this.totals.anchors += n;
    for (const f of new Set(e.file)) {
      let refs = this.fileRefs.get(f);
      if (!refs) this.fileRefs.set(f, (refs = new Set()));
      refs.add(e.key);
      this.fileTables.delete(f);
    }
  }

  private intern(key: string): number {
    let id = this.fileIds.get(key);
    if (id === undefined) {
      id = this.fileKeys.length;
      this.fileKeys.push(key);
      this.fileIds.set(key, id);
    }
    return id;
  }

  /** The file key of an anchor (for resolving against a document). */
  fileKeyOf(e: IndexEntry, i: number): string {
    return this.fileKeys[e.file[i]!]!;
  }

  dispose(): void {
    this.disposed = true;
    this.epoch++;
    if (this.debounce) clearTimeout(this.debounce.timer);
    if (this.followUp) clearTimeout(this.followUp.timer);
    for (const d of this.subscriptions) d.dispose();
  }
}

interface Budget {
  manifestBytes: number;
  pageBytes: number;
  scanMs: number;
}

function openDoc(uri: vscode.Uri): vscode.TextDocument | undefined {
  const s = uri.toString();
  return vscode.workspace.textDocuments.find((d) => d.uri.toString() === s);
}

async function statOf(uri: vscode.Uri): Promise<{ mtime: number; size: number } | undefined> {
  try {
    const s = await vscode.workspace.fs.stat(uri);
    return { mtime: s.mtime, size: s.size };
  } catch {
    return undefined;
  }
}

/**
 * Quotes of pinned anchors (§7.2): read as slices of manifest.json at the positions the metadata pass
 * recorded, within one byte budget shared by every document (4 MB at once, refilling at 1 MB/s), and kept in
 * a cache of at most 20 MB keyed by (sidestory, anchor, stamp).
 */
class QuoteStore implements vscode.Disposable {
  private tokens: number = INDEX_LIMITS.quoteBudgetBytes;
  private last = Date.now();
  private readonly cache = new Map<string, Quote>();
  private chars = 0;
  private waiters: { need: number; resolve: () => void }[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  private readonly index: SidestoryIndex;
  constructor(index: SidestoryIndex) {
    this.index = index;
  }

  /** Bytes read so far (tests). */
  bytesRead = 0;

  forget(e: IndexEntry): void {
    const prefix = `${e.key}\u0000`;
    for (const [k, q] of this.cache) {
      if (k.startsWith(prefix)) {
        this.cache.delete(k);
        this.chars -= q.exact.length + q.prefix.length + q.suffix.length;
      }
    }
  }

  private refill(): void {
    const now = Date.now();
    this.tokens = Math.min(INDEX_LIMITS.quoteBudgetBytes, this.tokens + ((now - this.last) / 1000) * INDEX_LIMITS.quoteRefillPerSec);
    this.last = now;
  }

  /** Waits until `n` bytes fit in the budget (a request larger than the whole budget waits for a full one). */
  private async take(n: number): Promise<void> {
    const need = Math.min(n, INDEX_LIMITS.quoteBudgetBytes);
    this.refill();
    if (this.tokens >= need && this.waiters.length === 0) {
      this.tokens -= need;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push({ need, resolve });
      this.pump();
    });
  }

  private pump(): void {
    if (this.timer || this.disposed) return;
    this.refill();
    while (this.waiters.length && this.tokens >= this.waiters[0]!.need) {
      const w = this.waiters.shift()!;
      this.tokens -= w.need;
      w.resolve();
    }
    if (this.waiters.length) {
      const wait = Math.ceil(((this.waiters[0]!.need - this.tokens) / INDEX_LIMITS.quoteRefillPerSec) * 1000);
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.pump();
      }, Math.max(10, wait));
    }
  }

  private put(key: string, q: Quote): void {
    const size = q.exact.length + q.prefix.length + q.suffix.length;
    this.cache.set(key, q);
    this.chars += size;
    for (const [k, old] of this.cache) {
      if (this.chars <= INDEX_LIMITS.quoteCacheChars) break;
      this.cache.delete(k);
      this.chars -= old.exact.length + old.prefix.length + old.suffix.length;
    }
  }

  async fetch(e: IndexEntry, indexes: readonly number[], isCurrent: () => boolean): Promise<Map<number, Quote | null>> {
    const out = new Map<number, Quote | null>();
    const stamp = e.manifestStamp ?? '';
    const want = indexes.filter((i) => e.qLen[i] !== 0);
    const missing: number[] = [];
    for (const i of want) {
      const hit = this.cache.get(`${e.key}\u0000${e.ids[i]}\u0000${stamp}`);
      if (hit) {
        // Most recently used last.
        this.cache.delete(`${e.key}\u0000${e.ids[i]}\u0000${stamp}`);
        this.cache.set(`${e.key}\u0000${e.ids[i]}\u0000${stamp}`, hit);
        out.set(i, hit);
      } else missing.push(i);
    }
    if (!missing.length) return out;
    const mUri = manifestUri(e.ref);
    // A dirty open manifest, a non-file scheme, or offsets we can't trust: parse the whole text (budgeted).
    const whole = stamp.startsWith('d') || mUri.scheme !== 'file' || e.noSlices || missing.some((i) => e.qLen[i]! < 0);
    if (whole) {
      const doc = openDoc(mUri);
      let text: string | undefined;
      if (doc && stamp.startsWith('d')) text = doc.getText();
      else {
        const s = await statOf(mUri);
        if (!s || `${s.mtime}:${s.size}` !== stamp) {
          this.index.markDirty(e);
          return out;
        }
        await this.take(s.size);
        if (!isCurrent()) return out;
        const bytes = await readBytesInside(mUri, e.ref.root, MAX_MANIFEST_BYTES);
        this.bytesRead += bytes?.byteLength ?? 0;
        text = bytes ? new TextDecoder().decode(bytes) : undefined;
      }
      const parsed = text === undefined ? undefined : parseManifest(text);
      if (!parsed?.ok) return out;
      for (const i of missing) {
        const q = parsed.manifest.anchors.get(e.ids[i]!)?.quote;
        if (q && quoteHash(q) === e.qHash[i]) {
          out.set(i, q);
          this.put(`${e.key}\u0000${e.ids[i]}\u0000${stamp}`, q);
        } else {
          out.set(i, null);
          this.index.markDirty(e);
        }
      }
      return out;
    }
    // Slices: check the stamp first, then read each at its recorded position.
    const s = await statOf(mUri);
    if (!isCurrent()) return out;
    if (!s || `${s.mtime}:${s.size}` !== stamp) {
      this.index.markDirty(e);
      return out;
    }
    for (const i of missing) {
      const len = e.qLen[i]!;
      await this.take(len);
      if (!isCurrent() || this.disposed) return out;
      const bytes = await readSliceInside(mUri, e.ref.root, e.qOff[i]!, len, MAX_MANIFEST_BYTES);
      this.bytesRead += bytes?.byteLength ?? 0;
      const q = bytes ? parseQuoteSlice(bytes) : undefined;
      // The slice is untrusted: it must parse as a quote, pass the schema, and hash to what the metadata pass saw.
      if (!q || quoteHash(q) !== e.qHash[i]) {
        out.set(i, null);
        this.index.markDirty(e);
        continue;
      }
      out.set(i, q);
      this.put(`${e.key}\u0000${e.ids[i]}\u0000${stamp}`, q);
    }
    return out;
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    for (const w of this.waiters) w.resolve();
    this.waiters = [];
    this.cache.clear();
  }
}

function parseQuoteSlice(bytes: Uint8Array): Quote | undefined {
  try {
    const raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
    const r = quoteSchema.safeParse(raw);
    return r.success && r.data ? (r.data as Quote) : undefined;
  } catch {
    return undefined;
  }
}

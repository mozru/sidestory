// Drift badges for the sidebar (docs/NAVIGATION-PLAN.md §8.5): how many of a sidestory's anchors are out of
// date or lost. Only for nodes being shown, one sidestory at a time, within byte budgets, and paused while the
// reader types. Computed as a fresh open would see it (no hints).
import * as vscode from 'vscode';
import { parseManifest } from '../../core/manifest.ts';
import { resolveAnchor } from '../../core/resolve.ts';
import { PreparedText } from '../../core/text.ts';
import { manifestUri, MAX_MANIFEST_BYTES, readInside, uriKey } from '../explainers.ts';
import type { IndexEntry, SidestoryIndex } from './index.ts';

export const DRIFT_LIMITS = {
  queue: 200,
  cache: 2000,
  fileBytes: 1_000_000,
  perSidestoryBytes: 20_000_000,
  rollingBytes: 200_000_000,
  rollingMs: 600_000,
  typingPauseMs: 1000,
  sliceMs: 15,
} as const;

export interface Drift {
  /** Changed or stale. */
  outOfDate: number;
  lost: number;
  /** Files skipped (over 1 MB, or the per-sidestory budget). */
  unchecked: number;
}

interface Cached {
  stamp: string;
  drift: Drift;
}

export class DriftQueue implements vscode.Disposable {
  private readonly index: SidestoryIndex;
  private readonly cache = new Map<string, Cached>();
  /** Invalidations per key: a result is current only if none came in while it was computed. */
  private readonly dirty = new Map<string, number>();
  private queue: string[] = [];
  private running = false;
  private lastTyped = 0;
  /** Bytes read per minute (at most 11 buckets), for the rolling 10-minute budget. */
  private readonly buckets = new Map<number, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private readonly emitter = new vscode.EventEmitter<string>();
  /** A sidestory's drift is known or changed (its key). */
  readonly onDidChange = this.emitter.event;
  private readonly subscriptions: vscode.Disposable[] = [];
  /** Live states of sidestories open in panels (key → drift), set by the extension. */
  live: (key: string) => Drift | undefined = () => undefined;

  constructor(index: SidestoryIndex) {
    this.index = index;
    this.subscriptions.push(
      this.emitter,
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.scheme !== 'file' || e.contentChanges.length === 0) return;
        this.lastTyped = Date.now();
        this.invalidateFile(uriKey(e.document.uri));
      }),
      vscode.workspace.onDidSaveTextDocument((d) => this.invalidateFile(uriKey(d.uri))),
      index.onDidChange(() => {
        // A manifest change shows up as a new stamp; nothing else to do.
      }),
    );
  }

  /** The drift if known (and current), else undefined. Asks for it when it isn't. */
  get(e: IndexEntry): Drift | undefined {
    const live = this.live(e.key);
    if (live) return live;
    const c = this.cache.get(e.key);
    // Not read by the index yet: nothing to compare against; the index's change event repaints it later.
    if (!e.manifestStamp) return undefined;
    if (c && !this.dirty.has(e.key) && c.stamp.startsWith(`${e.manifestStamp}|`)) return c.drift;
    // Unknown or dirty: recomputed now that it is shown (cheap when every stamp still matches).
    this.request(e.key);
    return undefined;
  }

  /** Newest first, at most 200 waiting. */
  private request(key: string): void {
    this.queue = [key, ...this.queue.filter((k) => k !== key)].slice(0, DRIFT_LIMITS.queue);
    this.kick(0);
  }

  private invalidateFile(fileKey: string): void {
    if (!this.index.isAnchored(fileKey)) return;
    for (const s of this.index.anchorsIn(fileKey)) {
      if (this.cache.has(s.entry.key)) this.markDirty(s.entry.key);
    }
  }

  /** Everything is dirty (git HEAD moved, Refresh). Recomputed when shown again. */
  invalidateAll(): void {
    for (const k of this.cache.keys()) this.markDirty(k);
  }

  private kick(delay: number): void {
    if (this.timer || this.running || this.disposed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.run();
    }, delay);
  }

  private rollingUsed(): number {
    const now = Date.now();
    const minute = Math.floor(now / 60_000);
    const oldest = minute - Math.ceil(DRIFT_LIMITS.rollingMs / 60_000);
    let sum = 0;
    for (const [m, bytes] of this.buckets) {
      if (m <= oldest) this.buckets.delete(m);
      else sum += bytes;
    }
    return sum;
  }

  private async run(): Promise<void> {
    if (this.running || this.disposed) return;
    this.running = true;
    try {
      while (this.queue.length && !this.disposed) {
        // Paused while the reader typed in the last second.
        const sinceTyped = Date.now() - this.lastTyped;
        if (sinceTyped < DRIFT_LIMITS.typingPauseMs) {
          this.running = false;
          this.kick(DRIFT_LIMITS.typingPauseMs - sinceTyped);
          return;
        }
        if (this.rollingUsed() >= DRIFT_LIMITS.rollingBytes) {
          this.running = false;
          this.kick(30_000);
          return;
        }
        const key = this.queue.shift()!;
        const e = this.index.entry(key);
        if (!e) continue;
        const marks = this.dirty.get(key) ?? 0;
        const drift = await this.compute(e);
        if (drift && !this.disposed) {
          this.cache.delete(key);
          this.cache.set(key, drift);
          // An invalidation that arrived during the computation keeps it dirty.
          if ((this.dirty.get(key) ?? 0) === marks) this.dirty.delete(key);
          while (this.cache.size > DRIFT_LIMITS.cache) this.cache.delete(this.cache.keys().next().value!);
          this.emitter.fire(key);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async compute(e: IndexEntry): Promise<Cached | undefined> {
    const version = e.version;
    const mUri = manifestUri(e.ref);
    const mStat = await stat(mUri);
    if (!mStat) return undefined;
    // Files' stamps: reuse the cached result while they all still match.
    const files = new Map<string, vscode.Uri>();
    const text = await readInside(mUri, e.ref.root, MAX_MANIFEST_BYTES);
    if (text === undefined || e.version !== version) return undefined;
    this.note(text.length);
    const parsed = parseManifest(text);
    if (!parsed.ok) return { stamp: `${e.manifestStamp}|`, drift: { outOfDate: 0, lost: 0, unchecked: 0 } };
    for (const a of parsed.manifest.anchors.values()) files.set(a.file, vscode.Uri.joinPath(e.ref.root, a.file));
    const stats = new Map<string, { mtime: number; size: number } | undefined>();
    for (const [f, u] of files) {
      const s = await stat(u);
      // An open document is read from its buffer: its version is part of the stamp, so unsaved edits count.
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === u.toString());
      stats.set(f, s && doc?.isDirty ? { mtime: s.mtime, size: -doc.version } : s);
    }
    // Kept short: the manifest's stamp and a hash of every anchored file's path and stat (a manifest can name
    // hundreds of long paths, and the cache holds 2,000 entries).
    const stamp = `${e.manifestStamp}|${hashStats(stats)}`;
    const cached = this.cache.get(e.key);
    if (cached && cached.stamp === stamp) return cached;
    const drift: Drift = { outOfDate: 0, lost: 0, unchecked: 0 };
    let bytes = 0;
    let slice = Date.now();
    for (const [f, u] of files) {
      const anchors = [...parsed.manifest.anchors.values()].filter((a) => a.file === f);
      const s = stats.get(f);
      if (!s) {
        drift.lost += anchors.length;
        continue;
      }
      // Over 1 MB, or past the per-sidestory budget: unchecked, not lost.
      if (s.size > DRIFT_LIMITS.fileBytes || bytes + s.size > DRIFT_LIMITS.perSidestoryBytes) {
        drift.unchecked += anchors.length;
        continue;
      }
      const source = await readInside(u, e.ref.root, DRIFT_LIMITS.fileBytes);
      if (this.disposed || e.version !== version) return undefined;
      if (source === undefined) {
        drift.unchecked += anchors.length;
        continue;
      }
      bytes += source.length;
      this.note(source.length);
      // One PreparedText per file, dropped right after.
      const prepared = PreparedText.from(source);
      for (const a of anchors) {
        if (Date.now() - slice > DRIFT_LIMITS.sliceMs) {
          await new Promise((r) => setImmediate(r));
          if (this.disposed || e.version !== version) return undefined;
          slice = Date.now();
        }
        const r = resolveAnchor(prepared, a);
        if (r.state === 'lost') drift.lost++;
        else if (r.state === 'changed' || r.state === 'stale') drift.outOfDate++;
      }
    }
    return { stamp, drift };
  }

  private note(bytes: number): void {
    const minute = Math.floor(Date.now() / 60_000);
    this.buckets.set(minute, (this.buckets.get(minute) ?? 0) + bytes);
  }

  private markDirty(key: string): void {
    this.dirty.set(key, (this.dirty.get(key) ?? 0) + 1);
  }

  /** The cached drift of a key (tests). */
  peek(key: string): Drift | undefined {
    return this.cache.get(key)?.drift;
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    for (const d of this.subscriptions) d.dispose();
    this.cache.clear();
    this.queue = [];
  }
}

function hashStats(stats: Map<string, { mtime: number; size: number } | undefined>): string {
  let h = 0x811c9dc5;
  const mix = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  };
  for (const [f, s] of stats) mix(`${f}\u0000${s ? `${s.mtime}:${s.size}` : '-'}\u0000`);
  return `${stats.size}:${(h >>> 0).toString(36)}`;
}

async function stat(uri: vscode.Uri): Promise<{ mtime: number; size: number } | undefined> {
  try {
    const s = await vscode.workspace.fs.stat(uri);
    return { mtime: s.mtime, size: s.size };
  } catch {
    return undefined;
  }
}

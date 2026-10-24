// Coverage of the branch's changes by the sidestories that belong to it (docs/CHANGES-PLAN.md §6.1–§6.5, §9.6), in
// the extension. The same pure functions as the checker (`belongs`, `coverage`, `usedAnchorIds`, `diffTexts`), fed
// through the git extension: belonging sidestories (manifest absent at the merge-base, present at the head, the same
// merge-base from their own `base`), their used anchors resolved per side (head side against the comparison's new
// text, base side against the merge-base blob of the old path), and change blocks from both sides decoded the same
// way. Work is lazy and bounded (§4.6): only while someone needs it (a sidestory with a base in the workspace, an open
// one, or a command), 4 files at a time, anchored files first, at most 200 MB read per recompute, cached by content.
// The rules shared with the checker: which paths count (`countedPath`), a sidestory needs both its files, a side past
// MAX_COMPARE_BYTES counts as one change (`tooLargeChange`), an unreadable one makes the result incomplete.
//
// `computeCoverage` is the core and takes a `CoverageSource` (unit tests stub it); `CoverageService` builds the
// source from the comparison's snapshot and the git extension, caches, and fires when a result changes.
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { coverage, normLine, usedAnchorIds, type FileCoverage, type FileInput, type Target, type Totals } from '../../core/coverage.ts';
import { globMatcher } from '../../core/glob.ts';
import { outlineHtml } from '../../core/html-scan.ts';
import { decodePair, decodeUtf8, diffTexts, MAX_COMPARE_BYTES, textLines, tooLargeChange, type ChangeBlock, type FileDiff } from '../../core/hunks.ts';
import type { Manifest } from '../../core/manifest.ts';
import { parseManifest, sideOf } from '../../core/manifest.ts';
import { belongs, countedPath, isArchivePath, sidestoryFolderOf } from '../../core/membership.ts';
import { resolveAnchor } from '../../core/resolve.ts';
import { PreparedText } from '../../core/text.ts';
import { MAX_HTML_BYTES, MAX_MANIFEST_BYTES, readInside } from '../explainers.ts';
import { log } from '../log.ts';
import { resolveBase } from './base.ts';
import type { Snapshot } from './comparison.ts';
import type { GitRepo } from './git-api.ts';
import { apiPath, refReader, relPath } from './git-api.ts';
import type { ChangeEntry } from './model.ts';

export const COVERAGE_WORK = { parallel: 4, bytesPerRecompute: 200 * 1024 * 1024, fileBytes: MAX_COMPARE_BYTES, debounceMs: 300, diffCache: 5000, textCache: 2000 } as const;

/** A sidestory folder seen at the head (working tree or HEAD), before the membership test. */
export interface Candidate {
  /** Repo-relative folder (`.sidestory/retry-jitter`, `pkg/.sidestory/x`). */
  folder: string;
  /** The package root, repo-relative ('' for the repository root): anchor files are relative to it. */
  prefix: string;
  dir: vscode.Uri;
  manifestText: string;
  html: string;
}

/** What `computeCoverage` reads; every method resolves to undefined rather than throwing. */
export interface CoverageSource {
  readonly mergeBase: string;
  readonly entries: readonly ChangeEntry[];
  candidates(): Promise<Candidate[]>;
  /** Whether the merge-base holds a path; undefined when git couldn't say (an error is never "absent"). */
  presentAtMergeBase(repoPath: string): Promise<boolean | undefined>;
  /** The merge-base a sidestory's `base` gives against the comparison's head. */
  ownMergeBase(spec: string): Promise<string | undefined>;
  /** A side's bytes; 'tooLarge' past MAX_COMPARE_BYTES; undefined when unreadable. */
  oldBytes(repoPath: string): Promise<Uint8Array | 'tooLarge' | undefined>;
  newBytes(repoPath: string): Promise<Uint8Array | 'tooLarge' | undefined>;
  /** A content key for the new side when it is cheaper than reading it (immutable blobs); else undefined. */
  diffKey?(e: ChangeEntry): string | undefined;
}

export interface Belonging {
  folder: string;
  prefix: string;
  dir: vscode.Uri;
  manifest: Manifest;
  /** Step ids and titles from the page's outline, in order. */
  steps: { id: string; title: string }[];
  /** Anchor id → its step's id. */
  stepOf: Map<string, string>;
  totals: Totals;
}

export interface FileResult {
  entry: ChangeEntry;
  diff: FileDiff;
  coverage: FileCoverage | undefined;
  /** Change blocks by key, for change items and the gutter. */
  blocks: Map<string, ChangeBlock>;
}

export interface CoverageResult {
  mergeBase: string;
  belonging: Belonging[];
  files: Map<string, FileResult>;
  totals: Totals;
  targets: Target[];
  /** A page too large to scan, or the byte budget spent: coverage is not complete. */
  incomplete: boolean;
  /** Files diffed so far / files to diff (the totals say "computing…" until they match). */
  done: number;
  total: number;
}

const isBinary = (b: Uint8Array | undefined) => !!b && b.subarray(0, 8000).includes(0);
const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const under = (prefix: string, p: string) => (prefix ? (p.startsWith(`${prefix}/`) ? p.slice(prefix.length + 1) : undefined) : p);
const join = (prefix: string, p: string) => (prefix ? `${prefix}/${p}` : p);
const isSidestoryPath = (p: string) => sidestoryFolderOf(p) !== undefined || isArchivePath(p);

/** The sidestories that belong, from candidates (§6.1). */
export async function belongingSidestories(src: CoverageSource): Promise<{ found: (Candidate & { manifest: Manifest })[]; incomplete: boolean }> {
  const out: (Candidate & { manifest: Manifest })[] = [];
  let incomplete = false;
  for (const c of await src.candidates()) {
    if (isArchivePath(c.folder)) continue;
    const parsed = parseManifest(c.manifestText);
    if (!parsed.ok || parsed.manifest.base === undefined) continue;
    const m = parsed.manifest;
    const own = await src.ownMergeBase(m.base!);
    const presentAtMergeBase = own === src.mergeBase ? await src.presentAtMergeBase(`${c.folder}/manifest.json`) : true;
    // Git couldn't say whether it was there before: not counted, and the result says it is incomplete.
    if (presentAtMergeBase === undefined) {
      incomplete = true;
      continue;
    }
    if (belongs({ presentAtMergeBase, presentAtHead: true, ownMergeBase: own, comparisonMergeBase: src.mergeBase, manifestHead: m.head })) out.push({ ...c, manifest: m });
  }
  return { found: out.sort((a, b) => byPath(a.folder, b.folder)), incomplete };
}

interface Texts {
  old: string | undefined;
  new: string | undefined;
}

/**
 * Coverage of the comparison's files by the belonging sidestories. `order` puts files first (expanded and visible
 * ones, in view order); anchored files go before the rest. `cache` keeps diffs by content between calls.
 */
export async function computeCoverage(
  src: CoverageSource,
  opts: { order?: readonly string[]; cache?: Map<string, { diff: FileDiff; texts: Texts }>; isCurrent?: () => boolean; onProgress?: (r: CoverageResult) => void } = {},
): Promise<CoverageResult | undefined> {
  const isCurrent = opts.isCurrent ?? (() => true);
  const cache = opts.cache ?? new Map();
  const { found, incomplete: unsure } = await belongingSidestories(src);
  if (!isCurrent()) return undefined;
  const none: Totals = { changes: 0, explained: 0, trivial: 0, left: 0, needsLook: 0, files: 0 };
  // No layer without a sidestory (§9.2): the navigator's own counting fills in the counts then.
  if (!found.length) return { mergeBase: src.mergeBase, belonging: [], files: new Map(), totals: none, targets: [], incomplete: unsure, done: 0, total: 0 };
  const counted = src.entries.filter((e) => countedPath(e.path) && !e.noText);
  // Anchored files first (a step's file can't wait behind 5,000 others), then the view's order, then by path.
  const anchored = new Set<string>();
  for (const s of found) for (const a of s.manifest.anchors.values()) anchored.add(join(s.prefix, a.file));
  const rank = new Map((opts.order ?? []).map((p, i) => [p, i]));
  const todo = counted.slice().sort((a, b) => {
    const x = Number(!anchored.has(a.path) && !anchored.has(a.oldPath ?? '')) - Number(!anchored.has(b.path) && !anchored.has(b.oldPath ?? ''));
    return x || (rank.get(a.path) ?? 1e9) - (rank.get(b.path) ?? 1e9) || byPath(a.path, b.path);
  });
  const texts = new Map<string, { entry: ChangeEntry; diff: FileDiff; texts: Texts }>();
  let bytes = 0;
  let incomplete = unsure;
  let next = 0;
  const work = async () => {
    while (next < todo.length && isCurrent()) {
      const e = todo[next++]!;
      const key = src.diffKey?.(e);
      const hit = key ? cache.get(key) : undefined;
      if (hit) {
        texts.set(e.path, { entry: e, ...hit });
        continue;
      }
      if (bytes > COVERAGE_WORK.bytesPerRecompute) {
        incomplete = true;
        continue;
      }
      const [ob, nb] = await Promise.all([e.status === 'A' ? undefined : src.oldBytes(e.oldPath ?? e.path), e.status === 'D' ? undefined : src.newBytes(e.path)]);
      if (ob === 'tooLarge' || nb === 'tooLarge') {
        // Past MAX_COMPARE_BYTES: one change, as the checker counts it (no text, so only trivialFiles can cover it).
        texts.set(e.path, { entry: e, diff: { changes: [tooLargeChange(e.path, 0, 0)], tooLarge: 'size', lineEndingsOnly: false, oldLines: 0, newLines: 0 }, texts: { old: undefined, new: undefined } });
        continue;
      }
      if ((e.status !== 'A' && !ob) || (e.status !== 'D' && !nb)) {
        incomplete = true; // unreadable: not counted, and the totals say so
        continue;
      }
      bytes += (ob?.length ?? 0) + (nb?.length ?? 0);
      if (isBinary(ob) || isBinary(nb)) {
        e.noText = true;
        continue;
      }
      const d = decodePair(ob, nb);
      const t: Texts = { old: e.status === 'A' ? undefined : d.old, new: e.status === 'D' ? undefined : d.new };
      const contentKey = key ?? `${src.mergeBase}\0${e.oldPath ?? e.path}\0${e.path}\0${e.status}\0${createHash('sha256').update(d.new).digest('base64')}`;
      let diff = cache.get(contentKey)?.diff;
      if (!diff) {
        diff = diffTexts(e.path, d.old, d.new);
        if (cache.size >= COVERAGE_WORK.diffCache) cache.delete(cache.keys().next().value!);
        cache.set(contentKey, { diff, texts: t });
      }
      texts.set(e.path, { entry: e, diff, texts: t });
    }
  };
  await Promise.all(Array.from({ length: COVERAGE_WORK.parallel }, work));
  if (!isCurrent()) return undefined;
  // By path, whatever order the workers finished in: the same result for the same inputs.
  const done = [...texts.values()].sort((a, b) => byPath(a.entry.path, b.entry.path));

  // Counts from the blocks (§5.2): exact, and the same for renames and untracked files.
  for (const { entry, diff } of done) {
    if (diff.tooLarge) continue;
    entry.added = diff.changes.reduce((n, c) => n + c.added, 0);
    entry.removed = diff.changes.reduce((n, c) => n + c.removed, 0);
    entry.counting = false;
  }

  const byNew = new Map(done.map((t) => [t.entry.path, t]));
  const byOld = new Map(done.map((t) => [t.entry.oldPath ?? t.entry.path, t]));
  const matchers = found.map((s) => ({ s, match: globMatcher(s.manifest.trivialFiles ?? []) }));
  const isTrivialFile = (p: string) => matchers.some(({ s, match }) => {
    const r = under(s.prefix, p);
    return r !== undefined && match(r);
  });
  const targets: Target[] = [];
  const belonging: Belonging[] = [];
  for (const s of found) {
    const used = usedAnchorIds(s.html.length > MAX_HTML_BYTES ? '' : s.html);
    if (used.incomplete) incomplete = true;
    const outline = outlineHtml(s.html);
    belonging.push({
      folder: s.folder,
      prefix: s.prefix,
      dir: s.dir,
      manifest: s.manifest,
      steps: outline.steps.map((x) => ({ id: x.id, title: x.title })),
      stepOf: outline.anchorStep,
      totals: { changes: 0, explained: 0, trivial: 0, left: 0, needsLook: 0, files: 0 },
    });
    for (const a of s.manifest.anchors.values()) {
      if (a.trivial && a.why === undefined) continue;
      if (!a.trivial && !used.ids.has(a.id)) continue; // explains nothing (anchor-unused)
      const side = sideOf(a);
      const p = join(s.prefix, a.file);
      const t = side === 'head' ? byNew.get(p) : byOld.get(p);
      const text = side === 'head' ? t?.texts.new : t?.texts.old;
      if (!t || text === undefined) continue; // a file this branch doesn't change: nothing to cover
      const r = resolveAnchor(PreparedText.from(text), a);
      targets.push({
        sidestory: s.folder,
        anchor: a.id,
        path: p,
        side,
        range: r.range,
        state: r.state,
        ...(a.trivial ? { trivial: true, why: a.why } : {}),
        ...(a.quote && side === 'head' ? { pinned: new Set(textLines(a.quote.exact).map(normLine)) } : {}),
      });
    }
  }
  const inputs: FileInput[] = done.map(({ entry, diff, texts: t }) => {
    const newLines = t.new !== undefined ? textLines(t.new) : [];
    const oldLines = t.old !== undefined ? textLines(t.old) : [];
    return {
      path: entry.path,
      ...(entry.oldPath !== undefined ? { oldPath: entry.oldPath } : {}),
      changes: diff.changes,
      newLine: (l: number) => newLines[l - 1] ?? '',
      oldLine: (l: number) => oldLines[l - 1] ?? '',
      trivialFile: isTrivialFile(entry.path),
      newLines: newLines.length,
    };
  });
  const result = coverage(inputs, targets);
  const files = new Map<string, FileResult>();
  const covByPath = new Map(result.files.map((f) => [f.path, f]));
  for (const { entry, diff } of done) {
    files.set(entry.path, { entry, diff, coverage: covByPath.get(entry.path), blocks: new Map(diff.changes.map((c) => [c.key, c])) });
  }
  // Per sidestory: the changes it explains or marks (a change several explain counts for each).
  for (const b of belonging) {
    const t = b.totals;
    const seen = new Set<string>();
    for (const f of result.files) {
      for (const c of f.changes) {
        if (!c.by.some((x) => x.sidestory === b.folder)) continue;
        seen.add(f.path);
        t.changes++;
        if (c.state === 'explained') t.explained++;
        else if (c.state === 'trivial') t.trivial++;
      }
    }
    t.files = seen.size;
  }
  return { mergeBase: src.mergeBase, belonging, files, totals: result.totals, targets, incomplete, done: done.length, total: counted.length };
}

// ---- the service ----

export interface CoverageHost {
  /** The current comparison. */
  snapshot(): Snapshot | undefined;
  /** Paths to diff first (files open in editors). */
  order(): readonly string[];
  /** Sidestory folders in the workspace (the index). */
  sidestoryDirs(): vscode.Uri[];
}

export class CoverageService implements vscode.Disposable {
  private readonly host: CoverageHost;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly subs: vscode.Disposable[] = [];
  private readonly cache = new Map<string, { diff: FileDiff; texts: Texts }>();
  /** Merge-bases by (base spec, head): resolving a base costs a few git calls. */
  private readonly own = new Map<string, Promise<string | undefined>>();
  /** Whether the merge-base holds a path: immutable per merge-base. */
  private readonly present = new Map<string, Promise<boolean | undefined>>();
  private readonly oldTexts = new Map<string, Promise<Uint8Array | 'tooLarge' | undefined>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private seq = 0;
  private running = false;
  private again = false;
  private wanted = new Set<string>();
  result: CoverageResult | undefined;

  constructor(host: CoverageHost) {
    this.host = host;
    this.subs.push(
      this.emitter,
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length && this.result && this.affects(e.document.uri)) this.schedule();
      }),
      vscode.workspace.onDidSaveTextDocument((d) => {
        if (this.result && this.affects(d.uri)) this.schedule();
      }),
    );
  }

  /** Who needs coverage now ('workspace', a session key, a command): computing runs only while someone does. */
  want(who: string, on: boolean): void {
    const before = this.wanted.size > 0;
    if (on) this.wanted.add(who);
    else this.wanted.delete(who);
    if (!before && this.wanted.size > 0) this.schedule(0);
  }

  get active(): boolean {
    return this.wanted.size > 0;
  }

  /** An open sidestory with this base wants coverage (its author's loop: unexplained marks in diffs, §7.3). */
  get wantedBySession(): boolean {
    return [...this.wanted].some((w) => w.startsWith('session:'));
  }

  private affects(uri: vscode.Uri): boolean {
    const s = this.host.snapshot();
    if (!s || s.mode !== 'workingTree') return false;
    const p = relPath(s.repo, uri);
    return !!p && (s.entries.some((e) => e.path === p) || isSidestoryPath(p));
  }

  /** Recompute soon (the comparison changed, a sidestory changed, an edit). */
  schedule(delay: number = COVERAGE_WORK.debounceMs): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), delay);
  }

  /** The merge-base a base spec gives against the snapshot's head (cached per head), for sessions too. */
  ownMergeBase(s: Snapshot, spec: string): Promise<string | undefined> {
    const key = `${spec}\0${s.head.sha}`;
    let p = this.own.get(key);
    if (!p) {
      const reader = refReader(s.repo);
      p = resolveBase(reader, spec).then((b) => (b ? reader.mergeBase(b.sha, s.head.sha) : undefined)).catch(() => undefined);
      if (this.own.size > 200) this.own.clear();
      this.own.set(key, p);
    }
    return p;
  }

  private source(s: Snapshot): CoverageSource {
    const repo = s.repo;
    const blob = async (sha: string, p: string): Promise<Uint8Array | 'tooLarge' | undefined> => {
      try {
        if ((await repo.getObjectDetails(sha, apiPath(repo, p))).size > COVERAGE_WORK.fileBytes) return 'tooLarge';
        return await repo.buffer(sha, apiPath(repo, p));
      } catch {
        return undefined; // missing or unreadable
      }
    };
    const fileUri = (p: string) => vscode.Uri.joinPath(repo.rootUri, ...p.split('/'));
    const disk = async (uri: vscode.Uri): Promise<Uint8Array | 'tooLarge' | undefined> => {
      try {
        const st = await vscode.workspace.fs.stat(uri);
        if (st.type !== vscode.FileType.File) return undefined;
        if (st.size > COVERAGE_WORK.fileBytes) return 'tooLarge';
        return await vscode.workspace.fs.readFile(uri);
      } catch {
        return undefined;
      }
    };
    const working = async (p: string): Promise<Uint8Array | 'tooLarge' | undefined> => {
      const uri = fileUri(p);
      const bytes = await disk(uri);
      // Unsaved edits count in working tree mode (§9.7): the open document's text, but only while the file on disk
      // is UTF-8. A Latin-1 file's text re-encoded as UTF-8 would turn every non-ASCII line into a change (§5.2).
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
      if (doc?.isDirty && bytes !== 'tooLarge' && (!bytes || decodeUtf8(bytes) !== undefined)) return new TextEncoder().encode(doc.getText());
      return bytes;
    };
    return {
      mergeBase: s.mergeBase,
      entries: s.entries,
      candidates: () => this.candidates(s),
      presentAtMergeBase: (p) => {
        const key = `${s.mergeBase}\0${p}`;
        let v = this.present.get(key);
        if (!v) {
          v = repo.getObjectDetails(s.mergeBase, apiPath(repo, p)).then(
            () => true,
            (e: unknown) => (isUnknownPath(e) ? false : undefined),
          );
          if (this.present.size > 2000) this.present.clear();
          this.present.set(key, v);
        }
        return v;
      },
      ownMergeBase: (spec) => this.ownMergeBase(s, spec),
      oldBytes: (p) => {
        // The merge-base's blobs never change: kept across recomputes.
        const key = `${s.mergeBase}\0${p}`;
        let v = this.oldTexts.get(key);
        if (!v) {
          v = blob(s.mergeBase, p);
          if (this.oldTexts.size >= COVERAGE_WORK.textCache) this.oldTexts.delete(this.oldTexts.keys().next().value!);
          this.oldTexts.set(key, v);
        }
        return v;
      },
      newBytes: (p) => (s.mode === 'workingTree' ? working(p) : blob(s.head.sha, p)),
      // Committed mode: both sides are immutable blobs.
      diffKey: (e) => (s.mode === 'committed' ? `${s.mergeBase}\0${s.head.sha}\0${e.oldPath ?? e.path}\0${e.path}\0${e.status}` : undefined),
    };
  }

  /** Sidestory folders in this repository, read where the comparison's head is: the working tree, or HEAD. */
  private async candidates(s: Snapshot): Promise<Candidate[]> {
    const out: Candidate[] = [];
    for (const dir of this.host.sidestoryDirs()) {
      const folder = relPath(s.repo, dir);
      if (!folder) continue;
      const parts = folder.split('/');
      const i = parts.lastIndexOf('.sidestory');
      if (i < 0 || i !== parts.length - 2) continue;
      const prefix = parts.slice(0, i).join('/');
      let manifestText: string | undefined;
      let html: string | undefined;
      if (s.mode === 'workingTree') {
        const root = vscode.Uri.joinPath(s.repo.rootUri, ...(prefix ? prefix.split('/') : []));
        manifestText = await readInside(vscode.Uri.joinPath(dir, 'manifest.json'), root, MAX_MANIFEST_BYTES);
        html = await readInside(vscode.Uri.joinPath(dir, 'sidestory.html'), root, MAX_HTML_BYTES);
      } else {
        const read = async (name: string, max: number) => {
          try {
            const p = apiPath(s.repo, `${folder}/${name}`);
            if ((await s.repo.getObjectDetails(s.head.sha, p)).size > max) return undefined;
            return new TextDecoder().decode(await s.repo.buffer(s.head.sha, p));
          } catch {
            return undefined;
          }
        };
        manifestText = await read('manifest.json', MAX_MANIFEST_BYTES);
        html = await read('sidestory.html', MAX_HTML_BYTES);
      }
      // Both files, or it isn't a sidestory yet (an agent still writing the page), as the checker counts.
      if (manifestText !== undefined && html !== undefined) out.push({ folder, prefix, dir, manifestText, html });
    }
    return out;
  }

  private async run(): Promise<void> {
    if (this.running) {
      this.again = true;
      return;
    }
    const s = this.host.snapshot();
    if (!s || !this.active) return;
    this.running = true;
    const mine = ++this.seq;
    const live = () => mine === this.seq && this.host.snapshot() === s;
    try {
      const r = await computeCoverage(this.source(s), { order: this.host.order(), cache: this.cache, isCurrent: live });
      if (r && live()) {
        this.result = r;
        this.emitter.fire();
      }
    } catch (e) {
      log.warn(`coverage: ${(e as Error).message}`);
    } finally {
      this.running = false;
      if (this.again) {
        this.again = false;
        this.schedule(0);
      }
    }
  }


  dispose(): void {
    clearTimeout(this.timer);
    this.seq++;
    this.subs.forEach((d) => d.dispose());
  }
}

/** The git extension's answer for a path a commit doesn't have (`GitErrorCodes.UnknownPath`), as opposed to an error. */
export function isUnknownPath(e: unknown): boolean {
  const x = e as { gitErrorCode?: unknown; message?: unknown } | undefined;
  return x?.gitErrorCode === 'UnknownPath' || (typeof x?.message === 'string' && /not known by git|does not exist in|exists on disk, but not in/i.test(x.message));
}

export type { GitRepo };

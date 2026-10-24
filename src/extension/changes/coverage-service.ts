// Coverage of the branch's changes by the sidestories that belong to it (docs/CHANGES-PLAN.md §6.1–§6.5, §9.6), in
// the extension. The same pure functions as the checker (`belongs`, `coverage`, `usedAnchorIds`, `diffTexts`), fed
// through the git extension: belonging sidestories (manifest absent at the merge-base, present at the head, the same
// merge-base from their own `base`), their used anchors resolved per side (head side against the comparison's new
// text, base side against the merge-base blob of the old path), and change blocks from both sides decoded the same
// way. Work is lazy and bounded (§4.6): only while someone needs it (a sidestory with a base in the workspace, an open
// one, or a command), 4 files at a time, anchored files first, at most 200 MB read per recompute, cached by content
// within byte budgets. The rules shared with the checker (src/cli/coverage.ts): which entries count (`countedChange`,
// archive moves by `archiveMoveCandidates` and `isArchivedManifest`), a sidestory needs both its files (a page past
// the read cap still makes it one, incomplete), unstaged renames are paired by content (`pairUnstagedRenames`), a
// move group is one change (`moveGroups`, per old folder → new folder), and each of these counts as ONE change that only
// trivialFiles can cover (`tooLargeChange`): a side past MAX_COMPARE_BYTES, a binary file, a Git LFS file, a symlink,
// a submodule, a type change, an unsupported path, a file under an archive. An unreadable side makes the result
// incomplete.
//
// `computeCoverage` is the core and takes a `CoverageSource` (unit tests stub it); `CoverageService` builds the
// source from the comparison's snapshot and the git extension, caches, and fires when a result changes.
import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import * as vscode from 'vscode';
import { coverage, normLine, usedAnchorIds, type FileCoverage, type FileInput, type Target, type Totals } from '../../core/coverage.ts';
import { globMatcher } from '../../core/glob.ts';
import { outlineHtml } from '../../core/html-scan.ts';
import { decodeLatin1, decodePair, decodeUtf8, diffTexts, isBinary, isLfsChange, MAX_COMPARE_BYTES, textLines, tooLargeChange, moveCarriers, moveGroups, type ChangeBlock, type FileDiff, type MoveGroup } from '../../core/hunks.ts';
import type { Manifest } from '../../core/manifest.ts';
import { parseManifest, sideOf } from '../../core/manifest.ts';
import { archiveMoveCandidates, belongs, countedChange, isArchivedManifest, isArchivePath, isOwnedFileName, isThreadEventBytes, SIDESTORY_FILES, sidestoryFolderOf, threadEventPath } from '../../core/membership.ts';
import { pairUnstagedRenames } from '../../core/renames.ts';
import { isSafeFsPath, isSafeRepoPath } from '../../core/repo-path.ts';
import { resolveAnchor } from '../../core/resolve.ts';
import { PreparedText } from '../../core/text.ts';
import { MAX_MANIFEST_BYTES, readBytesInside, readInside } from '../explainers.ts';
import { localPath } from '../local-path.ts';
import { log } from '../log.ts';
import { realPathInside } from '../paths.ts';
import { resolveBase } from './base.ts';
import type { Snapshot } from './comparison.ts';
import type { GitRepo } from './git-api.ts';
import { apiPath, refReader, relPath } from './git-api.ts';
import type { ChangeEntry } from './model.ts';

export const COVERAGE_WORK = {
  parallel: 4,
  bytesPerRecompute: 200 * 1024 * 1024,
  fileBytes: MAX_COMPARE_BYTES,
  /** A sidestory's page: read up to the checker's cap (MAX_COMPARE_BYTES); past it, a candidate that is incomplete. */
  htmlBytes: MAX_COMPARE_BYTES,
  debounceMs: 300,
  /** Diffs and their texts kept between recomputes, by estimated size (one entry per path in working tree mode). */
  diffCacheBytes: 64 * 1024 * 1024,
  /** Merge-base blobs kept between recomputes, by size. */
  oldBlobBytes: 64 * 1024 * 1024,
} as const;

/**
 * What one side of a changed file holds: its bytes, or why it has none to compare. 'tooLarge' past
 * MAX_COMPARE_BYTES; 'link', 'submodule' and 'unsupported' (a path the file system rule refuses, or something other
 * than a file on disk) count as one change; undefined when unreadable (the result is incomplete).
 */
export type SideBytes = Uint8Array | 'tooLarge' | 'link' | 'submodule' | 'unsupported' | undefined;

/** A changed file the comparison couldn't list because of its path (`isSafeRepoPath`): it counts as one change. */
export interface UnsupportedEntry {
  readonly path: string;
  readonly oldPath?: string;
}

/** Why a file counts as one change without a line diff. */
export type WholeKind = 'tooLarge' | 'binary' | 'lfs' | 'link' | 'submodule' | 'unsupported' | 'archive';

/** A sidestory folder seen at the head (working tree or HEAD), before the membership test. */
export interface Candidate {
  /** Repo-relative folder (`.sidestory/retry-jitter`, `pkg/.sidestory/x`). */
  folder: string;
  /** The package root, repo-relative ('' for the repository root): anchor files are relative to it. */
  prefix: string;
  dir: vscode.Uri;
  manifestText: string;
  html: string;
  /** The page is over COVERAGE_WORK.htmlBytes: still a candidate, but its anchors can't be read (incomplete). */
  htmlTooLarge?: boolean;
}

/** What `computeCoverage` reads; every method resolves to undefined rather than throwing. */
export interface CoverageSource {
  readonly mergeBase: string;
  readonly entries: readonly ChangeEntry[];
  /** Changed files left out of `entries` for their paths: each counts as one change (§5.1). */
  readonly unsupported?: readonly UnsupportedEntry[];
  candidates(): Promise<Candidate[]>;
  /** Whether the merge-base holds a path; undefined when git couldn't say (an error is never "absent"). */
  presentAtMergeBase(repoPath: string): Promise<boolean | undefined>;
  /** The merge-base a sidestory's `base` gives against the comparison's head. */
  ownMergeBase(spec: string): Promise<string | undefined>;
  /** A side's bytes, or why there are none (`SideBytes`). */
  oldBytes(repoPath: string): Promise<SideBytes>;
  newBytes(repoPath: string): Promise<SideBytes>;
  /** The new side as saved (on disk, or HEAD's blob), never an open document's unsaved text: archive moves are checked on it. */
  newDiskBytes?(repoPath: string): Promise<SideBytes>;
  /** A content key for the new side when it is cheaper than reading it (immutable blobs); else undefined. */
  diffKey?(e: ChangeEntry): string | undefined;
  /**
   * Whether a sidestory folder holds both its files as regular files, at the head (on disk in working tree mode) and
   * at the merge-base; only a complete sidestory's two files are left out (§5.1). Absent: assumed complete.
   */
  completeSidestory?(folder: string): Promise<{ head: boolean; mergeBase: boolean }>;
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
  /** Counted as one change without a line diff, and why. */
  whole?: WholeKind;
  /** This file carries its move group's one change (first in `coverage.changes`, in `blocks`; not in `diff`). */
  move?: MoveGroup;
  /** Moved with a group another file carries: that file's path. */
  movedWith?: string;
}

export interface CoverageResult {
  mergeBase: string;
  belonging: Belonging[];
  files: Map<string, FileResult>;
  totals: Totals;
  targets: Target[];
  /** Changed files with paths Sidestory won't read (not in `files`): each is one change in the totals. */
  unsupported: string[];
  /** Those of `unsupported` no trivialFiles glob covers: still left, and found only through This branch. */
  unsupportedLeft: string[];
  /**
   * Unstaged renames paired by content (§4.6): old path → new path. The comparison lists them as a deleted file and
   * an untracked one; `files` has one entry for the pair, under the new path, with status R and the old path.
   */
  paired: Map<string, string>;
  /** A page too large to scan, or the byte budget spent: coverage is not complete. */
  incomplete: boolean;
  /** Files diffed so far / files to diff (the totals say "computing…" until they match). */
  done: number;
  total: number;
}

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

/** A cached diff: `content` says which texts it was computed from (working tree mode replaces it on new content). */
export interface DiffCacheEntry {
  diff: FileDiff;
  texts: Texts;
  content?: string;
}

/** Where diffs are kept between calls: a Map in tests, a `ByteLru` in the service. */
export interface DiffCache {
  get(key: string): DiffCacheEntry | undefined;
  set(key: string, value: DiffCacheEntry): void;
}

/**
 * A least-recently-used map bounded by total bytes (`sizeOf` each value), not by entry count: a few huge files and
 * thousands of small ones cost what they weigh. A value larger than the whole budget isn't kept.
 */
export class ByteLru<V> {
  private readonly map = new Map<string, { v: V; n: number }>();
  private total = 0;
  readonly maxBytes: number;
  private readonly sizeOf: (v: V) => number;
  constructor(maxBytes: number, sizeOf: (v: V) => number) {
    this.maxBytes = maxBytes;
    this.sizeOf = sizeOf;
  }
  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    this.map.delete(key);
    this.map.set(key, e);
    return e.v;
  }
  set(key: string, v: V): void {
    this.delete(key);
    const n = Math.max(1, this.sizeOf(v));
    if (n > this.maxBytes) return;
    this.map.set(key, { v, n });
    this.total += n;
    while (this.total > this.maxBytes) {
      const [k, e] = this.map.entries().next().value!;
      this.map.delete(k);
      this.total -= e.n;
    }
  }
  delete(key: string): void {
    const e = this.map.get(key);
    if (!e) return;
    this.map.delete(key);
    this.total -= e.n;
  }
  clear(): void {
    this.map.clear();
    this.total = 0;
  }
  get bytes(): number {
    return this.total;
  }
  get size(): number {
    return this.map.size;
  }
}

/** A cached diff's weight: its texts (up to 2 bytes a character) and its blocks. */
export const diffEntryBytes = (e: DiffCacheEntry) => 2 * ((e.texts.old?.length ?? 0) + (e.texts.new?.length ?? 0)) + 256 * (e.diff.changes.length + 1);

type Classified = { kind: 'text'; ob: Uint8Array | undefined; nb: Uint8Array | undefined } | { kind: 'whole'; whole: WholeKind } | { kind: 'unreadable' };

/**
 * What a changed file's two sides make it, in the checker's order (src/cli/coverage.ts): a link, submodule or
 * unsupported side first, then an unreadable side, then one past the size cap, then Git LFS (one change),
 * then binary (one change), else text.
 */
function classify(e: ChangeEntry, ob: SideBytes, nb: SideBytes): Classified {
  const sides = [ob, nb];
  if (sides.includes('submodule')) return { kind: 'whole', whole: 'submodule' };
  if (sides.includes('link')) return { kind: 'whole', whole: 'link' };
  if (sides.includes('unsupported')) return { kind: 'whole', whole: 'unsupported' };
  if ((e.status !== 'A' && ob === undefined) || (e.status !== 'D' && nb === undefined)) return { kind: 'unreadable' };
  if (ob === 'tooLarge' || nb === 'tooLarge') return { kind: 'whole', whole: 'tooLarge' };
  const o = ob as Uint8Array | undefined;
  const n = nb as Uint8Array | undefined;
  // Stored in Git LFS (every side a complete pointer): its contents can't be compared, so one change, as the checker.
  if (isLfsChange(o, n)) return { kind: 'whole', whole: 'lfs' };
  if (isBinary(o) || isBinary(n)) return { kind: 'whole', whole: 'binary' };
  return { kind: 'text', ob: o, nb: n };
}

const sideSize = (b: SideBytes) => (b instanceof Uint8Array ? b.length : 0);
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** One change spanning nothing: only a trivialFiles match covers it (the checker's `tooLargeChange`). */
const wholeDiff = (path: string): FileDiff => ({ changes: [tooLargeChange(path, 0, 0)], tooLarge: 'size', lineEndingsOnly: false, oldLines: 0, newLines: 0 });

/**
 * Coverage of the comparison's files by the belonging sidestories. `order` puts files first (expanded and visible
 * ones, in view order); anchored files go before the rest. `cache` keeps diffs by content between calls.
 */
export async function computeCoverage(
  src: CoverageSource,
  opts: { order?: readonly string[]; cache?: DiffCache; isCurrent?: () => boolean; onProgress?: (r: CoverageResult) => void } = {},
): Promise<CoverageResult | undefined> {
  const isCurrent = opts.isCurrent ?? (() => true);
  const cache: DiffCache = opts.cache ?? new Map();
  const { found, incomplete: unsure } = await belongingSidestories(src);
  if (!isCurrent()) return undefined;
  const none: Totals = { changes: 0, explained: 0, trivial: 0, left: 0, needsLook: 0, files: 0 };
  // No layer without a sidestory (§9.2): the navigator's own counting fills in the counts then.
  if (!found.length) return emptyResult(src.mergeBase, unsure);
  // Which entries count, as the checker decides (src/cli/coverage.ts): only the two files of a sidestory complete at
  // the head or the merge-base are left out; a rename between code and such a file is its code side alone; an
  // unchanged archive move of a sidestory complete at the merge-base isn't code; anything else under an archive is
  // one change. Every counted path is read, numstat's "no text" ones too: a binary file counts as one change.
  const owned = new Set<string>();
  for (const e of src.entries) {
    for (const p of [e.path, e.oldPath]) {
      const f = p !== undefined ? sidestoryFolderOf(p) : undefined;
      if (f && isOwnedFileName(p!.slice(f.length + 1))) owned.add(f);
    }
  }
  const completeness = new Map<string, Promise<{ head: boolean; mergeBase: boolean }>>();
  const completeOf = (f: string) => {
    let v = completeness.get(f);
    if (!v) completeness.set(f, (v = src.completeSidestory ? src.completeSidestory(f) : Promise.resolve({ head: true, mergeBase: true })));
    return v;
  };
  const complete = new Set<string>();
  for (const f of owned) {
    const c = await completeOf(f);
    if (c.head || c.mergeBase) complete.add(f);
  }
  const moves = new Set<ChangeEntry>();
  for (const { entry, from, folder, file } of archiveMoveCandidates(src.entries, isSafeRepoPath)) {
    if (!(await completeOf(folder)).mergeBase) continue;
    // As the checker confirms it: the same bytes, or for manifest.json the archive job's rewrite (isArchivedManifest).
    const [ob, nb] = await Promise.all([src.oldBytes(from.oldPath ?? from.path), (src.newDiskBytes ?? src.newBytes)(entry.path)]);
    if (!(ob instanceof Uint8Array) || !(nb instanceof Uint8Array)) continue;
    if (file === 'manifest.json' ? !isArchivedManifest(ob, nb) : !sameBytes(ob, nb)) continue;
    moves.add(entry).add(from);
  }
  // Shared comment event files are the sidestory's own only when they are one (as the checker decides).
  const notEvents = new Set<ChangeEntry>();
  for (const e of src.entries) {
    const ids = e.status !== 'D' ? threadEventPath(e.path) : undefined;
    if (!ids) continue;
    const nb = await (src.newDiskBytes ?? src.newBytes)(e.path);
    if (!isThreadEventBytes(ids, nb instanceof Uint8Array ? nb : undefined)) notEvents.add(e);
  }
  if (!isCurrent()) return undefined;
  const counted: ChangeEntry[] = [];
  const archived: ChangeEntry[] = [];
  for (const e of src.entries) {
    if (moves.has(e)) continue;
    if (isArchivePath(e.path) || (e.oldPath !== undefined && isArchivePath(e.oldPath))) {
      archived.push(e);
      continue;
    }
    const c = notEvents.has(e) ? { counted: true as const } : countedChange(e, (f) => complete.has(f));
    if (!c.counted) continue;
    if (c.as === 'deletion') counted.push({ path: e.oldPath!, status: 'D' });
    else if (c.as === 'addition') counted.push({ path: e.path, status: 'A', ...(e.untracked ? { untracked: true } : {}), ...(e.unsaved ? { unsaved: true } : {}) });
    else counted.push(e);
  }
  // Anchored files first (a step's file can't wait behind 5,000 others), then the view's order, then by path.
  const anchored = new Set<string>();
  for (const s of found) for (const a of s.manifest.anchors.values()) anchored.add(join(s.prefix, a.file));
  const rank = new Map((opts.order ?? []).map((p, i) => [p, i]));
  let todo = counted.slice().sort((a, b) => {
    const x = Number(!anchored.has(a.path) && !anchored.has(a.oldPath ?? '')) - Number(!anchored.has(b.path) && !anchored.has(b.oldPath ?? ''));
    return x || (rank.get(a.path) ?? 1e9) - (rank.get(b.path) ?? 1e9) || byPath(a.path, b.path);
  });
  const texts = new Map<string, { entry: ChangeEntry; diff: FileDiff; texts: Texts; whole?: WholeKind }>();
  /** Sides read before the main pass (rename pairing), by entry. */
  const pre = new Map<ChangeEntry, { ob: SideBytes; nb: SideBytes }>();
  /** A paired rename → the untracked entry of the comparison it stands for (its counts are shown there). */
  const originals = new Map<ChangeEntry, ChangeEntry>();
  const paired = new Map<string, string>();
  let bytes = 0;
  let incomplete = unsure;
  const read = async (e: ChangeEntry) => {
    const r = pre.get(e);
    if (r) return r;
    const [ob, nb] = await Promise.all([e.status === 'A' ? undefined : src.oldBytes(e.oldPath ?? e.path), e.status === 'D' ? undefined : src.newBytes(e.path)]);
    bytes += sideSize(ob) + sideSize(nb);
    return { ob, nb };
  };
  const pool = async (list: readonly ChangeEntry[], each: (e: ChangeEntry) => Promise<void>) => {
    let next = 0;
    await Promise.all(
      Array.from({ length: COVERAGE_WORK.parallel }, async () => {
        while (next < list.length && isCurrent()) await each(list[next++]!);
      }),
    );
  };

  // Unstaged renames (§4.6), as the checker pairs them: deleted tracked files and untracked ones, by content.
  const deleted = todo.filter((e) => e.status === 'D' && !e.untracked);
  const untracked = todo.filter((e) => e.status === 'A' && e.untracked);
  if (deleted.length && untracked.length) {
    await pool([...deleted, ...untracked], async (e) => {
      if (bytes > COVERAGE_WORK.bytesPerRecompute) {
        incomplete = true;
        return;
      }
      pre.set(e, await read(e));
    });
    if (!isCurrent()) return undefined;
    const isText = (e: ChangeEntry) => {
      const r = pre.get(e);
      return !!r && classify(e, r.ob, r.nb).kind === 'text';
    };
    const pairs = pairUnstagedRenames(
      deleted.filter(isText),
      untracked.filter(isText),
      (d) => pre.get(d)!.ob as Uint8Array,
      (a) => pre.get(a)!.nb as Uint8Array,
    );
    if (pairs.length) {
      const gone = new Set(pairs.map((p) => p.deleted));
      const into = new Map(pairs.map((p) => [p.added, p.deleted]));
      todo = todo
        .filter((e) => !gone.has(e))
        .map((e) => {
          const d = into.get(e);
          if (!d) return e;
          const r: ChangeEntry = { path: e.path, oldPath: d.path, status: 'R', untracked: true, ...(e.unsaved ? { unsaved: true } : {}) };
          pre.set(r, { ob: pre.get(d)!.ob, nb: pre.get(e)!.nb });
          originals.set(r, e);
          paired.set(d.path, e.path);
          d.counting = false;
          return r;
        });
    }
  }

  await pool(todo, async (e) => {
    const key = src.diffKey?.(e);
    const hit = key ? cache.get(key) : undefined;
    if (hit) {
      texts.set(e.path, { entry: e, diff: hit.diff, texts: hit.texts });
      return;
    }
    if (!pre.has(e) && bytes > COVERAGE_WORK.bytesPerRecompute) {
      incomplete = true;
      return;
    }
    const { ob, nb } = await read(e);
    const c = classify(e, ob, nb);
    if (c.kind === 'unreadable') {
      incomplete = true; // unreadable: not counted, and the totals say so
      return;
    }
    if (c.kind === 'whole') {
      if (c.whole === 'binary' || c.whole === 'lfs') e.noText = true;
      texts.set(e.path, { entry: e, diff: wholeDiff(e.path), texts: { old: undefined, new: undefined }, whole: c.whole });
      return;
    }
    const d = decodePair(c.ob, c.nb);
    const t: Texts = { old: e.status === 'A' ? undefined : d.old, new: e.status === 'D' ? undefined : d.new };
    // Committed mode: immutable blobs, keyed by commit. Working tree mode: one slot per path, replaced when the
    // content (or the merge-base, the old path or the status) changes.
    const slot = key ?? `wt\0${e.path}`;
    const content = key ? undefined : `${src.mergeBase}\0${e.oldPath ?? e.path}\0${e.status}\0${createHash('sha256').update(d.new).digest('base64')}`;
    const cached = cache.get(slot);
    let diff = cached && cached.content === content ? cached.diff : undefined;
    if (!diff) {
      diff = diffTexts(e.path, d.old, d.new);
      cache.set(slot, { diff, texts: t, ...(content !== undefined ? { content } : {}) });
    }
    texts.set(e.path, { entry: e, diff, texts: t });
  });
  if (!isCurrent()) return undefined;
  // Under a sidestory archive and not an unchanged archive move: one change each, unread.
  for (const e of archived) if (!texts.has(e.path)) texts.set(e.path, { entry: e, diff: wholeDiff(e.path), texts: { old: undefined, new: undefined }, whole: 'archive' });
  // By path, whatever order the workers finished in: the same result for the same inputs.
  const done = [...texts.values()].sort((a, b) => byPath(a.entry.path, b.entry.path));

  // Counts from the blocks (§5.2): exact, and the same for renames and untracked files.
  for (const { entry, diff } of done) {
    if (diff.tooLarge) continue;
    const added = diff.changes.reduce((n, c) => n + c.added, 0);
    const removed = diff.changes.reduce((n, c) => n + c.removed, 0);
    for (const x of [entry, originals.get(entry)]) {
      if (!x) continue;
      x.added = added;
      x.removed = removed;
      x.counting = false;
    }
  }

  // One entry per path on each side, as the checker picks them: an added file has no merge-base side; a file's own
  // entry wins over a copy made from it; then the first by path.
  const byNew = new Map<string, (typeof done)[number]>();
  const byOld = new Map<string, (typeof done)[number]>();
  for (const t of done) if (!byNew.has(t.entry.path)) byNew.set(t.entry.path, t);
  for (const copies of [false, true]) {
    for (const t of done) {
      if ((t.entry.status === 'C') !== copies || t.entry.status === 'A') continue;
      const k = t.entry.oldPath ?? t.entry.path;
      if (!byOld.has(k)) byOld.set(k, t);
    }
  }
  const matchers = found.map((s) => ({ s, match: globMatcher(s.manifest.trivialFiles ?? []) }));
  const isTrivialFile = (p: string) => matchers.some(({ s, match }) => {
    const r = under(s.prefix, p);
    return r !== undefined && match(r);
  });
  const targets: Target[] = [];
  const belonging: Belonging[] = [];
  for (const s of found) {
    // The checker's caps: a page read up to MAX_COMPARE_BYTES and scanned with usedAnchorIds' own limits.
    const used = s.htmlTooLarge ? { ids: new Set<string>(), incomplete: true } : usedAnchorIds(s.html);
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
  // Moves (§5.1), as the checker counts them: one change per (old folder → new folder), on the group's first file.
  // Archive changes and unsupported paths are counted already, one change each: never in a move group too.
  const groups = moveGroups(done.filter((d) => d.whole !== 'archive' && d.whole !== 'unsupported').map((d) => d.entry));
  const carried = moveCarriers(groups, (p) => texts.has(p));
  const movedWith = new Map<string, string>();
  for (const g of groups) {
    const carrier = g.files.find((f) => carried.has(f.path))?.path;
    if (carrier) for (const f of g.files) if (f.path !== carrier) movedWith.set(f.path, carrier);
  }
  const inputs: FileInput[] = done.map(({ entry, diff, texts: t }) => {
    const newLines = t.new !== undefined ? textLines(t.new) : [];
    const oldLines = t.old !== undefined ? textLines(t.old) : [];
    return {
      path: entry.path,
      ...(entry.oldPath !== undefined ? { oldPath: entry.oldPath } : {}),
      changes: carried.has(entry.path) ? [carried.get(entry.path)!, ...diff.changes] : diff.changes,
      newLine: (l: number) => newLines[l - 1] ?? '',
      oldLine: (l: number) => oldLines[l - 1] ?? '',
      trivialFile: isTrivialFile(entry.path),
      newLines: newLines.length,
    };
  });
  // Paths the comparison couldn't list: one change each, coverable only by trivialFiles; never in `files`.
  const unsupported = (src.unsupported ?? []).filter((u) => !texts.has(u.path)).sort((a, b) => byPath(a.path, b.path));
  for (const u of unsupported) {
    inputs.push({ path: u.path, ...(u.oldPath !== undefined ? { oldPath: u.oldPath } : {}), changes: [tooLargeChange(u.path, 0, 0)], newLine: () => '', oldLine: () => '', trivialFile: isTrivialFile(u.path), newLines: 0 });
  }
  const result = coverage(inputs, targets);
  const files = new Map<string, FileResult>();
  const covByPath = new Map(result.files.map((f) => [f.path, f]));
  for (const { entry, diff, whole } of done) {
    const move = carried.get(entry.path);
    const blocks = new Map([...(move ? [move] : []), ...diff.changes].map((c) => [c.key, c]));
    const withWhom = movedWith.get(entry.path);
    files.set(entry.path, { entry, diff, coverage: covByPath.get(entry.path), blocks, ...(whole ? { whole } : {}), ...(move?.move ? { move: move.move } : {}), ...(withWhom ? { movedWith: withWhom } : {}) });
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
  const unsupportedLeft = unsupported.filter((u) => covByPath.get(u.path)?.changes.some((c) => c.state !== 'trivial' && c.state !== 'explained') ?? true).map((u) => u.path);
  return {
    mergeBase: src.mergeBase,
    belonging,
    files,
    totals: result.totals,
    targets,
    unsupported: unsupported.map((u) => u.path),
    unsupportedLeft,
    paired,
    incomplete,
    done: done.length + unsupported.length,
    total: todo.length + unsupported.length,
  };
}

/** A result with nothing in it (no sidestory belongs, or the run failed: then `incomplete`). */
export function emptyResult(mergeBase: string, incomplete: boolean): CoverageResult {
  return { mergeBase, belonging: [], files: new Map(), totals: { changes: 0, explained: 0, trivial: 0, left: 0, needsLook: 0, files: 0 }, targets: [], unsupported: [], unsupportedLeft: [], paired: new Map(), incomplete, done: 0, total: 0 };
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
  private readonly cache = new ByteLru<DiffCacheEntry>(COVERAGE_WORK.diffCacheBytes, diffEntryBytes);
  /** Merge-bases by (base spec, head): resolving a base costs a few git calls. */
  private readonly own = new Map<string, Promise<string | undefined>>();
  /** Whether the merge-base holds a path: immutable per merge-base. */
  private readonly present = new Map<string, Promise<boolean | undefined>>();
  /** Merge-base sides read so far (immutable), bounded by bytes; reads in flight are shared. */
  private readonly oldTexts = new ByteLru<SideBytes>(COVERAGE_WORK.oldBlobBytes, (b) => (b instanceof Uint8Array ? b.length : 64));
  private readonly oldInFlight = new Map<string, Promise<SideBytes>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private seq = 0;
  private running = false;
  private again = false;
  private wanted = new Set<string>();
  result: CoverageResult | undefined;
  /** The snapshot the result was computed for, once the run drained its queue (skipped files included). */
  resultFor: Snapshot | undefined;

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
    // The last one gone (the last sidestory with a base deleted, its panel closed): no stale marks, rows or keys.
    if (before && this.wanted.size === 0) this.clear();
  }

  /** Drops the result (and any run in flight), and says so. */
  clear(): void {
    clearTimeout(this.timer);
    this.seq++;
    const had = !!this.result;
    this.result = undefined;
    this.resultFor = undefined;
    if (had) this.emitter.fire();
  }

  /**
   * One file's change blocks, for a branch no sidestory explains yet (Explain This Change, Mark as Trivial): the
   * same reads and diff as coverage. Undefined when unreadable, binary or too large.
   */
  async diffOne(s: Snapshot, e: ChangeEntry): Promise<FileDiff | undefined> {
    const src = this.source(s);
    const [ob, nb] = await Promise.all([e.status === 'A' ? undefined : src.oldBytes(e.oldPath ?? e.path), e.status === 'D' ? undefined : src.newBytes(e.path)]);
    const c = classify(e, ob, nb);
    if (c.kind !== 'text') return undefined;
    const d = decodePair(c.ob, c.nb);
    return diffTexts(e.path, d.old, d.new);
  }

  get active(): boolean {
    return this.wanted.size > 0;
  }

  /** Whether `who` still wants coverage (a session that released it while its request was in flight doesn't). */
  isWanted(who: string): boolean {
    return this.wanted.has(who);
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
    const blob = async (sha: string, p: string): Promise<SideBytes> => {
      try {
        // The mode first: a link's blob is its target's path and a gitlink has none; each counts as one change.
        const details = await repo.getObjectDetails(sha, apiPath(repo, p));
        if (details.mode === '160000') return 'submodule';
        if (details.mode === '120000') return 'link';
        if (details.size > COVERAGE_WORK.fileBytes) return 'tooLarge';
        return await repo.buffer(sha, apiPath(repo, p));
      } catch {
        return undefined; // missing or unreadable
      }
    };
    const fileUri = (p: string) => vscode.Uri.joinPath(repo.rootUri, ...p.split('/'));
    const disk = async (uri: vscode.Uri): Promise<SideBytes> => {
      try {
        const st = await vscode.workspace.fs.stat(uri);
        // As the checker's lstat: a link (to a file, a folder or nowhere), a folder (a submodule's checkout or a
        // nested repository), anything else that isn't a file.
        if (st.type & vscode.FileType.SymbolicLink) return 'link';
        if (st.type === vscode.FileType.Directory) return 'submodule';
        if (st.type !== vscode.FileType.File) return 'unsupported';
        if (st.size > COVERAGE_WORK.fileBytes) return 'tooLarge';
        return await vscode.workspace.fs.readFile(uri);
      } catch {
        return undefined;
      }
    };
    const working = async (p: string): Promise<SideBytes> => {
      // The file system rule (src/core/repo-path.ts): a device name, a trailing dot or space, or ":" never reaches
      // the disk; the file counts as one change, as the checker counts it.
      if (!isSafeFsPath(p)) return 'unsupported';
      const uri = fileUri(p);
      const bytes = await disk(uri);
      if (!(bytes === undefined || bytes instanceof Uint8Array)) return bytes;
      // Unsaved edits count in working tree mode (§9.7): the open document's text, but only while the file on disk
      // is UTF-8. A Latin-1 file's text re-encoded as UTF-8 would turn every non-ASCII line into a change (§5.2).
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
      if (doc?.isDirty && (!bytes || decodeUtf8(bytes) !== undefined)) return new TextEncoder().encode(doc.getText());
      return bytes;
    };
    return {
      mergeBase: s.mergeBase,
      entries: s.entries,
      // The comparison's entries left out for their paths (comparison.ts: `unsupported`): one change each.
      unsupported: s.unsupported,
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
      completeSidestory: async (folder) => {
        const files = SIDESTORY_FILES.map((n) => `${folder}/${n}`);
        const regularAt = async (sha: string) =>
          (await Promise.all(files.map((p) => repo.getObjectDetails(sha, apiPath(repo, p)).then((d) => d.mode === '100644' || d.mode === '100755', () => false)))).every(Boolean);
        // On disk as the checker's isWorkingFile: a safe path, a regular file (never a link).
        const onDisk = async (p: string) => {
          if (!isSafeFsPath(p)) return false;
          try {
            return (await vscode.workspace.fs.stat(fileUri(p))).type === vscode.FileType.File;
          } catch {
            return false;
          }
        };
        const head = s.mode === 'workingTree' ? (await Promise.all(files.map(onDisk))).every(Boolean) : await regularAt(s.head.sha);
        return { head, mergeBase: await regularAt(s.mergeBase) };
      },
      oldBytes: (p) => this.oldSide(s.mergeBase, p, () => blob(s.mergeBase, p)),
      newBytes: (p) => (s.mode === 'workingTree' ? working(p) : blob(s.head.sha, p)),
      newDiskBytes: (p) => (s.mode === 'workingTree' ? (isSafeFsPath(p) ? disk(fileUri(p)) : Promise.resolve('unsupported' as const)) : blob(s.head.sha, p)),
      // Committed mode: both sides are immutable blobs.
      diffKey: (e) => (s.mode === 'committed' ? `${s.mergeBase}\0${s.head.sha}\0${e.oldPath ?? e.path}\0${e.path}\0${e.status}` : undefined),
    };
  }

  /** A merge-base side: never changes, so kept across recomputes within COVERAGE_WORK.oldBlobBytes. */
  private oldSide(mergeBase: string, p: string, readIt: () => Promise<SideBytes>): Promise<SideBytes> {
    const key = `${mergeBase}\0${p}`;
    const kept = this.oldTexts.get(key);
    if (kept !== undefined) return Promise.resolve(kept);
    let v = this.oldInFlight.get(key);
    if (!v) {
      v = readIt().then((b) => {
        this.oldInFlight.delete(key);
        // An unreadable side is asked again next time (a fetch may bring it).
        if (b !== undefined) this.oldTexts.set(key, b);
        return b;
      });
      this.oldInFlight.set(key, v);
    }
    return v;
  }

  /** Sidestory folders in this repository, read where the comparison's head is: the working tree, or HEAD. */
  private async candidates(s: Snapshot): Promise<Candidate[]> {
    const out: Candidate[] = [];
    // The checker's decoding: UTF-8, else Latin-1 byte for byte.
    const decode = (b: Uint8Array) => decodeUtf8(b) ?? decodeLatin1(b);
    for (const dir of this.host.sidestoryDirs()) {
      const folder = relPath(s.repo, dir);
      if (!folder) continue;
      const parts = folder.split('/');
      const i = parts.lastIndexOf('.sidestory');
      if (i < 0 || i !== parts.length - 2) continue;
      const prefix = parts.slice(0, i).join('/');
      let manifestText: string | undefined;
      let html: string | 'tooLarge' | undefined;
      if (s.mode === 'workingTree') {
        const root = vscode.Uri.joinPath(s.repo.rootUri, ...(prefix ? prefix.split('/') : []));
        manifestText = await readInside(vscode.Uri.joinPath(dir, 'manifest.json'), root, MAX_MANIFEST_BYTES);
        html = await readPage(vscode.Uri.joinPath(dir, 'sidestory.html'), root, decode);
      } else {
        const read = async (name: string, max: number): Promise<string | 'tooLarge' | undefined> => {
          try {
            const p = apiPath(s.repo, `${folder}/${name}`);
            if ((await s.repo.getObjectDetails(s.head.sha, p)).size > max) return 'tooLarge';
            return decode(await s.repo.buffer(s.head.sha, p));
          } catch {
            return undefined;
          }
        };
        const m = await read('manifest.json', MAX_MANIFEST_BYTES);
        manifestText = m === 'tooLarge' ? undefined : m;
        html = await read('sidestory.html', COVERAGE_WORK.htmlBytes);
      }
      // Both files, or it isn't a sidestory yet (an agent still writing the page), as the checker counts. A page
      // past the cap still makes it one: its anchors can't be read, so the result is incomplete.
      if (manifestText !== undefined && html !== undefined) out.push({ folder, prefix, dir, manifestText, html: html === 'tooLarge' ? '' : html, ...(html === 'tooLarge' ? { htmlTooLarge: true } : {}) });
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
        this.resultFor = s;
        this.emitter.fire();
      }
    } catch (e) {
      log.warn(`coverage: ${(e as Error).message}`);
      // Commands wait for a result for this snapshot: give them one, empty and marked incomplete, rather than leave
      // them waiting out their timeout. Never an older result: it may be another merge-base's.
      if (live()) {
        this.result = emptyResult(s.mergeBase, true);
        this.resultFor = s;
        this.emitter.fire();
      }
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

/**
 * A sidestory's page from the working tree with the checker's cap and decoding. As the checker reads it: never a
 * link, and only inside `root` (checked before anything else, an open document's unsaved text included); then the
 * open document's text when it is dirty, else the file's bytes; 'tooLarge' past COVERAGE_WORK.htmlBytes; undefined
 * when missing, a link or outside.
 */
async function readPage(uri: vscode.Uri, root: vscode.Uri, decode: (b: Uint8Array) => string): Promise<string | 'tooLarge' | undefined> {
  if (uri.scheme === 'file' && root.scheme === 'file') {
    const file = localPath(uri);
    const info = await lstat(file).catch(() => undefined);
    if (!info || info.isSymbolicLink() || !info.isFile()) return undefined;
    if (!(await realPathInside(file, localPath(root)))) return undefined;
  }
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open?.isDirty) {
    const text = open.getText();
    return Buffer.byteLength(text, 'utf8') > COVERAGE_WORK.htmlBytes ? 'tooLarge' : text;
  }
  const size = await vscode.workspace.fs.stat(uri).then(
    (st) => st.size,
    () => undefined,
  );
  if (size === undefined) return undefined;
  if (size > COVERAGE_WORK.htmlBytes) return 'tooLarge';
  const bytes = await readBytesInside(uri, root, COVERAGE_WORK.htmlBytes);
  return bytes ? decode(bytes) : undefined;
}

export type { GitRepo };

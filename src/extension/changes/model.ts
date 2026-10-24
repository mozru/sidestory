// The Changes view's model (docs/CHANGES-PLAN.md §9.2–§9.5): the merge diff's files as entries, the compact
// folder tree with counts, list sorting, the filter, the order Next/Previous Changed File walks, and the
// labels. Pure: no vscode import, so it is unit tested directly and stays cheap on 20,000 files.
import { globMatcher } from '../../core/glob.ts';

/** A, M, D, R as the Source Control view shows them; C only if the git API ever reports a copy. */
export type ChangeStatus = 'A' | 'M' | 'D' | 'R' | 'C';

export interface ChangeEntry {
  /** Repo-relative POSIX path on the head side (the old path for a deleted file). */
  readonly path: string;
  /** The path at the merge-base, for renames (and copies). */
  readonly oldPath?: string;
  readonly status: ChangeStatus;
  /** Lines added and removed, when known (numstat, or counted for untracked files). */
  added?: number;
  removed?: number;
  /** Not in git yet (working tree mode). */
  readonly untracked?: boolean;
  /** An open document of this file has unsaved edits (working tree mode). */
  unsaved?: boolean;
  /** Counted, but has no text lines changed: binary, a mode change or an empty file (numstat can't tell). */
  noText?: boolean;
}

/** The vscode.git API's `Status` enum (git.d.ts), as numbers: a `const enum` can't be imported at run time. */
export const GitStatus = {
  INDEX_MODIFIED: 0,
  INDEX_ADDED: 1,
  INDEX_DELETED: 2,
  INDEX_RENAMED: 3,
  INDEX_COPIED: 4,
  MODIFIED: 5,
  DELETED: 6,
  UNTRACKED: 7,
  IGNORED: 8,
  INTENT_TO_ADD: 9,
} as const;

/** The view's letter for a git API status, or undefined for one the view doesn't list (ignored). */
export function statusLetter(status: number): ChangeStatus | undefined {
  switch (status) {
    case GitStatus.INDEX_ADDED:
    case GitStatus.UNTRACKED:
    case GitStatus.INTENT_TO_ADD:
      return 'A';
    case GitStatus.INDEX_DELETED:
    case GitStatus.DELETED:
      return 'D';
    case GitStatus.INDEX_RENAMED:
      return 'R';
    case GitStatus.INDEX_COPIED:
      return 'C';
    case GitStatus.IGNORED:
      return undefined;
    default:
      return 'M'; // modified, and anything newer (type changes, conflicts) reads as a modification
  }
}

export const STATUS_NAMES: Record<ChangeStatus, string> = { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', C: 'Copied' };

/** At most this many changed files are listed (sorted by path), docs/CHANGES-PLAN.md §4.6. */
export const MAX_LISTED = 20_000;
/** Everything is expanded up to this many files; past it, only top-level folders. */
export const EXPAND_ALL_UP_TO = 200;

// ---- ordering ----

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
/** Path order: by name per segment, folders and files alike (the list's "by path"). */
export const comparePaths = (a: string, b: string): number => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
const compareNames = comparePaths;

export type SortKey = 'path' | 'status' | 'size';
export const SORT_KEYS: readonly SortKey[] = ['path', 'status', 'size'];
const STATUS_ORDER: Record<ChangeStatus, number> = { A: 0, M: 1, R: 2, C: 3, D: 4 };

/** Lines changed, or -1 when unknown (sorted last by size). */
export const sizeOf = (e: ChangeEntry): number => (e.added === undefined && e.removed === undefined ? -1 : (e.added ?? 0) + (e.removed ?? 0));

/** The list's order for a sort key; ties are broken by path, so the order is stable whatever the input order. */
export function sortEntries(entries: readonly ChangeEntry[], key: SortKey): ChangeEntry[] {
  const out = entries.slice();
  if (key === 'path') out.sort((a, b) => comparePaths(a.path, b.path));
  else if (key === 'status') out.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || comparePaths(a.path, b.path));
  else out.sort((a, b) => sizeOf(b) - sizeOf(a) || comparePaths(a.path, b.path));
  return out;
}

// ---- the folder tree ----

export interface FolderNode {
  readonly kind: 'folder';
  /** The folder's repo-relative path ('' for the root). */
  readonly path: string;
  /** What the row shows: the compact chain of single-child folders ("src/retry"). */
  readonly label: string;
  /** Depth in the compact tree: 0 for top-level rows. */
  readonly depth: number;
  readonly parent?: FolderNode;
  readonly folders: FolderNode[];
  readonly files: ChangeEntry[];
  /** Totals over every file below. */
  fileCount: number;
  added: number;
  removed: number;
  /** Files below whose counts aren't known. */
  uncounted: number;
}

interface Building {
  folders: Map<string, Building>;
  files: ChangeEntry[];
}

const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const dirname = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
export { basename as baseName, dirname as dirName };

/**
 * The compact tree of the entries' folders (as the Explorer's `explorer.compactFolders`): a folder holding exactly
 * one folder and no files is joined with it. Folders come before files; folders are sorted by name, files by
 * `sort` (by name for 'path'). O(n log n).
 */
export function buildTree(entries: readonly ChangeEntry[], sort: SortKey = 'path'): FolderNode {
  const root: Building = { folders: new Map(), files: [] };
  for (const e of entries) {
    const parts = e.path.split('/');
    let b = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let next = b.folders.get(parts[i]!);
      if (!next) b.folders.set(parts[i]!, (next = { folders: new Map(), files: [] }));
      b = next;
    }
    b.files.push(e);
  }
  const make = (b: Building, path: string, label: string, depth: number, parent: FolderNode | undefined): FolderNode => {
    // Join single-child chains: src → src/retry while `src` has one folder and no files.
    while (parent && b.files.length === 0 && b.folders.size === 1) {
      const [name, only] = b.folders.entries().next().value!;
      path = `${path}/${name}`;
      label = `${label}/${name}`;
      b = only;
    }
    const node: FolderNode = { kind: 'folder', path, label, depth, parent, folders: [], files: [], fileCount: 0, added: 0, removed: 0, uncounted: 0 };
    const names = [...b.folders.keys()].sort(compareNames);
    for (const name of names) {
      const child = make(b.folders.get(name)!, path ? `${path}/${name}` : name, name, parent ? depth + 1 : 0, node);
      node.folders.push(child);
      node.fileCount += child.fileCount;
      node.added += child.added;
      node.removed += child.removed;
      node.uncounted += child.uncounted;
    }
    const files = sort === 'path' ? b.files.slice().sort((x, y) => compareNames(basename(x.path), basename(y.path))) : sortEntries(b.files, sort);
    for (const f of files) {
      node.files.push(f);
      node.fileCount++;
      if (sizeOf(f) < 0) node.uncounted++;
      node.added += f.added ?? 0;
      node.removed += f.removed ?? 0;
    }
    return node;
  };
  return make(root, '', '', -1, undefined);
}

/** The files in tree order (depth first, folders before files): what Next Changed File walks in tree mode. */
export function treeOrder(root: FolderNode): ChangeEntry[] {
  const out: ChangeEntry[] = [];
  const walk = (n: FolderNode) => {
    for (const f of n.folders) walk(f);
    for (const e of n.files) out.push(e);
  };
  walk(root);
  return out;
}

// ---- the filter ----

export interface Filter {
  readonly text: string;
  matches(path: string): boolean;
}

/**
 * The filter (§9.5): space-separated terms, each matched case-insensitively against the repo-relative path. A term
 * with `*` or `?` is a glob (`src/**\/*.ts`; one without `/` matches at any depth, so `*.ts` works), any other is
 * a substring. A leading `!` excludes. Every positive term must match; any negative one excludes.
 */
export function parseFilter(text: string): Filter | undefined {
  const terms = text.trim().slice(0, 200).split(/\s+/).filter(Boolean);
  if (!terms.length) return undefined;
  const include: ((p: string) => boolean)[] = [];
  const exclude: ((p: string) => boolean)[] = [];
  for (const raw of terms) {
    const neg = raw.startsWith('!');
    const t = (neg ? raw.slice(1) : raw).toLowerCase();
    if (!t) continue;
    let test: (p: string) => boolean;
    if (/[*?]/.test(t)) {
      const m = globMatcher([t.includes('/') ? t.replace(/^\//, '') : `**/${t}`]);
      test = (p) => m(p);
    } else test = (p) => p.includes(t);
    (neg ? exclude : include).push(test);
  }
  if (!include.length && !exclude.length) return undefined;
  return {
    text: text.trim().slice(0, 200),
    matches: (path) => {
      const p = path.toLowerCase();
      return include.every((t) => t(p)) && !exclude.some((t) => t(p));
    },
  };
}

/** Entries the filter keeps; a rename also matches on its old path. */
export function filterEntries(entries: readonly ChangeEntry[], filter: Filter | undefined): ChangeEntry[] {
  if (!filter) return entries.slice();
  return entries.filter((e) => filter.matches(e.path) || (e.oldPath !== undefined && filter.matches(e.oldPath)));
}

// ---- next / previous ----

/** The index to open next from `from` (-1: none yet), wrapping; `wrapped` says it went round. */
export function step(length: number, from: number, dir: 1 | -1): { index: number; wrapped: boolean } | undefined {
  if (!length) return undefined;
  if (from < 0 || from >= length) return { index: dir === 1 ? 0 : length - 1, wrapped: false };
  const next = from + dir;
  if (next >= length) return { index: 0, wrapped: true };
  if (next < 0) return { index: length - 1, wrapped: true };
  return { index: next, wrapped: false };
}

// ---- labels ----

const n = (x: number) => x.toLocaleString('en-US');

/** "+23 −11", "+19", "−24", "" (unknown), "no text changes". */
export function countsLabel(e: { added?: number; removed?: number; noText?: boolean }): string {
  if (e.noText) return 'no line changes';
  if (e.added === undefined && e.removed === undefined) return '';
  const parts: string[] = [];
  if (e.added) parts.push(`+${n(e.added)}`);
  if (e.removed) parts.push(`−${n(e.removed)}`);
  return parts.join(' ') || '+0 −0';
}

/** A folder's description: "3 files · +42 −17", or "3 files" while counts are missing. */
export function folderLabel(f: FolderNode): string {
  const files = `${n(f.fileCount)} ${f.fileCount === 1 ? 'file' : 'files'}`;
  if (f.uncounted === f.fileCount) return files;
  const counts = countsLabel({ added: f.added, removed: f.removed });
  return counts ? `${files} · ${counts}` : files;
}

/** "4 commits", "1 commit", "1000+ commits". */
export function commitsLabel(count: number, capped: boolean): string {
  if (capped) return `${n(count)}+ commits`;
  return `${n(count)} ${count === 1 ? 'commit' : 'commits'}`;
}

/** The first 7 characters of a commit id. */
export const short = (sha: string) => sha.slice(0, 7);

// The comparison's model (docs/CHANGES-PLAN.md §4): the merge diff's files as entries, their status letters, path
// order (what Next/Previous Changed File walks) and stepping through it. Pure: no vscode import, so it is unit tested
// directly and stays cheap on 20,000 files. Browsing the branch is left to Git Tree Compare, GitLens and Source
// Control; the extension keeps the comparison for steps, coverage and its decorations.

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
  /** Queued for counting. */
  counting?: boolean;
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

/** At most this many changed files are listed (sorted by path), docs/CHANGES-PLAN.md §4.6. */
export const MAX_LISTED = 20_000;

// ---- ordering ----

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
/** Path order: by name per segment, folders and files alike. */
export const comparePaths = (a: string, b: string): number => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);
export { basename as baseName };

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

/** The first 7 characters of a commit id. */
export const short = (sha: string) => sha.slice(0, 7);

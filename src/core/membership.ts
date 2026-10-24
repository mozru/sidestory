// Which sidestories count toward a comparison's coverage (docs/CHANGES-PLAN.md §6.1). Pure: the extension and the
// checker look the facts up their own way (the git API, hardened git) and apply this same test.
import { explainerNameSchema } from './manifest.ts';

/**
 * Does a sidestory belong to a comparison (merge-base M → head)?
 *
 * 1. Its manifest is absent at M and present at the head: it was added in the change. A sidestory that already
 *    landed exists at every later merge-base, so it never belongs to a later branch, whatever that branch does to it.
 * 2. Its own `base` resolves (against the comparison's head) to the same merge-base M.
 *
 * A `head`-pinned sidestory never belongs to a live comparison, with one exception (the review rule): when the
 * comparison's head is a fixed commit (review mode, `--head <sha>`), a sidestory whose base gives M and whose
 * `head` is that commit belongs too (it lives untracked in the reader's working tree, so presence isn't asked).
 */
export function belongs(i: {
  presentAtMergeBase: boolean;
  presentAtHead: boolean;
  ownMergeBase: string | undefined;
  comparisonMergeBase: string;
  manifestHead?: string;
  /** The fixed head commit (review mode, `--head`); undefined for the working tree or a branch's moving tip. */
  comparisonHead?: string;
}): boolean {
  if (i.ownMergeBase === undefined || i.ownMergeBase !== i.comparisonMergeBase) return false;
  // A review sidestory is read from the reader's working tree (untracked), never from the commit it describes.
  if (i.manifestHead !== undefined) return i.comparisonHead !== undefined && i.manifestHead === i.comparisonHead;
  return !i.presentAtMergeBase && i.presentAtHead;
}

/** Under a `.sidestory/archive/` folder (at any package root): archives are never members (§12.3). */
export function isArchivePath(p: string): boolean {
  return p.startsWith('.sidestory/archive/') || p.includes('/.sidestory/archive/') || p === '.sidestory/archive' || p.endsWith('/.sidestory/archive');
}

const SIDESTORY_PATH = /^(?:(.*)\/)?\.sidestory\/([^/]+)\/.+$/;

/**
 * The repo-relative folder of the sidestory a path lies in (`.sidestory/x`, `pkg/.sidestory/x`), or undefined when
 * it isn't inside a real sidestory folder: `<prefix>/.sidestory/<name>/…` where `<name>` is a valid sidestory name
 * and not `archive`. A file directly in `.sidestory/` (a README) or under a folder with an invalid name is ordinary
 * code. The checker and the extension both use this, so they agree on which files a branch's totals leave out.
 */
export function sidestoryFolderOf(path: string): string | undefined {
  const m = SIDESTORY_PATH.exec(path);
  if (!m || m[2] === 'archive' || !explainerNameSchema.safeParse(m[2]).success) return undefined;
  return m[1] ? `${m[1]}/.sidestory/${m[2]}` : `.sidestory/${m[2]}`;
}

/**
 * Does a changed file count toward a branch's coverage (§6.3)? Every file does except the sidestories' own files
 * (`sidestoryFolderOf`) and archives (`isArchivePath`): the explanation isn't something to explain.
 */
export function countedPath(path: string): boolean {
  return sidestoryFolderOf(path) === undefined && !isArchivePath(path);
}

/** The files a sidestory folder must hold to be one (relative to the folder). */
export const SIDESTORY_FILES = ['manifest.json', 'sidestory.html'] as const;

/**
 * A sidestory belongs to a comparison only when it is complete: its folder holds both `manifest.json` and
 * `sidestory.html` (at the head, or on disk for the working tree). A folder with only a manifest (an agent still
 * writing the page) counts nothing yet, in the checker and in the extension alike. `files` are the folder's file
 * names, relative to the folder.
 */
export function isCompleteSidestory(files: Iterable<string>): boolean {
  const have = new Set(files);
  return SIDESTORY_FILES.every((f) => have.has(f));
}

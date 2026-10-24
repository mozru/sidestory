// Which sidestories count toward a comparison's coverage (docs/CHANGES-PLAN.md §6.1). Pure: the extension and the
// checker look the facts up their own way (the git API, hardened git) and apply this same test.

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

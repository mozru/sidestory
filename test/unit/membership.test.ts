// Which sidestories count toward a comparison (src/core/membership.ts, docs/CHANGES-PLAN.md §6.1).
import { describe, expect, it } from 'vitest';
import { belongs, isArchivePath } from '../../src/core/membership.ts';

const M = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const HEAD = 'c'.repeat(40);

describe('belongs', () => {
  it('a sidestory added on the branch (committed, uncommitted or untracked) belongs', () => {
    expect(belongs({ presentAtMergeBase: false, presentAtHead: true, ownMergeBase: M, comparisonMergeBase: M })).toBe(true);
  });
  it('a landed sidestory (present at the merge-base) never counts for a later branch, even when edited there', () => {
    expect(belongs({ presentAtMergeBase: true, presentAtHead: true, ownMergeBase: M, comparisonMergeBase: M })).toBe(false);
  });
  it('a new sidestory on a branch whose HEAD still equals main belongs (absent at the merge-base)', () => {
    expect(belongs({ presentAtMergeBase: false, presentAtHead: true, ownMergeBase: M, comparisonMergeBase: M, comparisonHead: undefined })).toBe(true);
  });
  it('a sidestory deleted on the branch, or with another base, does not belong', () => {
    expect(belongs({ presentAtMergeBase: false, presentAtHead: false, ownMergeBase: M, comparisonMergeBase: M })).toBe(false);
    expect(belongs({ presentAtMergeBase: false, presentAtHead: true, ownMergeBase: OTHER, comparisonMergeBase: M })).toBe(false);
    expect(belongs({ presentAtMergeBase: false, presentAtHead: true, ownMergeBase: undefined, comparisonMergeBase: M })).toBe(false);
  });
  it('head-pinned sidestories: never in a live comparison; the review rule with a fixed head', () => {
    expect(belongs({ presentAtMergeBase: false, presentAtHead: true, ownMergeBase: M, comparisonMergeBase: M, manifestHead: HEAD })).toBe(false);
    expect(belongs({ presentAtMergeBase: false, presentAtHead: false, ownMergeBase: M, comparisonMergeBase: M, manifestHead: HEAD, comparisonHead: HEAD })).toBe(true);
    expect(belongs({ presentAtMergeBase: false, presentAtHead: true, ownMergeBase: M, comparisonMergeBase: M, manifestHead: HEAD, comparisonHead: OTHER })).toBe(false);
    expect(belongs({ presentAtMergeBase: false, presentAtHead: true, ownMergeBase: OTHER, comparisonMergeBase: M, manifestHead: HEAD, comparisonHead: HEAD })).toBe(false);
  });
});

describe('isArchivePath', () => {
  it('archive folders at any package root, nothing else', () => {
    expect(isArchivePath('.sidestory/archive/2026-10-30-x/manifest.json')).toBe(true);
    expect(isArchivePath('services/auth/.sidestory/archive/x/sidestory.html')).toBe(true);
    expect(isArchivePath('.sidestory/archived/manifest.json')).toBe(false);
    expect(isArchivePath('src/archive/x.ts')).toBe(false);
    expect(isArchivePath('.sidestory/x/archive/y')).toBe(false);
  });
});

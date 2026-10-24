// Unstaged renames (docs/CHANGES-PLAN.md §4.6): in working tree mode git lists a file moved without `git mv` as a
// deleted tracked file and an untracked new one. Both tools pair them by content with this one function, so a moved
// file counts as a rename (its unchanged lines need no explanation) in the checker and in the extension alike.
// Pure: no vscode or node import.
import { decodeLatin1, decodeUtf8, textLines } from './hunks.ts';
import { contentSimilarity } from './similarity.ts';
import { normalizeLines } from './text.ts';

export const RENAME_PAIRING = {
  /** No pairing at all when either side has more candidates than this. */
  maxEach: 50,
  /** Larger files are never paired. */
  maxBytes: 1024 * 1024,
  minScore: 0.5,
} as const;

/**
 * Pairs deleted tracked files with untracked new ones by content: at most 50 × 50 candidates (none when either list
 * is longer), each at most 1 MB, similarity ≥ 0.5, best pairs first (ties by new path, then old path). Callers pass
 * only text files (not binary, not LFS pointers, readable, within the size cap): the checker's `kind === 'text'`.
 * Each file is in at most one pair.
 */
export function pairUnstagedRenames<D extends { readonly path: string }, A extends { readonly path: string }>(
  deleted: readonly D[],
  added: readonly A[],
  oldBytes: (d: D) => Uint8Array | undefined,
  newBytes: (a: A) => Uint8Array | undefined,
): { deleted: D; added: A }[] {
  const out: { deleted: D; added: A }[] = [];
  if (!deleted.length || !added.length || deleted.length > RENAME_PAIRING.maxEach || added.length > RENAME_PAIRING.maxEach) return out;
  const lines = (b: Uint8Array | undefined) => (b && b.length <= RENAME_PAIRING.maxBytes ? normalizeLines(textLines(decodeUtf8(b) ?? decodeLatin1(b))) : undefined);
  const addedLines = added.map((a) => lines(newBytes(a)));
  const pairs: { d: D; a: A; score: number }[] = [];
  for (const d of deleted) {
    const dl = lines(oldBytes(d));
    if (!dl?.length) continue;
    added.forEach((a, i) => {
      const al = addedLines[i];
      if (!al?.length) return;
      const score = contentSimilarity(dl, al);
      if (score >= RENAME_PAIRING.minScore) pairs.push({ d, a, score });
    });
  }
  pairs.sort((x, y) => y.score - x.score || (x.a.path < y.a.path ? -1 : x.a.path > y.a.path ? 1 : x.d.path < y.d.path ? -1 : x.d.path > y.d.path ? 1 : 0));
  const used = new Set<D | A>();
  for (const p of pairs) {
    if (used.has(p.d) || used.has(p.a)) continue;
    used.add(p.d).add(p.a);
    out.push({ deleted: p.d, added: p.a });
  }
  return out;
}

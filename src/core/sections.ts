import type { Resolution } from './resolve.ts';

/**
 * The anchor the given line belongs to, for cursor → section sync.
 * Ignores lost anchors, prefers trustworthy states over stale ones, then the tightest range.
 */
export function anchorAtLine(resolved: ReadonlyMap<string, Resolution>, line: number): string | undefined {
  let best: { id: string; stale: boolean; size: number } | undefined;
  for (const [id, r] of resolved) {
    if (!r.range || line < r.range.start || line > r.range.end) continue;
    const cand = { id, stale: r.state === 'stale', size: r.range.end - r.range.start };
    if (!best || (best.stale && !cand.stale) || (best.stale === cand.stale && cand.size < best.size)) best = cand;
  }
  return best?.id;
}

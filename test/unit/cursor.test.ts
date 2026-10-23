// The shared cursor helper (src/extension/cursor.ts): one rule for which anchor the cursor is in.
import { describe, expect, it } from 'vitest';
import type { AnchorState, Resolution } from '../../src/core/resolve.ts';
import { anchorAtLine } from '../../src/core/sections.ts';
import { anchorForCursor, coveringAnchors } from '../../src/extension/cursor.ts';

const r = (start: number, end: number, state: AnchorState = 'exact'): Resolution => ({ state, range: { start, end }, location: 1, similarity: 1, ambiguous: false, method: 'exact' });
const lost: Resolution = { state: 'lost', range: null, location: 0, similarity: 0, ambiguous: false, method: 'none' };

describe('coveringAnchors', () => {
  const all = new Map<string, Resolution>([
    ['wide', r(1, 100)],
    ['mid', r(10, 30)],
    ['tight', r(15, 20)],
    ['staleTight', r(16, 17, 'stale')],
    ['gone', lost],
    ['elsewhere', r(50, 60)],
    ['sameSizeLater', r(18, 23)],
  ]);
  it('lists every anchor containing the line: trustworthy first, then tightest, then earliest, then id', () => {
    expect(coveringAnchors(all, 16).map((c) => c.id)).toEqual(['tight', 'mid', 'wide', 'staleTight']);
    expect(coveringAnchors(all, 19).map((c) => c.id)).toEqual(['tight', 'sameSizeLater', 'mid', 'wide']);
  });
  it('keeps only sections when told which they are', () => {
    expect(coveringAnchors(all, 16, { sections: new Set(['wide', 'mid']) }).map((c) => c.id)).toEqual(['mid', 'wide']);
  });
  it('can leave stale anchors out', () => {
    expect(coveringAnchors(all, 16, { includeStale: false }).map((c) => c.id)).not.toContain('staleTight');
  });
  it('never counts lost anchors, and lines outside every range give nothing', () => {
    expect(coveringAnchors(all, 200)).toEqual([]);
    expect(coveringAnchors(new Map([['gone', lost]]), 1)).toEqual([]);
  });
});

describe('anchorForCursor', () => {
  it('picks the first of coveringAnchors (the same tie-break), and agrees with anchorAtLine unless only the tie-break differs', () => {
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const states: AnchorState[] = ['exact', 'moved', 'changed', 'stale', 'lost'];
    for (let t = 0; t < 500; t++) {
      const m = new Map<string, Resolution>();
      for (let i = 0; i < 1 + rand(12); i++) {
        const s = states[rand(states.length)]!;
        const start = 1 + rand(50);
        m.set(`a${i}`, s === 'lost' ? lost : r(start, start + rand(20), s));
      }
      const line = 1 + rand(70);
      const got = anchorForCursor(m, line);
      expect(got).toBe(coveringAnchors(m, line)[0]?.id);
      // anchorAtLine keeps the first of equal ranges; the shared helper breaks ties by start, then id.
      const old = anchorAtLine(m, line);
      if (got !== old) {
        const size = (id: string) => m.get(id)!.range!.end - m.get(id)!.range!.start;
        expect(size(got!)).toBe(size(old!));
        expect(m.get(got!)!.state === 'stale').toBe(m.get(old!)!.state === 'stale');
      }
    }
  });
  it('honours sections', () => {
    const m = new Map([['ref', r(5, 6)], ['sec', r(1, 10)]]);
    expect(anchorForCursor(m, 5)).toBe('ref');
    expect(anchorForCursor(m, 5, { sections: new Set(['sec']) })).toBe('sec');
  });
});

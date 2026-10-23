// The shared PreparedText cache (docs/NAVIGATION-PLAN.md §7.2): two entries, 5 s, never over 1 MB.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PREPARED_CACHE, PreparedTextCache } from '../../src/extension/prepared-cache.ts';

afterEach(() => {
  vi.useRealTimers();
});

describe('PreparedTextCache', () => {
  it('reuses one text per (document, version) and makes a new one per version', () => {
    const c = new PreparedTextCache();
    let made = 0;
    const src = () => {
      made++;
      return 'a\nb\n';
    };
    const t1 = c.get('k', 1, src);
    expect(c.get('k', 1, src)).toBe(t1);
    expect(made).toBe(1);
    expect(c.get('k', 2, src)).not.toBe(t1);
    expect(made).toBe(2);
    expect(c.size).toBe(1);
    c.dispose();
  });

  it('holds at most two entries, dropping the least recently used', () => {
    const c = new PreparedTextCache();
    const a = c.get('a', 1, () => 'a');
    c.get('b', 1, () => 'b');
    c.get('a', 1, () => 'a'); // a is now the most recent
    c.get('c', 1, () => 'c');
    expect(c.size).toBe(PREPARED_CACHE.entries);
    expect(c.get('a', 1, () => 'other')).toBe(a);
    c.dispose();
  });

  it('drops an entry 5 s after its last use', () => {
    vi.useFakeTimers();
    const c = new PreparedTextCache();
    c.get('a', 1, () => 'a');
    vi.advanceTimersByTime(4000);
    c.get('a', 1, () => 'a'); // used again: the clock restarts
    vi.advanceTimersByTime(4000);
    expect(c.size).toBe(1);
    vi.advanceTimersByTime(1001);
    expect(c.size).toBe(0);
    c.dispose();
  });

  it('never keeps documents over 1 MB', () => {
    const c = new PreparedTextCache();
    const big = 'x'.repeat(PREPARED_CACHE.maxChars + 1);
    let made = 0;
    c.get('big', 1, () => (made++, big));
    c.get('big', 1, () => (made++, big));
    expect(made).toBe(2);
    expect(c.size).toBe(0);
    c.dispose();
  });

  it('dispose clears every timer', () => {
    vi.useFakeTimers();
    const c = new PreparedTextCache();
    c.get('a', 1, () => 'a');
    c.get('b', 1, () => 'b');
    c.dispose();
    expect(c.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

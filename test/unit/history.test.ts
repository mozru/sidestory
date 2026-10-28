// The panel's Back / Forward history (src/webview/history.ts): entries, coalesced stepping, truncation, the cap,
// and what survives saved state.
import { describe, expect, it } from 'vitest';
import { type HistoryEntry, MAX_HISTORY, NavHistory, samePage } from '../../src/webview/history.ts';

const A = { dir: 'file:///ws/.sidestory/a', trail: ['a'], title: 'A' };
const X = { dir: 'file:///ws/.sidestory/x', trail: ['a', 'x'], title: 'X' };
const at = (page: typeof A, active: string, step?: number): HistoryEntry => ({ ...page, active, ...(step ? { step } : {}) });
const actives = (h: NavHistory) => h.toJSON().entries.map((e) => `${e.trail.at(-1)}:${e.active}`);

describe('NavHistory', () => {
  it('a jump adds an entry; going back and forward moves between them; a new jump drops what was ahead', () => {
    const h = new NavHistory();
    h.push(at(A, 'one'));
    h.push(at(A, 'three'));
    h.push(at(X, 'loop'));
    expect(actives(h)).toEqual(['a:one', 'a:three', 'x:loop']);
    expect(h.go(h.position - 1)?.active).toBe('three');
    expect(h.go(h.position - 1)?.active).toBe('one');
    expect(h.go(h.position + 1)?.active).toBe('three');
    h.push(at(A, 'two'));
    expect(actives(h)).toEqual(['a:one', 'a:three', 'a:two']);
    expect(h.at(h.position + 1)).toBeUndefined();
  });

  it('a jump to where the reader already is only updates the entry', () => {
    const h = new NavHistory();
    h.push(at(A, 'one'));
    h.push({ ...at(A, 'one'), scroll: { anchor: 'one', offset: 12 } });
    expect(h.length).toBe(1);
    expect(h.current?.scroll).toEqual({ anchor: 'one', offset: 12 });
  });

  it('a run of steps is one entry; stepping back to where it started undoes it', () => {
    const h = new NavHistory();
    h.push(at(A, 'one'));
    h.step(at(A, 'two'));
    h.step(at(A, 'three'));
    h.step(at(A, 'four'));
    expect(actives(h)).toEqual(['a:one', 'a:four']);
    // A jump ends the run: the next step starts another entry.
    h.push(at(A, 'two'));
    h.step(at(A, 'three'));
    expect(actives(h)).toEqual(['a:one', 'a:four', 'a:two', 'a:three']);
    h.step(at(A, 'two'));
    expect(actives(h)).toEqual(['a:one', 'a:four', 'a:two']);
    // Back ends a run too.
    h.step(at(A, 'three'));
    h.go(h.position - 1);
    h.step(at(A, 'three'));
    expect(actives(h)).toEqual(['a:one', 'a:four', 'a:two', 'a:three']);
  });

  it('updates only touch the current entry, and only for the page it shows', () => {
    const h = new NavHistory();
    h.push(at(A, 'one'));
    h.update({ ...X, active: 'loop' });
    expect(h.current?.active).toBe('one');
    h.update({ ...A, active: 'two', step: 2, scroll: { anchor: 'two', offset: -3 } });
    expect(h.current).toMatchObject({ active: 'two', step: 2, scroll: { anchor: 'two', offset: -3 } });
  });

  it('an update leaves what it doesn’t know as it was', () => {
    const h = new NavHistory();
    h.push({ ...at(A, 'one', 1), scroll: { anchor: 'one', offset: 5 } });
    h.update({ ...A, active: 'two', step: undefined, scroll: undefined });
    expect(h.current).toMatchObject({ active: 'two', step: 1, scroll: { anchor: 'one', offset: 5 } });
  });

  it('drops a page that is gone, never the current entry, keeping the place', () => {
    const h = new NavHistory();
    h.push(at(A, 'one'));
    h.push(at(X, 'loop'));
    h.push(at(A, 'two'));
    h.push(at(X, 'b'));
    h.push(at(A, 'three'));
    h.go(3);
    expect(h.drop(A)).toBe('A');
    expect(actives(h)).toEqual(['x:loop', 'x:b']);
    expect(h.current?.active).toBe('b');
    expect(h.drop(X)).toBe('X'); // the current entry stays
    expect(actives(h)).toEqual(['x:b']);
    expect(h.drop({ dir: '', trail: [] })).toBeUndefined();
  });

  it('keeps the newest entries past the cap', () => {
    const h = new NavHistory(undefined, 5);
    for (let i = 0; i < 12; i++) h.push(at(A, `s${i}`));
    expect(h.length).toBe(5);
    expect(h.current?.active).toBe('s11');
    expect(h.at(0)?.active).toBe('s7');
    expect(MAX_HISTORY).toBe(100);
  });

  it('round-trips through saved state; anything malformed starts empty', () => {
    const h = new NavHistory();
    h.push(at(A, 'one', 1));
    h.push({ ...at(X, 'loop', 2), scroll: { anchor: 'loop', offset: 40 } });
    h.go(0);
    const back = new NavHistory(JSON.parse(JSON.stringify(h.toJSON())));
    expect(back.toJSON()).toEqual(h.toJSON());
    expect(back.position).toBe(0);
    for (const bad of [null, 'x', { entries: 'x', index: 0 }, { entries: [A], index: 3 }, { entries: [{ dir: 1, trail: ['a'] }], index: 0 }, { entries: [{ ...A, trail: [] }], index: 0 }]) {
      expect(new NavHistory(bad).length).toBe(0);
    }
    // Junk fields are dropped, not kept.
    const kept = new NavHistory({ entries: [{ ...A, active: 7, scroll: { anchor: 'a', offset: 'x' }, extra: 1 }], index: 0 });
    expect(kept.current).toEqual({ dir: A.dir, trail: ['a'], title: 'A' });
  });

  it('pages are the same when the folder and the way there match', () => {
    expect(samePage(A, { dir: A.dir, trail: ['a'] })).toBe(true);
    expect(samePage(X, { dir: X.dir, trail: ['b', 'x'] })).toBe(false);
  });
});

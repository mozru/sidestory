// The panel's back/forward history, as a browser keeps one: an entry per place the reader went to (another sidestory,
// a dive, a step chosen from the tabs or picker), each with the step and scroll position to come back to. Stepping
// (J/K, < >) doesn't add an entry per step: a run of steps is one entry.

export interface Spot {
  anchor: string;
  offset: number;
}

export interface HistoryEntry {
  /** The sidestory's folder URI. */
  dir: string;
  /** The trail's names, root first (the last is the sidestory shown). */
  trail: string[];
  title: string;
  active?: string;
  /** 1-based step number of `active`, for the buttons' tooltips. */
  step?: number;
  scroll?: Spot;
}

export interface SavedHistory {
  entries: HistoryEntry[];
  index: number;
}

export const MAX_HISTORY = 100;
const MAX_TEXT = 4096;

/** Whether two entries show the same sidestory, reached the same way. */
export const samePage = (a: Pick<HistoryEntry, 'dir' | 'trail'>, b: Pick<HistoryEntry, 'dir' | 'trail'>) =>
  a.dir === b.dir && a.trail.length === b.trail.length && a.trail.every((n, i) => n === b.trail[i]);

const str = (v: unknown, max = MAX_TEXT): v is string => typeof v === 'string' && v.length <= max;

/** An entry from saved state, or undefined if it isn't one. */
function entryOf(v: unknown): HistoryEntry | undefined {
  const e = v as Partial<HistoryEntry> | null;
  if (!e || typeof e !== 'object' || !str(e.dir) || !Array.isArray(e.trail) || e.trail.length === 0 || e.trail.length > 16 || !e.trail.every((n) => str(n, 64))) return undefined;
  const out: HistoryEntry = { dir: e.dir, trail: [...e.trail], title: str(e.title) ? e.title : '' };
  if (str(e.active, 256)) out.active = e.active;
  if (typeof e.step === 'number' && Number.isInteger(e.step) && e.step > 0) out.step = e.step;
  if (e.scroll && str(e.scroll.anchor, 256) && Number.isFinite(e.scroll.offset)) out.scroll = { anchor: e.scroll.anchor, offset: e.scroll.offset };
  return out;
}

export class NavHistory {
  private entries: HistoryEntry[] = [];
  private index = -1;
  /** In a run of steps: the next step moves this entry instead of adding one. */
  private stepping = false;
  private readonly max: number;

  constructor(saved?: unknown, max = MAX_HISTORY) {
    this.max = max;
    const s = saved as Partial<SavedHistory> | undefined;
    if (!s || !Array.isArray(s.entries)) return;
    const entries = s.entries.map(entryOf);
    if (entries.some((e) => !e) || typeof s.index !== 'number' || !Number.isInteger(s.index) || s.index < 0 || s.index >= entries.length) return;
    this.entries = (entries as HistoryEntry[]).slice(-max);
    this.index = s.index - (entries.length - this.entries.length);
    if (this.index < 0) this.index = 0;
  }

  get current(): HistoryEntry | undefined {
    return this.entries[this.index];
  }

  get position(): number {
    return this.index;
  }

  get length(): number {
    return this.entries.length;
  }

  /** Entry `index`, if there is one. */
  at(index: number): HistoryEntry | undefined {
    return index >= 0 ? this.entries[index] : undefined;
  }

  /** The reader's place on the current page changed (scrolling, the editor's cursor, a live edit). */
  update(e: Pick<HistoryEntry, 'dir' | 'trail'> & Partial<HistoryEntry>): void {
    const cur = this.current;
    if (!cur || !samePage(cur, e)) return;
    // What isn't known now (no steps rendered yet, say) keeps what was.
    const known = Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined));
    this.entries[this.index] = { ...cur, ...known, trail: [...e.trail] };
  }

  /** Forgets the entries for a page that can't be shown any more (not the current one); the title of one, if any. */
  drop(page: Pick<HistoryEntry, 'dir' | 'trail'>): string | undefined {
    let title: string | undefined;
    const cur = this.current;
    this.entries = this.entries.filter((e, i) => {
      if (i === this.index || !samePage(e, page)) return true;
      title ??= e.title || e.trail.at(-1)!;
      return false;
    });
    // Neighbours that became the same place (A, gone, A): one is enough; the current one stays.
    const same = (a: HistoryEntry | undefined, b: HistoryEntry) => !!a && samePage(a, b) && a.active === b.active;
    const kept: HistoryEntry[] = [];
    for (const e of this.entries) {
      const last = kept.at(-1);
      if (!last || !same(last, e)) kept.push(e);
      else if (e === cur) kept[kept.length - 1] = e;
    }
    this.entries = kept;
    this.index = cur ? this.entries.indexOf(cur) : -1;
    this.stepping = false;
    return title;
  }

  /** A new place: another sidestory, or a jump within this one. Forward history goes, as in a browser. */
  push(e: HistoryEntry): void {
    this.stepping = false;
    const cur = this.current;
    if (cur && samePage(cur, e) && cur.active === e.active) {
      this.update(e);
      return;
    }
    this.entries.splice(this.index + 1, Infinity, { ...e, trail: [...e.trail] });
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
    this.index = this.entries.length - 1;
  }

  /** A step forward or back: the first of a run is a new entry, the rest move it. */
  step(e: HistoryEntry): void {
    const cur = this.current;
    if (this.stepping && cur && samePage(cur, e)) {
      this.update(e);
      // Stepped back to where the run started: the run is undone, not an entry of its own.
      const prev = this.entries[this.index - 1];
      if (prev && samePage(prev, e) && prev.active === e.active) {
        this.entries.splice(this.index, 1);
        this.index--;
        this.stepping = false;
      }
      return;
    }
    this.push(e);
    this.stepping = true;
  }

  /** Makes entry `index` current (Back, Forward). */
  go(index: number): HistoryEntry | undefined {
    const e = this.entries[index];
    if (!e) return undefined;
    this.index = index;
    this.stepping = false;
    return e;
  }

  toJSON(): SavedHistory {
    return { entries: this.entries.map((e) => ({ ...e, trail: [...e.trail] })), index: this.index };
  }
}

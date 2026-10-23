// The shared cursor helper: which anchor the editor cursor is "in". Every cursor-driven change goes through here,
// so the rules can't drift apart between features (docs/NAVIGATION-PLAN.md §7.3, docs/AUTHORING-PLAN.md §10.1 4):
//   - the panel's cursor-follow (session.ts `onSelection` → `syncTo`),
//   - the Explained-here status bar and "Show Sidestories for This Code" (nav/explained-here.ts),
//   - and, next, the authoring plan's code-to-box lighting (`here`), which builds on `coveringAnchors`.
//
// API
//   coveringAnchors(resolved, line, opts?) → CursorCandidate[]
//       Every anchor whose current range contains `line` (1-based), best first: trustworthy states before
//       stale ones, then the tightest range, then the earliest start, then id. Lost anchors (no range) never
//       count. `opts.sections`, when given, keeps only those ids: the rule "only sections count for cursor-
//       follow" (anchors used only by `data-explain-ref` don't steal the step). Leave it undefined until the
//       caller knows the sections (first render, hidden panel): then every anchor counts, as before.
//       `opts.includeStale: false` drops stale anchors entirely (the status bar's "not stale").
//   anchorForCursor(resolved, line, opts?) → string | undefined
//       The first of `coveringAnchors`: the anchor cursor-follow moves to.
//
// `resolved` is any iterable of [anchorId, {range, state}] — a session's resolutions, or the index's results for
// one document. Both functions are pure and allocation-light: one pass, O(n) in the anchors of the file.
import type { LineRange } from '../core/manifest.ts';
import type { AnchorState } from '../core/resolve.ts';

export interface CursorCandidate {
  id: string;
  range: LineRange;
  stale: boolean;
}

export interface CursorOptions {
  /** Only these ids count (sections); undefined: every anchor counts. */
  sections?: ReadonlySet<string>;
  /** Stale anchors count, after the trustworthy ones (default true). */
  includeStale?: boolean;
}

type Resolved = Iterable<readonly [string, { range: LineRange | null; state: AnchorState | 'pending' }]>;

export function coveringAnchors(resolved: Resolved, line: number, opts: CursorOptions = {}): CursorCandidate[] {
  const out: CursorCandidate[] = [];
  for (const [id, r] of resolved) {
    if (!r.range || line < r.range.start || line > r.range.end) continue;
    if (opts.sections && !opts.sections.has(id)) continue;
    const stale = r.state === 'stale';
    if (stale && opts.includeStale === false) continue;
    out.push({ id, range: r.range, stale });
  }
  return out.sort(
    (a, b) =>
      Number(a.stale) - Number(b.stale) ||
      a.range.end - a.range.start - (b.range.end - b.range.start) ||
      a.range.start - b.range.start ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

export function anchorForCursor(resolved: Resolved, line: number, opts: CursorOptions = {}): string | undefined {
  let best: CursorCandidate | undefined;
  for (const [id, r] of resolved) {
    if (!r.range || line < r.range.start || line > r.range.end) continue;
    if (opts.sections && !opts.sections.has(id)) continue;
    const stale = r.state === 'stale';
    if (stale && opts.includeStale === false) continue;
    const size = r.range.end - r.range.start;
    if (
      !best ||
      (best.stale && !stale) ||
      (best.stale === stale && size < best.range.end - best.range.start)
    ) {
      best = { id, range: r.range, stale };
    }
  }
  return best?.id;
}

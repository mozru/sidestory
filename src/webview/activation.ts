// Was it the reader's interaction with this widget? (docs/WIDGETS-PLAN.md §5.3.) With site isolation the
// panel sees no input inside a widget, so it refuses only on evidence it has: during the current activation
// window, a gesture of its own (pointerdown, touch or keydown in the panel or the content frame) that wasn't
// followed by pointer travel toward the widget. No gesture of its own means the activating gesture happened
// in a frame the panel can't see, which is then accepted. One more case is accepted: the pointer already
// rested on the widget when the gesture happened (a key pressed in the panel, then a click on the widget
// under the pointer), provided it was on that widget, or heading into it from just outside (with site
// isolation the panel's last sample is the last move before the frame), when the panel last saw it, not
// only after the widget moved or grew under it. Pure geometry and bookkeeping, unit tested.

export interface Point {
  x: number;
  y: number;
  t: number;
  /** The widget (frame) the pointer was on, or heading into, when this was sampled, if any. */
  hit?: unknown;
  /**
   * The widgets the pointer's travel (from the previous sample) pointed at when this was sampled: judged
   * on the geometry of that moment, so a widget that comes into view later (scrolled to by its own focus,
   * say) isn't credited for travel toward where it now is.
   */
  toward?: readonly unknown[];
}

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** How long Chromium's transient user activation lasts. */
export const ACTIVATION_WINDOW_MS = 5000;
/** A last pointer sample this close to the panel's edge means the pointer left the webview. */
export const EDGE_PX = 24;
const MAX_SAMPLES = 8;
/**
 * A pointer heading into a widget frame this close is taken to have entered it: with site isolation the
 * panel's last sample is the last move outside the frame (the frame's own moves go to its process).
 */
export const ENTRY_PX = 24;
const MAX_GESTURES = 16;

/** `refuse`: evidence against; `unsure`: refused, but the pointer is on the widget now (not counted as theft). */
export type Verdict = 'allow' | 'refuse' | 'unsure';

export class ActivationEvidence {
  private gestures: number[] = [];
  private samples: Point[] = [];
  /** When the panel last moved focus itself: gestures before it are used up. */
  private consumedAt = -Infinity;

  /** A gesture the panel saw (pointerdown, touchstart, keydown); `at` is where a pointer gesture happened. */
  gesture(t: number, at?: { x: number; y: number }): void {
    this.gestures.push(t);
    if (this.gestures.length > MAX_GESTURES) this.gestures.shift();
    if (at) this.sample({ ...at, t, hit: undefined });
  }

  /** A pointer position the panel saw (pointermove, pointerout, …), in panel viewport coordinates. */
  sample(p: Point): void {
    // The same position again (boundary events after a layout change under a resting pointer) isn't travel.
    const last = this.samples.at(-1);
    if (last && Math.abs(last.x - p.x) < 1 && Math.abs(last.y - p.y) < 1) return;
    this.samples.push(p);
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
  }

  /** The panel moved focus itself (Enter on a placeholder): that counts, and uses up the gestures before it. */
  panelMove(t: number): void {
    this.consumedAt = t;
  }

  /** The latest pointer sample. */
  last(): Point | undefined {
    return this.samples.at(-1);
  }

  /** Forget everything (a new explainer). */
  reset(): void {
    this.gestures = [];
    this.samples = [];
    this.consumedAt = -Infinity;
  }

  /**
   * Whether an activation at `now` may be credited to the widget `target`, whose visible box is `box` (null:
   * not visible, never credited). `viewport` is the panel's size, for the edge rule.
   */
  allows(box: Box | null, now: number, viewport: { width: number; height: number }, target?: unknown): boolean {
    return this.judge(box, now, viewport, target) === 'allow';
  }

  judge(box: Box | null, now: number, viewport: { width: number; height: number }, target?: unknown): Verdict {
    const since = Math.max(now - ACTIVATION_WINDOW_MS, this.consumedAt);
    const last = this.gestures.filter((t) => t > since && t <= now).at(-1);
    if (last === undefined) return 'allow'; // the gesture happened where the panel can't see: in a widget
    if (!box) return 'refuse';
    const p2 = this.samples.at(-1);
    if (!p2) return 'refuse';
    const edge = p2.x < EDGE_PX || p2.y < EDGE_PX || p2.x > viewport.width - EDGE_PX || p2.y > viewport.height - EDGE_PX;
    if (p2.t <= last) {
      // No travel since the gesture. The pointer resting on this widget all along (it was on it when sampled,
      // and is still inside its box) counts; one the widget only moved or grew under doesn't.
      const mine = target !== undefined && p2.hit === target;
      if (edge || !(inside(box, p2) || (mine && inside(grow(box, ENTRY_PX), p2)))) return 'refuse';
      return mine ? 'allow' : 'unsure';
    }
    // Travel after the gesture toward the widget, as it was when the pointer moved.
    if (edge) return 'refuse';
    if (target !== undefined) return p2.hit === target || !!p2.toward?.includes(target) ? 'allow' : 'refuse';
    if (inside(box, p2)) return 'allow';
    const p1 = this.samples.at(-2);
    return p1 && rayHits(p1, p2, box) ? 'allow' : 'refuse';
  }
}

const grow = (b: Box, d: number): Box => ({ left: b.left - d, top: b.top - d, right: b.right + d, bottom: b.bottom + d });
const inside = (b: Box, p: { x: number; y: number }) => p.x >= b.left && p.x <= b.right && p.y >= b.top && p.y <= b.bottom;

/** How far from `p2` the ray from `p1` through `p2` enters the box (0 when inside), or undefined if it misses. */
export function rayEntry(p1: { x: number; y: number }, p2: { x: number; y: number }, b: Box): number | undefined {
  if (inside(b, p2)) return 0;
  const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  if (len === 0) return undefined;
  let lo = 0;
  let hi = Infinity;
  for (const [o, d, min, max] of [
    [p2.x, (p2.x - p1.x) / len, b.left, b.right],
    [p2.y, (p2.y - p1.y) / len, b.top, b.bottom],
  ] as const) {
    if (d === 0) {
      if (o < min || o > max) return undefined;
      continue;
    }
    let t1 = (min - o) / d;
    let t2 = (max - o) / d;
    if (t1 > t2) [t1, t2] = [t2, t1];
    lo = Math.max(lo, t1);
    hi = Math.min(hi, t2);
    if (lo > hi) return undefined;
  }
  return lo;
}

/** Whether the ray from `p2` away from `p1` (through both) hits the box: slab test, parameter ≥ 0 from p2. */
export function rayHits(p1: { x: number; y: number }, p2: { x: number; y: number }, b: Box): boolean {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  if (dx === 0 && dy === 0) return inside(b, p2);
  let lo = 0;
  let hi = Infinity;
  for (const [o, d, min, max] of [
    [p2.x, dx, b.left, b.right],
    [p2.y, dy, b.top, b.bottom],
  ] as const) {
    if (d === 0) {
      if (o < min || o > max) return false;
      continue;
    }
    let t1 = (min - o) / d;
    let t2 = (max - o) / d;
    if (t1 > t2) [t1, t2] = [t2, t1];
    lo = Math.max(lo, t1);
    hi = Math.min(hi, t2);
    if (lo > hi) return false;
  }
  return true;
}

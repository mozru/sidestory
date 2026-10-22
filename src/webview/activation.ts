// Was it the reader's interaction with this widget? (docs/WIDGETS-PLAN.md §5.3.) With site isolation the
// panel sees no input inside a widget, so it refuses only on evidence it has: during the current activation
// window, a gesture of its own (pointerdown, touch or keydown in the panel or the content frame) that wasn't
// followed by pointer travel toward the widget. No gesture of its own means the activating gesture happened
// in a frame the panel can't see, which is then accepted. Pure geometry and bookkeeping, unit tested.

export interface Point {
  x: number;
  y: number;
  t: number;
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
const MAX_GESTURES = 16;

export class ActivationEvidence {
  private gestures: number[] = [];
  private samples: Point[] = [];
  /** When the panel last moved focus itself: gestures before it are used up. */
  private consumedAt = -Infinity;

  /** A gesture the panel saw (pointerdown, touchstart, keydown); `at` is where a pointer gesture happened. */
  gesture(t: number, at?: { x: number; y: number }): void {
    this.gestures.push(t);
    if (this.gestures.length > MAX_GESTURES) this.gestures.shift();
    if (at) this.sample({ ...at, t });
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

  /** Forget everything (a new explainer). */
  reset(): void {
    this.gestures = [];
    this.samples = [];
    this.consumedAt = -Infinity;
  }

  /**
   * Whether an activation at `now` may be credited to the widget at `box`. `viewport` is the panel's size,
   * for the edge rule.
   */
  allows(box: Box, now: number, viewport: { width: number; height: number }): boolean {
    const since = Math.max(now - ACTIVATION_WINDOW_MS, this.consumedAt);
    const last = this.gestures.filter((t) => t > since && t <= now).at(-1);
    if (last === undefined) return true; // the gesture happened where the panel can't see: in a widget
    // Travel after the gesture: the latest sample must come after it.
    const p2 = this.samples.at(-1);
    if (!p2 || p2.t <= last) return false;
    if (p2.x < EDGE_PX || p2.y < EDGE_PX || p2.x > viewport.width - EDGE_PX || p2.y > viewport.height - EDGE_PX) return false;
    if (inside(box, p2)) return true;
    const p1 = this.samples.at(-2);
    if (!p1) return false;
    return rayHits(p1, p2, box);
  }
}

const inside = (b: Box, p: { x: number; y: number }) => p.x >= b.left && p.x <= b.right && p.y >= b.top && p.y <= b.bottom;

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

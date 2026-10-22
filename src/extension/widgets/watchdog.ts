// The extension-side widget watchdog (docs/WIDGETS-PLAN.md §4), for when widgets share the panel's thread
// and a hung widget freezes the panel itself. The panel beats every second while visible; the watchdog is
// armed only while beats flow from a visible panel, ignores gaps its own timer also saw (sleep, debugger, a
// busy extension host), and trips when beats stop for 10 s or keep arriving very late. Pure (clock passed
// in), so the rules are unit tested.

export const TICK_MS = 1000;
export const SILENCE_MS = 10_000;
export const LATE_MS = 2000;
export const LATE_BEATS = 3;
export const LATE_WINDOW_MS = 60_000;
/** The extension's own timer this late means the gap says nothing about the panel. */
const OWN_DRIFT_MS = 2000;

export interface Beat {
  delay: number;
  visible: boolean;
  mounted: string[];
  mounting: string | null;
  recent: string | null;
}

export class HeartbeatWatchdog {
  private lastBeat = -Infinity;
  private lastTick = -Infinity;
  private armed = false;
  private late: number[] = [];
  /** The latest breadcrumbs, for picking a suspect. */
  last: Beat | undefined;

  beat(b: Beat, at: number): 'trip' | undefined {
    this.lastBeat = at;
    this.last = b;
    // Armed while a visible panel with widgets beats; a hidden panel's frames are gone anyway.
    this.armed = b.visible && (b.mounted.length > 0 || b.mounting !== null);
    if (!this.armed) {
      this.late = [];
      return undefined;
    }
    if (b.delay > LATE_MS) {
      this.late = [...this.late.filter((t) => at - t < LATE_WINDOW_MS), at];
      if (this.late.length >= LATE_BEATS) {
        this.late = [];
        this.armed = false;
        return 'trip';
      }
    }
    return undefined;
  }

  /** Called every TICK_MS by the extension's own timer. `connected`: the remote connection is up. */
  tick(at: number, connected = true): 'trip' | undefined {
    const drift = this.lastTick === -Infinity ? 0 : at - this.lastTick - TICK_MS;
    this.lastTick = at;
    if (drift > OWN_DRIFT_MS || !connected) {
      // We were frozen too (or cut off): the gap is ours, start counting again.
      this.lastBeat = Math.max(this.lastBeat, at);
      return undefined;
    }
    if (!this.armed || at - this.lastBeat < SILENCE_MS) return undefined;
    this.armed = false;
    return 'trip';
  }

  /** The widget to blame: the one mounting, else the one with the most recent work. */
  suspect(): string | undefined {
    return this.last?.mounting ?? this.last?.recent ?? this.last?.mounted.at(-1) ?? undefined;
  }

  /** The panel went away or was hidden: nothing to watch. */
  disarm(): void {
    this.armed = false;
    this.late = [];
  }
}

export type Escalation = 'suspect' | 'all' | 'stop';
export const ESCALATION_WINDOW_MS = 5 * 60_000;

/**
 * First trip for an explainer disables the suspect; a second within 5 minutes disables all its widgets; a
 * third stops acting (and says so).
 */
export class Escalations {
  private readonly trips = new Map<string, number[]>();

  record(explainer: string, at: number): Escalation {
    const list = [...(this.trips.get(explainer) ?? []).filter((t) => at - t < ESCALATION_WINDOW_MS), at];
    this.trips.set(explainer, list);
    return list.length === 1 ? 'suspect' : list.length === 2 ? 'all' : 'stop';
  }
}

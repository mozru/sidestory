// The extension-side widget watchdog (docs/WIDGETS-PLAN.md §4), for when widgets share the panel's thread
// and a hung widget freezes the panel itself. The panel beats every second while visible with a widget mounted
// (and once more as that ends, which disarms); the watchdog is armed only while such beats flow, and the
// extension's timer runs only while some watchdog is armed. It ignores gaps its own timer also saw (sleep, debugger, a
// busy extension host) and quiet periods (one of our modal dialogs open, and just after; a new gate mounting
// widgets), and trips only on the panel's own evidence: beats that stopped for 10 s and came back late by the
// panel's own clock (its timer fired seconds late: it was frozen), beats still missing after 20 s, or beats
// that keep arriving very late. Silence followed by an on-time beat was the messages being held up elsewhere
// (the workbench behind a dialog, the browser), not the panel. Pure (clock passed in), so the rules are unit
// tested.

export const TICK_MS = 1000;
/** Beats missing this long make the panel suspect; the next beat (or more silence) decides. */
export const SILENCE_MS = 10_000;
/** Beats missing this long: the panel is still frozen. */
export const HARD_SILENCE_MS = 20_000;
export const LATE_MS = 2000;
export const LATE_BEATS = 3;
export const LATE_WINDOW_MS = 60_000;
/** After one of our modal dialogs closes, or a new gate mounts widgets, the panel gets this long to settle. */
export const QUIET_MS = 5000;
/** The extension's own timer this late means the gap says nothing about the panel. */
const OWN_DRIFT_MS = 2000;

export interface Beat {
  delay: number;
  visible: boolean;
  mounted: string[];
  mounting: string | null;
  recent: string | null;
}

/**
 * Times when the watchdogs don't judge the panel: while one of our modal dialogs is open (VS Code holds the
 * webview's messages and timers back behind it, in a browser especially), and for QUIET_MS after it closes or
 * after a new gate mounted widgets (a burst of library loading).
 */
export class QuietPeriods {
  private open = 0;
  private until = -Infinity;

  /** A modal dialog of ours opened. */
  begin(): void {
    this.open++;
  }

  /** It closed at `at`. */
  end(at: number): void {
    this.open = Math.max(0, this.open - 1);
    this.hold(at);
  }

  /** Quiet for QUIET_MS from `at` (a new gate). */
  hold(at: number, ms = QUIET_MS): void {
    this.until = Math.max(this.until, at + ms);
  }

  active(at: number): boolean {
    return this.open > 0 || at < this.until;
  }

  /** For tests: no quiet period. */
  clear(): void {
    this.open = 0;
    this.until = -Infinity;
  }
}

/** The extension's quiet periods (every modal of ours goes through `ourModal`). */
export const QUIET = new QuietPeriods();

/** Shows one of our modal dialogs as a quiet period for the watchdogs. */
export async function ourModal<T>(show: () => Thenable<T>): Promise<T> {
  QUIET.begin();
  try {
    return await show();
  } finally {
    QUIET.end(Date.now());
  }
}

export class HeartbeatWatchdog {
  private lastBeat = -Infinity;
  private lastTick = -Infinity;
  private armed = false;
  private late: number[] = [];
  /** Beats went missing for SILENCE_MS: the next beat says whether the panel was frozen. */
  private silent = false;
  /** The latest breadcrumbs, for picking a suspect. */
  last: Beat | undefined;

  /** Beats from a visible panel with widgets mounted: silence would count against it, so the timer must run. */
  get isArmed(): boolean {
    return this.armed;
  }

  /** The extension's timer starts again after a pause (no watchdog was armed): no drift to judge against. */
  restartClock(): void {
    this.lastTick = -Infinity;
  }

  beat(b: Beat, at: number, quiet = false): 'trip' | undefined {
    const wasSilent = this.silent;
    this.silent = false;
    this.lastBeat = at;
    this.last = b;
    // Armed while a visible panel with widgets beats; a hidden panel's frames are gone anyway.
    this.armed = b.visible && (b.mounted.length > 0 || b.mounting !== null);
    if (!this.armed || quiet) {
      this.late = [];
      return undefined;
    }
    // Back after a silence: frozen if its own timer fired late, else the beats were held up on the way.
    if (wasSilent && b.delay > LATE_MS) {
      this.late = [];
      this.armed = false;
      return 'trip';
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

  /**
   * Called every TICK_MS by the extension's own timer. `connected`: the remote connection is up; `quiet`: a
   * quiet period (QuietPeriods), when silence counts from its end.
   */
  tick(at: number, connected = true, quiet = false): 'trip' | undefined {
    const drift = this.lastTick === -Infinity ? 0 : at - this.lastTick - TICK_MS;
    this.lastTick = at;
    if (drift > OWN_DRIFT_MS || !connected || quiet) {
      // We were frozen too (or cut off, or a dialog of ours held things up): the gap is ours, start counting again.
      this.lastBeat = Math.max(this.lastBeat, at);
      this.silent = false;
      return undefined;
    }
    if (!this.armed || at - this.lastBeat < SILENCE_MS) return undefined;
    this.silent = true;
    if (at - this.lastBeat < HARD_SILENCE_MS) return undefined;
    this.silent = false;
    this.armed = false;
    return 'trip';
  }

  /**
   * The widget to blame, on evidence: the one mounting, else the one that last did work, else the only one
   * mounted. Undefined when several were mounted and none did anything (no explainer's widget is blamed).
   */
  suspect(): string | undefined {
    const l = this.last;
    return l?.mounting ?? l?.recent ?? (l?.mounted.length === 1 ? l.mounted[0] : undefined);
  }

  /** The panel went away or was hidden: nothing to watch. */
  disarm(): void {
    this.armed = false;
    this.silent = false;
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

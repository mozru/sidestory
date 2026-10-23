// What readers set in widgets (`useWidgetState`), kept by the panel across unmounts, live edits and the
// panel being hidden, and by the extension (workspaceState) across window reloads and the panel being
// closed (docs/WIDGETS-PLAN.md §5.3 "State"): at most 64 KB per widget and 256 KB per panel (per explainer in
// the extension), least recently used dropped first. Pure, so the caps can be unit tested.

export const MAX_STATE_PER_WIDGET = 64 * 1024;
export const MAX_STATE_PER_PANEL = 256 * 1024;

/** Saved form, kept in the webview's own state: oldest first. */
export type SavedWidgetStates = [key: string, json: string][];

const encoder = new TextEncoder();
/** Bytes as UTF-8, the way the caps are stated. */
const cost = (key: string, json: string) => encoder.encode(key).length + encoder.encode(json).length;

export class WidgetStates {
  private readonly map = new Map<string, string>();
  private total = 0;
  private readonly perWidget: number;
  private readonly perPanel: number;

  constructor(saved: unknown = [], perWidget = MAX_STATE_PER_WIDGET, perPanel = MAX_STATE_PER_PANEL) {
    this.perWidget = perWidget;
    this.perPanel = perPanel;
    if (Array.isArray(saved)) for (const e of saved) if (Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'string') this.set(e[0], e[1]);
  }

  get bytes(): number {
    return this.total;
  }

  get(key: string): string | null {
    const v = this.map.get(key);
    if (v === undefined) return null;
    // Reading counts as use: a widget being mounted again is the most recent.
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  /** Stores a widget's state. Returns false (and keeps nothing new) when it is over the per-widget cap. */
  set(key: string, json: string): boolean {
    if (encoder.encode(json).length > this.perWidget) return false;
    this.delete(key);
    this.map.set(key, json);
    this.total += cost(key, json);
    for (const [k, v] of this.map) {
      if (this.total <= this.perPanel) break;
      this.map.delete(k);
      this.total -= cost(k, v);
    }
    return true;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  delete(key: string): void {
    const old = this.map.get(key);
    if (old === undefined) return;
    this.map.delete(key);
    this.total -= cost(key, old);
  }

  save(): SavedWidgetStates {
    return [...this.map];
  }
}

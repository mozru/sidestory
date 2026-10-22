// The widget SDK, `import … from 'explainer'` (docs/WIDGETS.md). Matches src/widget-runtime/runtime/sdk.ts.

declare module 'explainer' {
  type ReactNode = __CxReact.ReactNode;

  /** Lines relative to an anchor's current first line, 1-based: one line, or [first, last]. */
  export type Lines = number | readonly [number, number] | readonly number[];

  export type AnchorState = 'exact' | 'moved' | 'changed' | 'stale' | 'lost' | 'pending' | (string & {});

  export interface WidgetAnchor {
    id: string;
    title: string;
    /** Index among the steps, or -1 for a nested (non-step) anchor. */
    step: number;
    /** Repository-relative path. */
    file: string;
    /** Current lines, 1-based and inclusive; null when the code can't be found. */
    range: { start: number; end: number } | null;
    state: AnchorState;
    /** A theme color id, such as charts.purple. */
    color?: string;
  }

  /** Why useAnchorCode has no code for an anchor. Shown to authors by the checker, never to readers. */
  export type UnavailableReason = 'not-pinned' | 'unconfirmed' | 'ignored' | 'secret-file' | 'lost' | 'changed-untracked' | 'changed-since-commit' | 'too-large' | 'not-requested';

  export type AnchorCode =
    | { anchor: string; status: 'ok'; text: string; startLine: number; language: string; state: AnchorState; reason?: undefined }
    | { anchor: string; status: 'unavailable'; reason: UnavailableReason; text?: undefined; startLine?: undefined; language?: undefined; state?: AnchorState };

  // ---- steps ----
  /** The current step's anchor id, or null. */
  export function useActiveStep(): string | null;
  /** The anchor of the section this widget sits in (its nearest enclosing data-explain-anchor), or null. */
  export function useMyAnchor(): string | null;
  /** True while this widget's own step is the current one. */
  export function useIsMyStepActive(): boolean;
  /** True while step `id` is the current one. */
  export function useIsActive(id: string): boolean;
  /** The current step; next() and prev() work only from a click or key handler in the widget. */
  export function useStep(): { id: string | null; index: number; count: number; next(): Promise<boolean>; prev(): Promise<boolean> };
  /** The value for the current step (by anchor id), or `fallback`. */
  export function useStepValue<T>(values: Readonly<Record<string, T>>, fallback: T): T;
  /** Moves to the next step. Only from a click or key handler in the widget, before any await. */
  export function next(): Promise<boolean>;
  /** Moves to the previous step. Only from a click or key handler in the widget, before any await. */
  export function prev(): Promise<boolean>;

  // ---- code ----
  /** Every anchor of the explainer, live. */
  export function useAnchors(): WidgetAnchor[];
  /**
   * An anchor's code, live (unsaved edits included). null until the panel answers; then status 'ok' with
   * the text (startLine is its first line in the file), or status 'unavailable' with a reason.
   */
  export function useAnchorCode(anchor: string): AnchorCode | null;

  // ---- editor ----
  /**
   * Highlights lines in the editor, relative to the anchor's current first line (1 = its first line), while
   * that anchor's step is current. Needs no click; never scrolls or takes focus. Default anchor: the
   * widget's enclosing one. Call with no lines to clear.
   */
  export function highlight(lines?: Lines | null, options?: { anchor?: string; identifiers?: string[] }): void;
  /** Shows an anchor's code in the editor. Only from a click or key handler in the widget, before any await. */
  export function reveal(anchor: string, options?: { lines?: Lines; highlight?: string[] }): Promise<boolean>;
  /** Makes `anchor` the current step. Only from a click or key handler in the widget, before any await. */
  export function goToStep(anchor: string): Promise<boolean>;
  /** A link-styled button that reveals an anchor's code when clicked. */
  export function Ref(props: { anchor: string; lines?: Lines; children?: ReactNode; className?: string; [attribute: string]: any }): ReactNode;

  // ---- state ----
  /**
   * Like useState, but kept across reloads, live edits, scrolling away and tab switches (JSON values,
   * at most 64 KB per widget). Use it for what the reader sets.
   */
  export function useWidgetState<T>(key: string, initial: T | (() => T)): [T, (value: T | ((prev: T) => T)) => void];

  // ---- environment ----
  export type ThemeKind = 'dark' | 'light' | 'high-contrast' | 'high-contrast-light';
  /** The VS Code theme kind; color('--chart-1'), color('primary') or color('editor.foreground') reads a theme color. */
  export function useTheme(): { kind: ThemeKind; version: number; color(name: string): string };
  /** False while the widget is scrolled off screen (its timers and animation frames are paused then). */
  export function useVisible(): boolean;
  /** True when the reader asked for less motion (OS setting or VS Code's workbench.reduceMotion). */
  export function useReducedMotion(): boolean;
  /** A file from the explainer folder as a data URL, if the widget also imports it; '' otherwise. Prefer `import url from './x.png'`. */
  export function asset(path: string): string;
}

declare module '*.svg' {
  const url: string;
  export default url;
}
declare module '*.png' {
  const url: string;
  export default url;
}
declare module '*.webp' {
  const url: string;
  export default url;
}
declare module '*.jpg' {
  const url: string;
  export default url;
}
declare module '*.jpeg' {
  const url: string;
  export default url;
}
declare module '*.gif' {
  const url: string;
  export default url;
}

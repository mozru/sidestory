// The widget SDK, `import … from 'explainer'` (docs/WIDGETS-PLAN.md §6), and the store behind it.
import { createElement as h, useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { FromWidget, ThemeKind, WidgetAnchor, WidgetCode } from '../../shared/widget-protocol.ts';
import { ANCHOR_ID, IDENTIFIER, MAX_IDENTIFIERS, MAX_LINE, MAX_WIDGET_STATE_BYTES } from '../limits.ts';

export interface Snapshot {
  activeStep: string | null;
  myAnchor: string | null;
  anchors: WidgetAnchor[];
  themeKind: ThemeKind;
  themeVersion: number;
  visible: boolean;
  reducedMotion: boolean;
  viewportHeight: number;
  codes: Readonly<Record<string, WidgetCode>>;
}

type Listener = () => void;

/** A minimal external store for useSyncExternalStore: immutable snapshots, notify on change. */
class Store<T> {
  #listeners = new Set<Listener>();
  value: T;
  constructor(value: T) { this.value = value; }
  get = () => this.value;
  subscribe = (l: Listener) => { this.#listeners.add(l); return () => { this.#listeners.delete(l); }; };
  set(patch: Partial<T>) { this.value = { ...this.value, ...patch }; for (const l of this.#listeners) l(); }
}

export const store = new Store<Snapshot>({
  activeStep: null, myAnchor: null, anchors: [], themeKind: 'dark', themeVersion: 0, visible: true, reducedMotion: false, viewportHeight: 800, codes: {},
});

// ---- bridge (set by the runtime) ----
let post: (m: FromWidget) => void = () => {};
let reportError: (message: string) => void = () => {};
let assetLookup: (path: string) => string | undefined = () => undefined;
export function connectSdk(opts: { post: typeof post; reportError: typeof reportError; asset: typeof assetLookup }) {
  post = opts.post;
  reportError = opts.reportError;
  assetLookup = opts.asset;
}

// ---- requests answered by `result` ----
let nextRequest = 1;
const pending = new Map<number, (ok: boolean) => void>();
const REQUEST_TIMEOUT_MS = 5000;

function request(make: (id: number) => FromWidget): Promise<boolean> {
  const id = nextRequest++;
  return new Promise<boolean>((resolve) => {
    pending.set(id, resolve);
    // Posted synchronously: the panel checks user activation when the message arrives (plan §5.3).
    post(make(id));
    __cxEnv!.native.setTimeout(() => { if (pending.delete(id)) resolve(false); }, REQUEST_TIMEOUT_MS);
  });
}
export function settle(id: number, ok: boolean) {
  const resolve = pending.get(id);
  if (!resolve) return;
  pending.delete(id);
  resolve(ok === true);
}

type Lines = number | readonly number[] | undefined | null;

/** A call the panel would drop: said to the author (Output and the box's badge) instead of failing silently. */
class BadArgument extends Error {}
function bad(fn: string, what: string): never {
  throw new BadArgument(`${fn}: ${what}; the call was ignored.`);
}
/** Runs a call's argument checks; an invalid call is reported and yields `fallback`. */
function checked<T>(fallback: T, run: () => T): T {
  try {
    return run();
  } catch (e) {
    if (!(e instanceof BadArgument)) throw e;
    reportError(e.message);
    return fallback;
  }
}

function lineRange(fn: string, lines: Lines): [number, number] | undefined {
  if (lines === undefined || lines === null) return undefined;
  const list = typeof lines === 'number' ? [lines, lines] : Array.isArray(lines) ? (lines.length === 1 ? [lines[0], lines[0]] : lines) : null;
  if (!list || list.length !== 2 || !list.every((n) => Number.isInteger(n) && n >= 1 && n <= MAX_LINE)) {
    bad(fn, `lines must be a line number or a [first, last] pair of whole numbers from 1 (relative to the anchor), not ${JSON.stringify(lines)}`);
  }
  const [a, b] = list as [number, number];
  return [Math.min(a, b), Math.max(a, b)];
}
function anchorId(fn: string, anchor: unknown): string {
  if (typeof anchor !== 'string' || !ANCHOR_ID.test(anchor)) bad(fn, `${JSON.stringify(anchor) ?? String(anchor)} isn't an anchor id`);
  return anchor;
}
function identifiers(fn: string, ids: unknown): string[] | undefined {
  if (ids === undefined || ids === null) return undefined;
  if (!Array.isArray(ids) || ids.length > MAX_IDENTIFIERS || !ids.every((i) => typeof i === 'string' && IDENTIFIER.test(i))) {
    bad(fn, `identifiers must be an array of at most ${MAX_IDENTIFIERS} identifiers (letters, digits, _ and $)`);
  }
  return ids as string[];
}

// ---- steps ----
export const useSnapshot = () => useSyncExternalStore(store.subscribe, store.get);
export const useActiveStep = () => useSnapshot().activeStep;
export const useMyAnchor = () => useSnapshot().myAnchor;
/** True while the step this widget sits in (its enclosing anchor) is the current one. */
export function useIsMyStepActive() {
  const s = useSnapshot();
  return s.myAnchor !== null && s.activeStep === s.myAnchor;
}
export const useIsActive = (id: string) => useSnapshot().activeStep === id;

export const next = () => request((id) => ({ type: 'key', id, action: 'next' }));
export const prev = () => request((id) => ({ type: 'key', id, action: 'prev' }));

export function useStep() {
  const { anchors, activeStep } = useSnapshot();
  return useMemo(() => {
    const steps = anchors.filter((a) => a.step >= 0).sort((a, b) => a.step - b.step);
    return { id: activeStep, index: steps.findIndex((a) => a.id === activeStep), count: steps.length, next, prev };
  }, [anchors, activeStep]);
}

export function useStepValue<T>(values: Readonly<Record<string, T>>, fallback: T): T {
  const step = useActiveStep();
  return step !== null && Object.prototype.hasOwnProperty.call(values, step) ? values[step]! : fallback;
}

// ---- code ----
export const useAnchors = () => useSnapshot().anchors;

const requestedCode = new Set<string>();
export function resetCodeRequests() { requestedCode.clear(); }

/** The code of an anchor, live; null until the panel answers. `status: 'unavailable'` carries a reason. */
export function useAnchorCode(anchor: string): WidgetCode | null {
  const code = useSnapshot().codes[anchor] ?? null;
  useEffect(() => {
    if (requestedCode.has(anchor)) return;
    if (!checked(false, () => !!anchorId('useAnchorCode()', anchor))) return;
    requestedCode.add(anchor);
    post({ type: 'requestCode', anchor });
  }, [anchor]);
  return code;
}

// ---- editor ----
export function highlight(lines?: Lines, opts: { anchor?: string; identifiers?: string[] } = {}) {
  checked(undefined, () => {
    const o = opts ?? {};
    const m: FromWidget = { type: 'highlight', lines: lineRange('highlight()', lines), anchor: o.anchor === undefined ? undefined : anchorId('highlight()', o.anchor), identifiers: identifiers('highlight()', o.identifiers) };
    post(m);
  });
}
export function reveal(anchor: string, opts: { lines?: Lines; highlight?: string[] } = {}): Promise<boolean> {
  return checked(Promise.resolve(false), () => {
    const o = opts ?? {};
    const a = anchorId('reveal()', anchor);
    const lines = lineRange('reveal()', o.lines);
    const hl = identifiers('reveal()', o.highlight);
    return request((id) => ({ type: 'reveal', id, anchor: a, lines, highlight: hl }));
  });
}
export function goToStep(anchor: string): Promise<boolean> {
  return checked(Promise.resolve(false), () => {
    const a = anchorId('goToStep()', anchor);
    return request((id) => ({ type: 'step', id, anchor: a }));
  });
}
/** A link to an anchor's code: `<Ref anchor="refill">the refill path</Ref>`. Works from a click. */
export function Ref({ anchor, lines, children, className, ...rest }: { anchor: string; lines?: Lines; children?: ReactNode; className?: string } & Record<string, unknown>) {
  return h('button', {
    ...rest, type: 'button', className: className ? `cx-ref ${className}` : 'cx-ref',
    onClick: (e: { preventDefault(): void }) => { e.preventDefault(); void reveal(anchor, { lines }); },
  }, children ?? anchor);
}

// ---- widget state ----
const stateStore = new Store<{ values: ReadonlyMap<string, unknown> }>({ values: new Map() });
let saveTimer: number | undefined;
let lastSaved: string | null = null;
let oversizeReported = false;
const SAVE_DELAY_MS = 250;

export function restoreState(json: string | null) {
  const values = new Map<string, unknown>();
  if (json) {
    try {
      const parsed: unknown = JSON.parse(json);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) for (const [k, v] of Object.entries(parsed)) values.set(k, v);
    } catch { /* corrupt state: start fresh */ }
  }
  lastSaved = json;
  stateStore.set({ values });
}

/** Sends the state now (on `saveState`, or `force` to answer even when nothing changed). */
export function flushState(force: boolean) {
  if (saveTimer !== undefined) __cxEnv!.native.clearTimeout(saveTimer);
  saveTimer = undefined;
  const json = JSON.stringify(Object.fromEntries(stateStore.value.values));
  if (!force && json === lastSaved) return;
  if (new TextEncoder().encode(json).length > MAX_WIDGET_STATE_BYTES) {
    if (!oversizeReported) reportError(`useWidgetState: the widget's state is over ${MAX_WIDGET_STATE_BYTES / 1024} KB, so it isn't saved. Keep only what the reader set.`);
    oversizeReported = true;
    return;
  }
  lastSaved = json;
  post({ type: 'state', json });
}

export function useWidgetState<T>(key: string, initial: T | (() => T)): [T, (v: T | ((prev: T) => T)) => void] {
  const [fallback] = useState(initial); // lazily evaluated once, like useState
  const value = useSyncExternalStore(stateStore.subscribe, () => (stateStore.value.values.has(key) ? stateStore.value.values.get(key) : fallback) as T);
  const set = useCallback((v: T | ((prev: T) => T)) => {
    const cur = stateStore.value.values;
    const prevValue = (cur.has(key) ? cur.get(key) : fallback) as T;
    const nextValue = typeof v === 'function' ? (v as (p: T) => T)(prevValue) : v;
    if (Object.is(nextValue, prevValue)) return;
    const values = new Map(cur);
    values.set(key, nextValue);
    stateStore.set({ values });
    if (saveTimer === undefined) saveTimer = __cxEnv!.native.setTimeout(() => { saveTimer = undefined; flushState(false); }, SAVE_DELAY_MS);
  }, [key, fallback]);
  return [value, set];
}

// ---- environment ----
export function themeColor(name: string): string {
  const prop = name.startsWith('--') ? name : name.includes('.') ? `--vscode-${name.replace(/\./g, '-')}` : `--${name}`;
  return getComputedStyle(document.documentElement).getPropertyValue(prop).trim();
}
export function useTheme() {
  const { themeKind, themeVersion } = useSnapshot();
  return useMemo(() => ({ kind: themeKind, version: themeVersion, color: themeColor }), [themeKind, themeVersion]);
}
export const useVisible = () => useSnapshot().visible;
export const useReducedMotion = () => useSnapshot().reducedMotion;
/** A file from the explainer folder, as a data URL ('' if the compiler didn't include it). */
export function asset(path: string): string {
  const url = assetLookup(String(path));
  if (url === undefined) console.warn(`asset(${JSON.stringify(path)}): not found; import it instead (import img from './${path}')`);
  return url ?? '';
}

export const SDK = {
  useActiveStep, useMyAnchor, useIsMyStepActive, useIsActive, useStep, useStepValue, next, prev,
  useAnchors, useAnchorCode, highlight, reveal, goToStep, Ref,
  useWidgetState, useTheme, useVisible, useReducedMotion, asset,
};

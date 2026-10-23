// The in-frame widget runtime (library 'runtime', registered as 'explainer'): loaded last by the bootstrap's
// `load`, it receives `init`, runs the widget's CommonJS modules, mounts its component, and bridges to the
// panel. docs/WIDGETS-PLAN.md §2, §3, §5.3, §6–§8, §13.
import { Component, createElement as h, useLayoutEffect, type ComponentType, type ErrorInfo, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MotionConfig } from 'motion/react';
import type { FromWidget, ToWidget } from '../../shared/widget-protocol.ts';
import { MAX_WIDGET_HEIGHT } from '../limits.ts';
import { WIDGET_ALIASES } from '../../shared/widget-imports.ts';
import { LUCIDE_FACTORY, register, registry } from '../registry.ts';
import { installLoopGuard } from './loop-guard.ts';
import { installShims, NETWORK_MESSAGE } from './shims.ts';
import { installFocus } from './focus.ts';
import { SDK, connectSdk, flushState, resetCodeRequests, restoreState, settle, store, useSnapshot } from './sdk.ts';
import css from './runtime.css';

type Init = Extract<ToWidget, { type: 'init' }> & {
  /** Icon nodes for the widget's generated 'lucide-react' module (from the compiler). */
  icons?: Record<string, unknown>;
  /** Files for asset(path), as data URLs. */
  assets?: Record<string, string>;
};

const env = globalThis.__cxEnv!;
const native = env.native;

// ---- messages ----
function post(m: FromWidget) {
  parent.postMessage(m, '*');
}

// ---- errors ----
const STACK_FRAME = /widget:\/\/\/([^\s):]+):(\d+):(\d+)/;
let errorsReported = 0;
const MAX_ERRORS = 20;

/** The first frame of the stack that is in widget code. */
function locate(error: unknown): { file?: string; line?: number } {
  const stack = error instanceof Error ? String(error.stack ?? '') : '';
  const m = STACK_FRAME.exec(stack);
  return m ? { file: decodeURI(m[1]!), line: Number(m[2]) } : {};
}
function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name === 'Error' ? '' : `${error.name}: `}${error.message}`;
  try { return String(error); } catch { return 'Unknown error'; }
}
function reportError(error: unknown, where?: { file?: string; line?: number }) {
  if (errorsReported++ >= MAX_ERRORS) return;
  const loc = where ?? locate(error);
  post({
    type: 'error', message: describe(error).slice(0, 2048),
    ...(loc.file ? { file: loc.file.slice(0, 512) } : {}), ...(loc.line ? { line: loc.line } : {}),
  });
}
window.addEventListener('error', (e) => {
  if (defining) return; // reported by define()
  const loc = locate(e.error);
  reportError(e.error ?? e.message, loc.file ? loc : undefined);
});
window.addEventListener('unhandledrejection', (e) => reportError(e.reason));

// ---- notices (in the box) ----
const notices = new Set<string>();
function notice(text: string): HTMLElement | undefined {
  if (notices.has(text)) return undefined;
  notices.add(text);
  const el = document.createElement('div');
  el.className = 'cx-notice';
  el.setAttribute('role', 'status');
  el.textContent = text;
  document.body.append(el);
  return el;
}

// ---- document setup ----
installLoopGuard();
const style = document.createElement('style');
style.textContent = css;
document.head.append(style);
const rootEl = document.createElement('div');
rootEl.id = 'cx-root';
document.body.append(rootEl);
installShims({ viewportHeight: () => store.value.viewportHeight, onNetwork: () => notice(NETWORK_MESSAGE) });
installFocus(post, rootEl);

// ---- theme ----
let themeVars: string[] = [];
function applyTheme(t: { kind: Init['theme']['kind']; vars: Record<string, string>; bodyClass: string; reducedMotion?: boolean }) {
  const html = document.documentElement;
  for (const k of themeVars) html.style.removeProperty(k);
  themeVars = [];
  for (const [k, v] of Object.entries(t.vars ?? {})) {
    const name = k.startsWith('--') ? k : `--vscode-${k}`;
    if (!/^--[\w-]+$/.test(name) || typeof v !== 'string') continue;
    html.style.setProperty(name, v);
    themeVars.push(name);
  }
  const dark = t.kind === 'dark' || t.kind === 'high-contrast';
  html.classList.toggle('dark', dark);
  html.classList.toggle('light', !dark);
  html.classList.toggle('hc', t.kind === 'high-contrast' || t.kind === 'high-contrast-light');
  // No button background (Dark High Contrast): primary falls back to the text color (theme.css).
  const buttonBg = String(t.vars?.['--vscode-button-background'] ?? '').trim();
  html.classList.toggle('cx-no-button-bg', !buttonBg || /^(transparent|#[0-9a-f]{6}00|#[0-9a-f]{3}0)$/i.test(buttonBg));
  html.style.colorScheme = dark ? 'dark' : 'light';
  document.body.className = String(t.bodyClass ?? '').replace(/[^\w -]/g, '');
  store.set({ themeKind: t.kind, themeVersion: store.value.themeVersion + 1, ...(typeof t.reducedMotion === 'boolean' ? { reducedMotion: t.reducedMotion } : {}) });
}

// ---- visibility: pause timers, frames and animations while off-screen ----
const pausedAnimations = new Set<Animation>();
function setVisible(visible: boolean) {
  if (visible === store.value.visible) return;
  document.documentElement.classList.toggle('cx-paused', !visible);
  if (!visible) {
    env.suspend();
    // Web Animations only: CSS animations and transitions are paused by the .cx-paused class, and calling
    // pause()/play() on them would override the widget's own animation-play-state from then on.
    for (const a of document.getAnimations()) {
      if (a.playState !== 'running' || a instanceof CSSAnimation || a instanceof CSSTransition) continue;
      a.pause();
      pausedAnimations.add(a);
    }
    flushState(false);
  } else {
    env.resume();
    for (const a of pausedAnimations) if (a.playState === 'paused') a.play();
    pausedAnimations.clear();
  }
  store.set({ visible });
}

// ---- height ----
const HEIGHT_INTERVAL_MS = 100;
/**
 * A widget sized to its own frame (100vh, h-full on html) grows by the same amount past the frame's height
 * every time the panel resizes the frame: a feedback loop. This many reports in a row of that shape freeze
 * the height; an expand animation (growth that eases, then stops) doesn't look like it for that long.
 */
const LOOP_REPORTS = 15;
/** px of slack when comparing the excess over the frame's height between reports. */
const LOOP_SLACK = 2;
/** Content that changed this soon after the frame was resized changed because of it. */
const FOLLOW_MS = 50;
export const GROWTH_MESSAGE = 'This widget sizes itself to the window, so its height was frozen. Give it a height (h-80, or style={{height: 320}}).';
let lastHeight = -1;
let lastSent = -Infinity;
let heightTimer: number | undefined;
let frozen = false;
/** The loop being watched: the excess of the content over the frame's height, and how many reports had it. */
let loop = { excess: Number.NaN, reports: 0 };
let growthNotice: HTMLElement | undefined;
const clientHeight = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight')!.get!;
const frameHeight = () => clientHeight.call(document.documentElement) as number;
/** Tailwind's browser build marks and measures every build; only those are cleared (not the widget's own). */
const TAILWIND_ENTRY = /^((Build #\d+ \(.*\)|Build|Build utilities|Collect classes|Compile CSS|Create compiler|Reading Stylesheets)( \((start|end)\))?|Loaded stylesheet|Failed to load stylesheet|\(error\))$/;
function clearTailwindEntries() {
  for (const type of ['mark', 'measure'] as const) {
    const names = new Set(performance.getEntriesByType(type).map((e) => e.name).filter((n) => TAILWIND_ENTRY.test(n)));
    for (const n of names) (type === 'mark' ? performance.clearMarks(n) : performance.clearMeasures(n));
  }
}

let committed = false; // no heights before the widget's first render: an empty root would report 0
function sendHeight() {
  heightTimer = undefined;
  if (!committed) return;
  // Never 0: Chromium stops rendering (and resize-observing) a zero-height cross-origin frame, so a
  // widget that rendered nothing could never grow back.
  const px = Math.max(1, Math.min(MAX_WIDGET_HEIGHT, Math.ceil(rootEl.getBoundingClientRect().height)));
  const excess = px - frameHeight();
  if (frozen) {
    // Still in the loop (the same excess over the frozen frame): stay frozen. Anything else (it shrank, or
    // settled at another height) means it wasn't sizing itself to the frame after all.
    if (Math.abs(excess - loop.excess) <= LOOP_SLACK) return;
    frozen = false;
    loop = { excess: Number.NaN, reports: 0 };
    growthNotice?.remove();
    growthNotice = undefined;
    notices.delete(GROWTH_MESSAGE);
  }
  if (px === lastHeight) return;
  const now = performance.now();
  // In the loop, the frame already has the last height sent, and the content exceeds it by a constant.
  if (px > lastHeight && lastHeight >= 0 && excess > 0 && followsFrame && frameHeight() >= lastHeight - LOOP_SLACK) {
    loop = Math.abs(excess - loop.excess) <= LOOP_SLACK ? { excess: loop.excess, reports: loop.reports + 1 } : { excess, reports: 1 };
    if (loop.reports >= LOOP_REPORTS) {
      frozen = true;
      growthNotice = notice(GROWTH_MESSAGE);
      return;
    }
  } else {
    loop = { excess: Number.NaN, reports: 0 };
  }
  lastHeight = px;
  lastSent = now;
  post({ type: 'height', px });
  // Tailwind's browser build marks every build; don't let the entries pile up.
  clearTailwindEntries();
}
function scheduleHeight() {
  if (heightTimer !== undefined) return;
  const wait = Math.max(0, lastSent + HEIGHT_INTERVAL_MS - performance.now());
  heightTimer = native.setTimeout(sendHeight, wait);
}
// In the loop the content grows in the very rendering update in which the frame was resized; content that
// grows on its own schedule (a row every 100 ms) doesn't, however steadily.
let frameResizedAt = -Infinity;
let followsFrame = false;
// A box the size of the frame: its observer runs before the root's in the same rendering update.
const viewportProbe = document.createElement('div');
viewportProbe.setAttribute('aria-hidden', 'true');
viewportProbe.style.cssText = 'position:fixed;inset:0;visibility:hidden;pointer-events:none;z-index:-1';
document.body.append(viewportProbe);
new ResizeObserver(() => { frameResizedAt = performance.now(); }).observe(viewportProbe);
new ResizeObserver(() => {
  followsFrame = performance.now() - frameResizedAt < FOLLOW_MS;
  scheduleHeight();
}).observe(rootEl);

// ---- modules ----
let modules: Record<string, string> = {};
let cache = new Map<string, { exports: unknown }>();
let factories = new Map<string, (require: (s: string) => unknown, module: { exports: unknown }, exports: unknown) => void>();
let lucideModule: Record<string, unknown> | null = null;
let defining = false;
const EXTENSIONS = ['', '.tsx', '.ts', '.jsx', '.js', '.json'];

function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}
function dirname(path: string) {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}
function resolveRelative(spec: string, from: string): string | undefined {
  const base = normalize(`${dirname(from)}/${spec}`);
  for (const ext of EXTENSIONS) if (Object.hasOwn(modules, base + ext)) return base + ext;
  for (const ext of EXTENSIONS.slice(1)) if (Object.hasOwn(modules, `${base}/index${ext}`)) return `${base}/index${ext}`;
  return undefined;
}

/** Compiles each module into a factory with a <script> (no eval: the CSP forbids it). Line numbers are kept. */
function define(path: string, code: string) {
  if (path.endsWith('.json')) {
    try {
      const value: unknown = JSON.parse(code);
      factories.set(path, (_r, module) => { module.exports = value; });
      return;
    } catch { /* not raw JSON: compiled to a module */ }
  }
  let syntaxError: ErrorEvent | undefined;
  const onError = (e: ErrorEvent) => { syntaxError ??= e; };
  window.addEventListener('error', onError);
  defining = true;
  Object.defineProperty(globalThis, '__cxDefine', { value: (p: string, f: never) => factories.set(p, f), configurable: true });
  try {
    const s = document.createElement('script');
    s.textContent = `__cxDefine(${JSON.stringify(path)},function(require,module,exports){${code}\n});\n//# sourceURL=widget:///${encodeURI(path)}`;
    document.head.append(s);
    s.remove();
  } finally {
    delete (globalThis as { __cxDefine?: unknown }).__cxDefine;
    defining = false;
    window.removeEventListener('error', onError);
  }
  if (!factories.has(path)) {
    const e = syntaxError as ErrorEvent | undefined;
    throw Object.assign(new SyntaxError(e?.message?.replace(/^Uncaught /, '') ?? `${path} could not be loaded`), { cxFile: path, cxLine: e?.lineno });
  }
}

function makeRequire(from: string) {
  return function require(spec: string): unknown {
    spec = String(spec);
    if (spec.startsWith('./') || spec.startsWith('../')) {
      const path = resolveRelative(spec, from);
      if (path === undefined) throw new Error(`Cannot find module '${spec}' from ${from}`);
      return load(path);
    }
    // The compiler rewrites relative imports to module keys (paths in the explainer folder).
    if (Object.hasOwn(modules, spec)) return load(spec);
    const s = WIDGET_ALIASES[spec] ?? spec;
    if (s === 'lucide-react') return lucide();
    const libs = registry();
    if (Object.hasOwn(libs, s) && s !== LUCIDE_FACTORY) return libs[s];
    throw new Error(`Cannot find module '${spec}' (its library wasn't loaded, or widgets can't import it)`);
  };
}

function load(path: string): unknown {
  const cached = cache.get(path);
  if (cached) return cached.exports;
  const factory = factories.get(path);
  if (!factory) throw new Error(`Cannot find module '${path}'`);
  const module = { exports: {} as unknown };
  cache.set(path, module);
  factory.call(module.exports, makeRequire(path), module, module.exports);
  return module.exports;
}

let icons: Record<string, unknown> = {};
function lucide(): unknown {
  if (lucideModule) return lucideModule;
  const factory = registry()[LUCIDE_FACTORY] as { createLucideIcon: (...a: unknown[]) => unknown; Icon: unknown; LucideProvider: unknown } | undefined;
  if (!factory) throw new Error("Cannot find module 'lucide-react' (the lucide library wasn't loaded)");
  const mod: Record<string, unknown> = { createLucideIcon: factory.createLucideIcon, Icon: factory.Icon, LucideProvider: factory.LucideProvider };
  for (const [name, node] of Object.entries(icons)) {
    const base = name.replace(/^Lucide/, '').replace(/Icon$/, '') || name;
    const kebab = base.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Z])([A-Z][a-z])/g, '$1-$2').toLowerCase();
    const icon = Array.isArray(node)
      ? factory.createLucideIcon(kebab, node)
      : factory.createLucideIcon({ name: kebab, size: 24, aliases: [], ...(node as object) });
    for (const alias of [name, base, `${base}Icon`, `Lucide${base}`]) mod[alias] ??= icon;
  }
  Object.defineProperty(mod, '__esModule', { value: true });
  return (lucideModule = mod);
}

function assetFor(path: string): string | undefined {
  const init = current;
  if (!init) return undefined;
  const p = normalize(path.startsWith('/') ? path : `${dirname(init.entry)}/${path}`);
  for (const key of [path, p]) if (init.assets && Object.hasOwn(init.assets, key)) return init.assets[key];
  if (!Object.hasOwn(modules, p)) return undefined;
  const m = load(p) as { default?: unknown } | string;
  const url = typeof m === 'string' ? m : m?.default;
  return typeof url === 'string' ? url : undefined;
}

// ---- mounting ----
class ErrorBoundary extends Component<{ children?: ReactNode }, { error: unknown }> {
  override state = { error: null as unknown };
  static getDerivedStateFromError(error: unknown) { return { error }; }
  override componentDidCatch(error: unknown, _info: ErrorInfo) { reportError(error); }
  override render() {
    if (this.state.error === null) return this.props.children;
    return errorBox(this.state.error);
  }
}
function errorBox(error: unknown, where?: { file?: string; line?: number }) {
  const loc = where ?? locate(error);
  return h('div', { className: 'cx-error', role: 'alert' },
    h('b', null, 'This widget hit an error'),
    describe(error),
    loc.file ? h('div', null, h('code', null, `${loc.file}${loc.line ? `:${loc.line}` : ''}`)) : null);
}

function Shell({ children }: { children?: ReactNode }) {
  const { reducedMotion } = useSnapshot();
  useLayoutEffect(() => {
    committed = true;
    scheduleHeight();
  }, []);
  return h(MotionConfig, { reducedMotion: reducedMotion ? 'always' : 'user' }, children);
}

let root: Root | null = null;
let current: Init | null = null;

function pickComponent(exports: unknown): ComponentType<Record<string, unknown>> | undefined {
  const m = exports as Record<string, unknown> | ((...a: unknown[]) => unknown);
  const candidates = typeof m === 'function' ? [m] : [m?.default, m?.App];
  return candidates.find((c) => typeof c === 'function' || (typeof c === 'object' && c !== null && '$$typeof' in c)) as ComponentType<Record<string, unknown>> | undefined;
}

function mount(init: Init) {
  root?.unmount();
  root = createRoot(rootEl, {
    onUncaughtError: (error) => reportError(error),
    onCaughtError: () => {}, // reported by the boundary
  });
  modules = Object.assign(Object.create(null), init.modules ?? {});
  cache = new Map();
  factories = new Map();
  icons = init.icons ?? {};
  lucideModule = null;
  resetCodeRequests();
  let content: ReactNode;
  try {
    for (const [path, code] of Object.entries(modules)) define(path, code);
    const C = pickComponent(load(normalize(init.entry)));
    if (!C) throw Object.assign(new Error(`${init.entry} has no default export that is a React component (export default function App() {…})`), { cxFile: init.entry });
    const props: Record<string, unknown> = { ...(init.props ?? {}) };
    delete props.key;
    delete props.ref;
    content = h(ErrorBoundary, null, h(C, props));
  } catch (error) {
    const e = error as { cxFile?: string; cxLine?: number };
    const where = e?.cxFile ? { file: e.cxFile, line: e.cxLine } : undefined;
    reportError(error, where);
    content = errorBox(error, where);
  }
  root.render(h(Shell, null, content));
}

// ---- the bridge ----
function onInit(init: Init) {
  current = init;
  frozen = false;
  committed = false;
  loop = { excess: Number.NaN, reports: 0 };
  growthNotice?.remove();
  growthNotice = undefined;
  notices.delete(GROWTH_MESSAGE);
  lastHeight = -1;
  store.set({
    activeStep: init.activeStep ?? null, myAnchor: init.myAnchor ?? null, anchors: init.anchors ?? [],
    reducedMotion: !!init.reducedMotion, viewportHeight: Number(init.viewportHeight) || 800, codes: {},
  });
  if (init.theme) applyTheme(init.theme);
  restoreState(init.state ?? null);
  mount(init);
}

window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== parent || !e.data || typeof e.data !== 'object') return;
  const m = e.data as ToWidget;
  switch (m.type) {
    case 'ping': post({ type: 'pong', n: m.n }); break;
    case 'init': onInit(m as Init); break;
    case 'step': store.set({ activeStep: m.activeStep ?? null }); break;
    case 'anchors': store.set({ anchors: Array.isArray(m.anchors) ? m.anchors : [] }); break;
    case 'code': if (m.code && typeof m.code.anchor === 'string') store.set({ codes: { ...store.value.codes, [m.code.anchor]: m.code } }); break;
    case 'theme': applyTheme(m); break;
    case 'visible': setVisible(m.visible !== false); break;
    case 'viewport': store.set({ viewportHeight: Number(m.height) || store.value.viewportHeight }); break;
    case 'result': settle(m.id, m.ok); break;
    case 'saveState': flushState(true); break;
  }
});

connectSdk({ post, reportError: (message) => reportError(new Error(message)), asset: assetFor });
register('explainer', SDK, true);
post({ type: 'ready' });

// Widget frames (docs/WIDGETS-PLAN.md §3, §5.3, §6, §8). Each mounted widget is a sandboxed srcdoc frame
// (allow-scripts, opaque origin) laid over its placeholder in the content frame, in a layer inside the
// panel's scroller, so it scrolls with the text. The frame's document is a constant: its own CSP and the
// bootstrap, which answers `boot`; the panel then sends the library texts (`load`) and, on `ready`, the
// widget's compiled modules, props and state (`init`). Every message from a frame is checked against that
// frame's window and the schema, size-capped and rate-limited; navigation and focus need evidence that the
// reader is interacting with that widget (activation.ts).
import type { FromWebview, WidgetBuild, WidgetGate } from '../shared/protocol.ts';
import { MAX_WIDGETS } from '../shared/protocol.ts';
import type { FromWidget, ThemeKind, ToWidget, WidgetAnchor, WidgetCode } from '../shared/widget-protocol.ts';
import { fromWidgetSchema } from '../shared/widget-protocol.ts';
import { ActivationEvidence, ENTRY_PX, rayEntry, type Box } from './activation.ts';
import { MAX_WIDGET_PROPS, WIDGET_PROPS_ATTR } from './sanitize.ts';
import { widgetSrcdoc } from './trusted.ts';
import { WidgetStates, type SavedWidgetStates } from '../shared/widget-state.ts';

/** What the frame host needs from the panel (main.ts). */
export interface WidgetPanel {
  post(m: FromWebview): void;
  /** The content frame's iframe and document (the frame is rebuilt now and then). */
  contentFrame(): HTMLIFrameElement;
  contentDoc(): Document;
  contentRoot(): HTMLElement;
  scroller: HTMLElement;
  layer: HTMLElement;
  bar: HTMLElement;
  /** Marks elements this script made inside the content (see main.ts BOX_TOKEN). */
  boxToken: string;
  /** The explainer shown (its folder URI). */
  dir(): string;
  /** The active anchor. */
  active(): string | undefined;
  /** The section of the current step, for `highlight`. */
  activeStepEl(): HTMLElement | undefined;
  anchors(): WidgetAnchor[];
  sectionEl(id: string): HTMLElement | null;
  /** A click or focus inside a widget makes its section current, without scrolling. */
  touchSection(id: string): void;
  goToStep(id: string): boolean;
  step(delta: 1 | -1): void;
  back(): boolean;
  readerInput(): void;
  /** Scrolls by `dy` without the scroll picking a step. */
  compensate(dy: number): void;
  /** Focuses an element in the content as the panel's own move (it doesn't pick a step). */
  focusSelf(el: HTMLElement): void;
  announce(text: string): void;
  /** The panel's saved state slice for widgets. */
  saved(): SavedWidgets | undefined;
  save(s: SavedWidgets): void;
  /** Panel y (viewport coordinates) of the reading line. */
  readingLine(): number;
}

export interface SavedWidgets {
  states?: SavedWidgetStates;
  /** Last heights by `<dir>\n<key>`, oldest first. */
  heights?: [string, number][];
  /** The one-time "Esc leaves the widget" hint was shown. */
  hinted?: boolean;
}

type Status = 'off' | 'idle' | 'hidden' | 'loading' | 'live' | 'error';

interface Limit {
  times: number[];
  timer?: ReturnType<typeof setTimeout>;
  latest?: FromWidget;
}

interface Widget {
  key: string;
  /** The explainer it belongs to (its state and heights are filed under it, also while it leaves). */
  dir: string;
  src: string;
  title: string;
  props: string | null;
  anchor: string | null;
  index: number;
  el: HTMLElement;
  /** Height of the widget's area, in px. */
  height: number;
  status: Status;
  /** `action`: what the box offers besides the fallback (the watchdog's Try again, or restarting a widget the panel stopped). */
  error?: { message: string; where?: string; action?: 'retry' | 'restart' };
  /** A problem shown as a badge while the widget keeps running (a runtime error, a failed recompile). */
  badge?: string;
  showFallback: boolean;
  frame?: HTMLIFrameElement;
  /** The "Interactive" label drawn in the panel's own layer over the placeholder's bar, while mounted. */
  label?: HTMLElement;
  win?: Window | null;
  build?: WidgetBuild;
  loads: number;
  resets: number;
  booted: boolean;
  initSent: boolean;
  live: boolean;
  visible?: boolean;
  lastPong: number;
  pingN: number;
  thefts: number;
  /** When the frame last said the reader pressed a pointer or key in it (its own claim: never allows anything). */
  lastInput?: number;
  pendingHeight?: number;
  heightTimer?: ReturnType<typeof setTimeout>;
  lastHeightAt: number;
  unmounting?: ReturnType<typeof setTimeout>;
  remount: boolean;
  limits: Map<string, Limit>;
  codeAnchors: Set<string>;
  logged: Set<string>;
  messages: number[];
  lastStep?: string | null;
  lastAnchors?: string;
  /** The frame's visible box (frame ∩ clipping ∩ the scroller's viewport), panel coordinates; null: not visible. */
  vis?: Box | null;
  /** Placement and clipping, measured on layout changes (not on every scroll frame); content-frame coordinates. */
  layout?: { place: Placement; clip: Box; outer: Box; box: { left: number; top: number; width: number; height: number }; rect: { top: number; bottom: number } };
}

const MAX_MOUNTED = 8;
const DEFAULT_HEIGHT = 240;
const PING_MS = 1000;
const PONG_TIMEOUT_MS = 3000;
const HEARTBEAT_MS = 1000;
const FOCUS_POLL_MS = 200;
const MEASURE_MS = 500;
const SAVE_WAIT_MS = 300;
const HEIGHT_THROTTLE_MS = 100;
const STATE_SAVE_MS = 1000;
const HEIGHTS_SAVE_MS = 1000;
const MAX_HEIGHTS = 200;
const MAX_MESSAGE_CHARS = 80_000;
const MAX_MESSAGES_PER_SECOND = 200;
const MAX_FOCUS_THEFTS = 3;
/** A refusal counts against a widget only when its frame reported no input of its own this close to it. */
const INPUT_CLAIM_MS = 1500;
/** How long a refusal waits for that report (with site isolation it can arrive after focus did). */
const CLAIM_WAIT_MS = 400;
const MAX_RESETS = 2;
const MAX_LOGS_PER_WIDGET = 20;
const HINT_MS = 4000;
/** A ping interval firing this much later than due means the panel itself was paused (sleep, debugger). */
const PING_DRIFT_MS = 2000;
const BAR_PX = 22;
/** Calls per second: highlight is coalesced (the latest is delivered); navigation over the limit fails. */
const RATE = { highlight: 10, nav: 2, requestCode: 20 };
/** CSS properties whose animation or transition moves an element: the frame would lag behind. */
const GEOMETRY = /^(all|transform|translate|rotate|scale|top|left|right|bottom|inset|width|height|min-|max-|margin|padding|flex|grid|font-size|line-height|zoom|offset-)/;
/** Keys every keyframe has, which aren't animated properties. */
const KEYFRAME_META = new Set(['offset', 'computedOffset', 'easing', 'composite']);

const now = () => performance.now();

export class WidgetFrames {
  private readonly panel: WidgetPanel;
  private readonly widgets = new Map<string, Widget>();
  private gate: WidgetGate = { status: 'off', unconfirmed: null, disabled: [], heights: {} };
  private readonly builds = new Map<string, WidgetBuild | null>();
  private readonly compiling = new Set<string>();
  private readonly libs = new Map<string, string>();
  private readonly libsRequested = new Set<string>();
  private readonly codes = new Map<string, WidgetCode>();
  private readonly codeRequested = new Set<string>();
  private readonly states: WidgetStates;
  private readonly heights: Map<string, number>;
  private readonly evidence = new ActivationEvidence();
  private hinted: boolean;
  /** Which widget frame holds focus, and whether it got there legitimately (judged once, on arrival). */
  private owner: { frame: HTMLIFrameElement; legit: boolean } | undefined;
  private hadFocus = document.hasFocus();
  private lastTheftAt = -Infinity;
  private pointerDown = false;
  private highlighted = false;
  private lastActive: string | null | undefined;
  private frameScheduled = 0;
  /** Layout may have changed since placement was last measured (anything but a plain scroll). */
  private layoutDirty = true;
  private lastPingAt = 0;
  private themeKey = '';
  /** Widgets of the explainer the panel just left, still saving their state. */
  private readonly departing = new Set<Widget>();
  private measureTimer: ReturnType<typeof setInterval> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private focusTimer: ReturnType<typeof setInterval> | undefined;
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatDue = 0;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  /** Widget state to send the extension (which keeps it across reloads and closing the panel), by explainer and key. */
  private readonly statesToSend = new Map<string, Map<string, string>>();
  private statesTimer: ReturnType<typeof setTimeout> | undefined;
  private heightsTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly heightsToSend = new Map<string, number>();
  private unresponsiveReported = false;
  /** The widget whose frame is loading now, and the one that last did work: breadcrumbs for the watchdogs. */
  private mounting: Widget | undefined;
  private recent: Widget | undefined;
  private suspended = false;
  private placeholderObserver: ResizeObserver;
  private dupWarned = new Set<string>();
  private nextDescId = 1;
  private readonly descIds = new Map<string, string>();
  private readonly contentListeners: (() => void)[] = [];
  private readonly vp = () => ({ width: document.documentElement.clientWidth, height: document.documentElement.clientHeight });

  constructor(panel: WidgetPanel) {
    this.panel = panel;
    const saved = panel.saved();
    this.states = new WidgetStates(saved?.states);
    this.heights = new Map((saved?.heights ?? []).filter((e) => Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'number').slice(-MAX_HEIGHTS));
    this.hinted = saved?.hinted === true;
    this.placeholderObserver = new ResizeObserver(() => this.schedule());
    window.addEventListener('message', (e) => this.onMessage(e));
    for (const [type, fn] of [
      ['pointerdown', (e: Event) => this.onPointer(e as PointerEvent, document, true)],
      ['pointermove', (e: Event) => this.onPointer(e as PointerEvent, document, false)],
      ['pointerout', (e: Event) => this.onPointer(e as PointerEvent, document, false)],
      ['pointerup', () => this.onPointerUp()],
      ['pointercancel', () => this.onPointerUp()],
      // The pointer left the webview (pointerleave of the root; other elements' leaves also pass by here).
      ['pointerleave', (e: Event) => { if (e.target === document.documentElement && this.pointerDown) this.onPointerUp(); }],
      ['touchstart', () => this.evidence.gesture(now())],
      ['keydown', () => this.evidence.gesture(now())],
    ] as const) document.addEventListener(type, fn, { capture: true, passive: true });
    window.addEventListener('blur', () => setTimeout(() => {
      // Focus left the webview (not just into a frame of it): a pointer released out there sends no pointerup.
      if (this.pointerDown && !document.hasFocus()) this.onPointerUp();
      this.checkFocus();
    }));
    window.addEventListener('focus', () => {
      this.hadFocus = true;
    });
    document.addEventListener('visibilitychange', () => this.onVisibility());
    new ResizeObserver(() => {
      for (const w of this.widgets.values()) if (w.initSent) this.send(w, { type: 'viewport', height: this.panel.scroller.clientHeight });
      this.schedule();
    }).observe(panel.scroller);
    matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => this.onTheme());
    panel.bar.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'consent') panel.post({ type: 'widgetConsent' });
      else if (act === 'trust') panel.post({ type: 'widgetTrust' });
      else if (act === 'confirm') panel.post({ type: 'widgetConfirmAnchors' });
    });
  }

  // ---- the content frame ----

  /** Listeners on a (new) content frame document: gestures, pointer samples, placeholder keys and re-measuring. */
  bindContent(doc: Document): void {
    for (const off of this.contentListeners.splice(0)) off();
    const on = (target: EventTarget, type: string, fn: (e: Event) => void, opts: AddEventListenerOptions = { capture: true, passive: true }) => {
      target.addEventListener(type, fn, opts);
      this.contentListeners.push(() => target.removeEventListener(type, fn, opts));
    };
    on(doc, 'pointerdown', (e) => this.onPointer(e as PointerEvent, doc, true));
    on(doc, 'pointermove', (e) => this.onPointer(e as PointerEvent, doc, false));
    on(doc, 'pointerout', (e) => this.onPointer(e as PointerEvent, doc, false));
    on(doc, 'pointerup', () => this.onPointerUp());
    on(doc, 'pointercancel', () => this.onPointerUp());
    on(doc, 'touchstart', () => this.evidence.gesture(now()));
    on(doc, 'keydown', () => this.evidence.gesture(now()));
    // Anything that may change placement: an animation or transition starting, ending or being cancelled (a
    // live edit removing the CSS that ran it), images, <details>, scrolling boxes.
    for (const type of ['scroll', 'load', 'toggle', 'transitionrun', 'transitionend', 'transitioncancel', 'animationstart', 'animationend', 'animationcancel']) on(doc, type, () => this.schedule());
    on(doc, 'keydown', (e) => this.onPlaceholderKey(e as KeyboardEvent), { capture: false });
    on(doc, 'click', (e) => this.onPlaceholderClick(e as MouseEvent), { capture: false });
    const fonts = (doc as Document & { fonts?: FontFaceSet }).fonts;
    if (fonts) on(fonts, 'loadingdone', () => this.schedule());
  }

  private onPointer(e: PointerEvent, doc: Document, down: boolean): void {
    let x = e.clientX;
    let y = e.clientY;
    if (doc !== document) {
      const r = this.panel.contentFrame().getBoundingClientRect();
      x += r.left;
      y += r.top;
    }
    if (down) {
      this.pointerDown = true;
      this.evidence.gesture(now(), { x, y });
    } else this.evidence.sample({ x, y, t: now(), ...this.aim(x, y) });
  }

  /**
   * The mounted widget frame this panel point is on, or that the pointer is heading into within ENTRY_PX
   * (from the previous sample; with site isolation the last sample the panel gets is just outside the
   * frame it entered). Judged on the frames' visible boxes now, as last positioned.
   */
  private aim(x: number, y: number): { hit?: HTMLIFrameElement; toward: HTMLIFrameElement[]; reach: number } {
    const prev = this.evidence.last();
    const reach = ENTRY_PX;
    const view = this.panel.scroller.getBoundingClientRect();
    let best: { f: HTMLIFrameElement; d: number } | undefined;
    const toward: HTMLIFrameElement[] = [];
    for (const w of this.widgets.values()) {
      if (!w.frame || !w.vis) continue;
      // Where the frame is now, clipped as last measured (both axes), within the scroller's viewport.
      const r = w.frame.getBoundingClientRect();
      const clip = w.layout!.clip;
      const c = this.panel.contentFrame().getBoundingClientRect();
      const b: Box = {
        left: Math.max(r.left, c.left + clip.left, view.left), top: Math.max(r.top, c.top + clip.top, view.top),
        right: Math.min(r.right, c.left + clip.right, view.right), bottom: Math.min(r.bottom, c.top + clip.bottom, view.bottom),
      };
      if (b.right <= b.left || b.bottom <= b.top) continue;
      const d = x >= b.left && x <= b.right && y >= b.top && y <= b.bottom ? 0 : prev ? rayEntry(prev, { x, y }, b) : undefined;
      if (d === undefined) continue;
      toward.push(w.frame);
      if (d <= reach && (!best || d < best.d)) best = { f: w.frame, d };
    }
    return { hit: best?.f, toward, reach };
  }

  private onPointerUp(): void {
    this.pointerDown = false;
    for (const w of this.widgets.values()) if (w.pendingHeight !== undefined) this.applyHeight(w);
  }

  // ---- placeholders ----

  /** Placeholders in document order with their keys: `id`, else enclosing anchor + src + index there. */
  private placeholders(root: ParentNode): { el: HTMLElement; key: string; src: string; anchor: string | null }[] {
    const seen = new Map<string, number>();
    return [...root.querySelectorAll<HTMLElement>('explain-widget')].map((el) => {
      const src = el.getAttribute('src') ?? '';
      const anchor = el.closest<HTMLElement>('[data-explain-anchor]')?.dataset.explainAnchor ?? null;
      const id = el.getAttribute('id');
      let key: string;
      if (id) key = `#${id.length > 100 ? `${id.slice(0, 60)}~${hash(id)}` : id}`;
      else {
        const base = `${anchor ?? ''}|${src}`;
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        key = `${base.length > 200 ? `${base.slice(0, 160)}~${hash(base)}` : base}|${n}`;
        if (n === 1 && !this.dupWarned.has(base)) {
          this.dupWarned.add(base);
          this.panel.post({ type: 'widgetLog', src, level: 'warn', message: `Two widgets with src "${src}" in "${anchor ?? '(no section)'}" have no id: give each an id so their state stays with them.` });
        }
      }
      return { el, key, src, anchor };
    });
  }

  /** Decorates placeholders (on the incoming tree before a morph, and on the live one): attributes, label, error box. */
  decorate(root: ParentNode): void {
    const doc = this.panel.contentDoc();
    for (const { el, key, src } of this.placeholders(root)) {
      const w = this.widgets.get(key);
      const title = (el.getAttribute('title') ?? '').trim() || src.split('/').pop() || 'Widget';
      el.setAttribute('data-cx-w', key);
      el.tabIndex = 0;
      el.setAttribute('role', 'group');
      el.setAttribute('aria-label', `${title} (interactive)`);
      const status: Status = w?.status ?? (this.gate.status === 'on' && src ? 'idle' : 'off');
      el.setAttribute('data-cx-wstate', status);
      el.toggleAttribute('data-cx-showfb', w?.showFallback ?? false);
      el.style.setProperty('--cx-wh', `${w?.height ?? this.initialHeight(el, key)}px`);
      pinBox(el, status, w?.showFallback ?? false);
      const own = (cls: string) => [...el.children].find((c) => c.getAttribute('data-cx-box') === this.panel.boxToken && c.classList.contains(cls)) as HTMLElement | undefined;
      const make = (tag: string, cls: string) => {
        const x = doc.createElement(tag);
        x.className = cls;
        x.setAttribute('data-cx-box', this.panel.boxToken);
        return x;
      };
      let bar = own('cx-widget-bar');
      if (!bar) {
        bar = make('div', 'cx-widget-bar');
        bar.setAttribute('aria-hidden', 'true');
        for (const cls of ['cx-widget-tag', 'cx-widget-name', 'cx-widget-note']) bar.append(make('span', cls));
        el.prepend(bar);
      }
      pinLabel(bar);
      setText(bar.querySelector('.cx-widget-tag')!, 'Interactive');
      setText(bar.querySelector('.cx-widget-name')!, title);
      setText(bar.querySelector('.cx-widget-note')!, w?.badge ?? (status === 'off' ? this.offNote() : ''));
      // The fallback, for screen readers while the widget is live (it is visually hidden then).
      let desc = own('cx-widget-desc');
      if (!desc) {
        desc = make('div', 'cx-widget-desc');
        desc.hidden = true;
        el.append(desc);
      }
      let id = this.descIds.get(key);
      if (!id) this.descIds.set(key, (id = `cx-wd-${this.nextDescId++}`));
      desc.id = id;
      setText(desc, fallbackText(el, this.panel.boxToken));
      if (desc.textContent) el.setAttribute('aria-describedby', id);
      else el.removeAttribute('aria-describedby');
      let err = own('cx-widget-error');
      if (!err) {
        err = make('div', 'cx-widget-error');
        err.setAttribute('role', 'alert');
        const text = make('span', 'cx-widget-error-text');
        const where = make('code', 'cx-widget-error-where');
        const buttons = make('div', 'cx-widget-actions');
        const act = make('button', 'cx-widget-action') as HTMLButtonElement;
        act.type = 'button';
        const fb = make('button', 'cx-widget-fallback') as HTMLButtonElement;
        fb.type = 'button';
        fb.textContent = 'Show fallback';
        buttons.append(act, fb);
        err.append(text, where, buttons);
        el.append(err);
      }
      const act = err.querySelector<HTMLButtonElement>('.cx-widget-action');
      if (act) {
        const label = w?.error?.action === 'retry' ? 'Try again' : w?.error?.action === 'restart' ? 'Restart widget' : '';
        setText(act, label);
        act.hidden = !label;
      }
      setText(err.querySelector('.cx-widget-error-text')!, w?.error?.message ?? '');
      setText(err.querySelector('.cx-widget-error-where')!, w?.error?.where ?? '');
      syncErrorBox(err, w, status);
      if (w) this.syncLabelNote(w);
    }
  }

  private offNote(): string {
    return this.gate.status === 'untrusted' ? 'not run in Restricted Mode' : this.gate.status === 'ask' ? 'not running yet' : 'not running';
  }

  private initialHeight(el: HTMLElement, key: string): number {
    const cached = this.heights.get(`${this.panel.dir()}\n${key}`) ?? this.gate.heights[key];
    if (cached) return cached;
    const aspect = /^\s*(\d+(?:\.\d+)?)\s*(?:\/\s*(\d+(?:\.\d+)?))?\s*$/.exec(el.getAttribute('aspect') ?? '');
    if (aspect) {
      const ratio = Number(aspect[1]) / Number(aspect[2] ?? 1);
      const width = el.clientWidth || this.panel.contentRoot().clientWidth - 40;
      if (ratio > 0 && width > 0) return Math.min(2000, Math.max(40, Math.round(width / ratio)));
    }
    const h = Number(el.getAttribute('height'));
    return Number.isFinite(h) && h >= 20 && h <= 5000 ? Math.round(h) : DEFAULT_HEIGHT;
  }

  /** After every render: match placeholders to widgets, drop the ones gone, remount changed ones, re-measure. */
  refresh(): void {
    const found = this.placeholders(this.panel.contentRoot());
    const keys = new Set(found.map((f) => f.key));
    for (const [key, w] of this.widgets) {
      if (keys.has(key)) continue;
      this.unmount(w, true);
      this.widgets.delete(key);
    }
    this.placeholderObserver.disconnect();
    found.forEach(({ el, key, src, anchor }, index) => {
      const props = el.getAttribute(WIDGET_PROPS_ATTR);
      const title = (el.getAttribute('title') ?? '').trim() || src.split('/').pop() || 'Widget';
      let w = this.widgets.get(key);
      if (!w) {
        w = {
          key, dir: this.panel.dir(), src, title, props, anchor, index, el, height: this.initialHeight(el, key), status: 'idle', showFallback: false,
          loads: 0, resets: 0, booted: false, initSent: false, live: false, lastPong: 0, pingN: 0, thefts: 0, lastHeightAt: 0,
          remount: false, limits: new Map(), codeAnchors: new Set(), logged: new Set(), messages: [],
        };
        this.widgets.set(key, w);
      } else if (w.src !== src || w.props !== props) {
        // A live edit of the HTML that changed what this widget is: start it again, with its state.
        w.src = src;
        w.props = props;
        w.error = undefined;
        w.badge = undefined;
        w.resets = 0;
        w.thefts = 0;
        if (w.status === 'error') w.status = 'idle';
        if (w.frame) {
          w.remount = true;
          this.unmount(w, true);
        }
      }
      w.el = el;
      w.title = title;
      w.anchor = anchor;
      w.index = index;
      if (w.frame) w.frame.title = title;
      this.placeholderObserver.observe(el);
    });
    this.layoutDirty = true;
    this.renderBar();
    this.decorate(this.panel.contentRoot());
    this.schedule();
  }

  /** How many widgets the explainer shown has (for the consent bar). */
  get count(): number {
    return this.widgets.size;
  }

  // ---- what the extension says ----

  setGate(gate: WidgetGate): void {
    const was = this.gate;
    this.gate = gate;
    // A new gate (what may run changed) ends a watchdog suspension: it already says what is turned off.
    if (gate.status !== was.status || gate.stopped !== was.stopped || gate.disabled.join('\n') !== was.disabled.join('\n')) this.suspended = false;
    for (const [k, v] of Object.entries(gate.heights)) if (!this.heights.has(`${this.panel.dir()}\n${k}`)) this.heights.set(`${this.panel.dir()}\n${k}`, v);
    if (gate.status !== 'on' && was.status === 'on') for (const w of this.widgets.values()) this.unmount(w, true);
    // A refusal answered a request made under an older gate (say, the extension hadn't seen a live edit's new
    // widget yet): ask again under this one.
    for (const [src, b] of this.builds) if (b === null) this.builds.delete(src);
    for (const w of this.widgets.values()) {
      if (gate.disabled.includes(w.src)) {
        this.unmount(w, true);
        this.fail(w, gate.stopped
          ? "This sidestory's widgets kept freezing the panel, so they were stopped."
          : 'This widget was turned off because it stopped responding.', undefined, 'retry');
      } else if ((was.disabled.includes(w.src) || was.stopped) && w.status === 'error') {
        w.error = undefined;
        w.status = 'idle';
      }
    }
    this.renderBar();
    this.decorate(this.panel.contentRoot());
    this.schedule();
  }

  /** A compiled widget (or a refusal). A failed recompile keeps the last good version running, with a badge. */
  onBuild(src: string, build: WidgetBuild | null): void {
    this.compiling.delete(src);
    const before = this.builds.get(src);
    const good = (b: WidgetBuild | null | undefined) => !!b && b.errors.length === 0;
    if (build && !good(build) && good(before)) {
      for (const w of this.widgets.values()) {
        if (w.src !== src) continue;
        const e = build.errors[0]!;
        // Readers get a short note; the error itself is the author's (Output, the Problems panel).
        w.badge = 'compile error; the last good version runs (details in Output)';
        this.log(w, 'error', `${place(e)}: ${e.message}`);
      }
      this.decorate(this.panel.contentRoot());
      return;
    }
    this.builds.set(src, build);
    for (const w of this.widgets.values()) {
      if (w.src !== src) continue;
      w.badge = undefined;
      if (w.status === 'error') {
        w.error = undefined;
        w.status = 'idle';
      }
      if (w.frame && w.build?.hash !== build?.hash) {
        w.remount = true;
        this.unmount(w, true);
      }
    }
    this.decorate(this.panel.contentRoot());
    this.schedule();
  }

  onLibs(libs: Record<string, string>): void {
    for (const [id, text] of Object.entries(libs)) if (typeof text === 'string') this.libs.set(id, text);
    this.schedule();
  }

  /** Code is answered per widget source: the extension serves each widget only the anchors it reads. */
  onCode(src: string, code: WidgetCode): void {
    this.codes.set(`${src}\n${code.anchor}`, code);
    for (const w of this.widgets.values()) if (w.src === src && w.codeAnchors.has(code.anchor)) this.send(w, { type: 'code', code });
  }

  /** The watchdog: remove every frame now (no state is asked of a hung widget), or mount again. */
  reset(phase: 'unmount' | 'remount'): void {
    this.suspended = phase === 'unmount';
    this.unresponsiveReported = false;
    if (this.suspended) {
      for (const w of this.widgets.values()) this.unmount(w, false);
      // Mounting again asks for every build afresh, so the extension can refuse the ones it turned off.
      this.builds.clear();
      this.compiling.clear();
    } else {
      for (const w of this.widgets.values()) w.lastPong = now();
      this.schedule();
    }
  }

  /** Another explainer is shown (dive or back): unmount everything (asking for state) and forget its builds. */
  switchExplainer(): void {
    for (const w of this.widgets.values()) {
      this.unmount(w, true);
      // Still saving its state (filed under its own explainer): its reply is accepted until it is removed.
      if (w.frame) this.departing.add(w);
    }
    this.widgets.clear();
    // Heights are filed by the extension under the explainer shown when they arrive: that's the new one now.
    clearTimeout(this.heightsTimer);
    this.heightsTimer = undefined;
    this.heightsToSend.clear();
    this.builds.clear();
    this.compiling.clear();
    this.codes.clear();
    this.codeRequested.clear();
    this.dupWarned.clear();
    this.descIds.clear();
    this.evidence.reset();
    this.suspended = false;
    this.owner = undefined;
    this.highlighted = false;
    this.lastActive = undefined;
    this.gate = { status: 'off', unconfirmed: null, disabled: [], heights: {} };
    this.renderBar();
  }

  /** The active section changed: clear highlights first, so a widget highlighting in response to `step` sticks. */
  onActive(active: string | undefined): void {
    const a = active ?? null;
    if (a === this.lastActive) return;
    this.lastActive = a;
    // A highlight still waiting in the rate limit belongs to the step being left.
    for (const w of this.widgets.values()) {
      const l = w.limits.get('highlight');
      if (l) l.latest = undefined;
    }
    if (this.highlighted) {
      this.highlighted = false;
      this.panel.post({ type: 'widgetHighlight' });
    }
    for (const w of this.widgets.values()) if (w.initSent && w.lastStep !== a) {
      w.lastStep = a;
      this.send(w, { type: 'step', activeStep: a });
    }
  }

  /** Anchor states or locations changed. */
  onAnchors(): void {
    const anchors = this.panel.anchors();
    const json = JSON.stringify(anchors);
    for (const w of this.widgets.values()) if (w.initSent && w.lastAnchors !== json) {
      w.lastAnchors = json;
      this.send(w, { type: 'anchors', anchors });
    }
  }

  /** Theme variables, classes or reduced motion may have changed: widgets hear only of real changes. */
  onTheme(): void {
    const t = theme();
    const key = JSON.stringify(t);
    if (key === this.themeKey) return;
    this.themeKey = key;
    for (const w of this.widgets.values()) if (w.initSent) this.send(w, { type: 'theme', ...t });
  }

  /** The panel scrolled (in its own requestAnimationFrame). */
  onScroll(): void {
    this.update();
  }

  /** Answers the extension's focus question (the panel just became active). */
  focusAnswer(id: number): void {
    this.checkFocus();
    const w = this.frameOwner(document.activeElement);
    const legit = now() - this.lastTheftAt > 1500 && (!w || this.owner?.legit === true);
    this.panel.post({ type: 'focusAnswer', id, legit });
  }

  // ---- the consent bar (panel chrome, not content) ----

  private renderBar(): void {
    const bar = this.panel.bar;
    const n = this.widgets.size;
    const g = this.gate;
    const parts: { text: string; act?: string; label?: string }[] = [];
    const what = `This sidestory has ${n} interactive widget${n === 1 ? '' : 's'}`;
    if (n && g.status === 'untrusted') parts.push({ text: `${what}. Widgets don't run in Restricted Mode.`, act: 'trust', label: 'Trust workspace…' });
    else if (n && g.status === 'ask') parts.push({ text: `${what}: code from this repository that runs in the panel.`, act: 'consent', label: 'Run widgets…' });
    else if (n && g.status === 'on' && g.unconfirmed) parts.push({ text: `Widgets here want to read code that hasn't been confirmed.`, act: 'confirm', label: `Let widgets read ${g.unconfirmed.anchors} anchor${g.unconfirmed.anchors === 1 ? '' : 's'} (${g.unconfirmed.summary})…` });
    const key = JSON.stringify(parts);
    if (bar.dataset.key === key) return;
    bar.dataset.key = key;
    bar.replaceChildren();
    bar.hidden = parts.length === 0;
    for (const p of parts) {
      const icon = document.createElement('span');
      icon.className = 'codicon codicon-play-circle';
      icon.setAttribute('aria-hidden', 'true');
      const text = document.createElement('span');
      text.className = 'cx-consent-text';
      text.textContent = p.text;
      bar.append(icon, text);
      if (p.act) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'cx-consent-button';
        b.dataset.act = p.act;
        b.textContent = p.label!;
        bar.append(b);
      }
    }
  }

  // ---- placement and mounting ----

  /** One measuring pass per animation frame, whatever asked for it. */
  schedule(): void {
    this.layoutDirty = true;
    if (this.frameScheduled) return;
    this.frameScheduled = requestAnimationFrame(() => {
      this.frameScheduled = 0;
      this.update();
    });
  }

  private update(): void {
    // Placement and clipping are in content-frame coordinates, which scrolling doesn't change: a plain scroll
    // frame only does arithmetic.
    const remeasure = this.layoutDirty;
    this.layoutDirty = false;
    const scroller = this.panel.scroller;
    const view = scroller.getBoundingClientRect();
    const content = this.panel.contentFrame().getBoundingClientRect();
    const contentTop = content.top;
    const near: { w: Widget; distance: number }[] = [];
    const win = this.panel.contentDoc().defaultView!;
    for (const w of this.widgets.values()) {
      if (w.unmounting) continue;
      if (this.gate.status !== 'on') {
        this.unmount(w, true);
        this.setStatus(w, 'off');
        continue;
      }
      if (this.suspended) continue;
      if (!w.src) {
        if (w.status !== 'error') this.fail(w, "This widget's src isn't a widget file in the sidestory folder.");
        continue;
      }
      if (this.gate.disabled.includes(w.src)) continue;
      if (w.index >= MAX_WIDGETS) {
        if (w.status !== 'error') this.fail(w, `This sidestory has more than ${MAX_WIDGETS} widgets; only the first ${MAX_WIDGETS} run.`);
        continue;
      }
      if (remeasure || !w.layout) w.layout = this.measure(w, win);
      const place = w.layout.place;
      if (place.kind === 'hidden') {
        this.unmount(w, true);
        if (w.status !== 'error') this.setStatus(w, 'hidden');
        continue;
      }
      if (place.kind === 'unsupported') {
        this.unmount(w, true);
        if (w.error?.message !== place.reader) {
          this.fail(w, place.reader);
          this.log(w, 'error', `${w.src}: ${place.author}`);
        }
        continue;
      }
      if (w.status === 'error' && w.error?.message.startsWith("This widget can't be shown")) {
        w.error = undefined; // the problem went away (say, the panel got wider)
        this.setStatus(w, 'idle');
      }
      if (w.status === 'error') continue;
      if (w.status === 'hidden' || w.status === 'off') this.setStatus(w, 'idle');
      const top = contentTop + w.layout.rect.top;
      const bottom = contentTop + w.layout.rect.bottom;
      const distance = bottom < view.top ? view.top - bottom : top > view.bottom ? top - view.bottom : 0;
      if (distance <= view.height) near.push({ w, distance });
      else this.unmount(w, true);
    }
    near.sort((a, b) => a.distance - b.distance || a.w.index - b.w.index);
    near.slice(MAX_MOUNTED).forEach(({ w }) => this.unmount(w, true));
    for (const { w } of near.slice(0, MAX_MOUNTED)) {
      if (!w.frame) this.mount(w);
      if (w.frame) this.position(w, content, view);
    }
    for (const w of this.widgets.values()) if (!w.frame) w.vis = undefined;
    this.timers();
  }

  /** Placement, the placeholder's box and the frame's clip, in content-frame coordinates. */
  private measure(w: Widget, win: Window): NonNullable<Widget['layout']> {
    const place = placement(w.el, win);
    const r = w.el.getBoundingClientRect();
    const rect = { top: r.top, bottom: r.bottom };
    const none = { left: 0, top: 0, right: 0, bottom: 0 };
    if (place.kind !== 'ok') return { place, clip: none, outer: none, box: { left: 0, top: 0, width: 0, height: 0 }, rect };
    const cs = win.getComputedStyle(w.el);
    const left = r.left + px(cs.borderLeftWidth) + px(cs.paddingLeft);
    const top = r.top + px(cs.borderTopWidth) + px(cs.paddingTop);
    const right = r.right - px(cs.borderRightWidth) - px(cs.paddingRight);
    const bottom = r.bottom - px(cs.borderBottomWidth) - px(cs.paddingBottom);
    const doc = this.panel.contentDoc().documentElement;
    // Never outside the placeholder's own content box (author CSS may shrink the placeholder), the clipping
    // ancestors, or the content frame.
    let clip: Box = { left: Math.max(0, left), top: Math.max(0, top), right: Math.min(doc.clientWidth, right), bottom: Math.min(this.panel.contentFrame().clientHeight, bottom) };
    // The label's area (the placeholder's bar) is clipped by the same ancestors, not by the content box.
    let outer: Box = { left: 0, top: 0, right: doc.clientWidth, bottom: this.panel.contentFrame().clientHeight };
    for (const c of clipBoxes(w.el, win)) {
      clip = { left: Math.max(clip.left, c.left), top: Math.max(clip.top, c.top), right: Math.min(clip.right, c.right), bottom: Math.min(clip.bottom, c.bottom) };
      outer = { left: Math.max(outer.left, c.left), top: Math.max(outer.top, c.top), right: Math.min(outer.right, c.right), bottom: Math.min(outer.bottom, c.bottom) };
    }
    return { place, clip, outer, box: { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }, rect };
  }

  /** The frame over the placeholder's content box, clipped to it, to clipping ancestors and the content frame. */
  private position(w: Widget, content: DOMRect, view: DOMRect): void {
    const f = w.frame!;
    const { box, clip } = w.layout!;
    const { left, top, width } = box;
    const height = w.height;
    const set = (k: string, v: string) => {
      if (f.style.getPropertyValue(k) !== v) f.style.setProperty(k, v);
    };
    set('left', `${left}px`);
    set('top', `${top}px`);
    set('width', `${width}px`);
    set('height', `${height}px`);
    const inset = [Math.max(0, clip.top - top), Math.max(0, left + width - clip.right), Math.max(0, top + height - clip.bottom), Math.max(0, clip.left - left)];
    const empty = clip.right <= clip.left || clip.bottom <= clip.top || inset[0]! >= height || inset[3]! >= width;
    set('clip-path', inset.every((x) => x === 0) ? '' : `inset(${inset.map((x) => `${x}px`).join(' ')})`);
    set('visibility', empty ? 'hidden' : '');
    // What the reader can see of it, in panel coordinates (activation is credited only there).
    const vis: Box = {
      left: Math.max(view.left, content.left + Math.max(left, clip.left)),
      top: Math.max(view.top, content.top + Math.max(top, clip.top)),
      right: Math.min(view.right, content.left + Math.min(left + width, clip.right)),
      bottom: Math.min(view.bottom, content.top + Math.min(top + height, clip.bottom)),
    };
    w.vis = !empty && vis.right > vis.left && vis.bottom > vis.top ? vis : null;
    this.positionLabel(w);
    const visible = w.vis !== null && document.visibilityState === 'visible';
    if (visible !== w.visible) {
      w.visible = visible;
      if (w.initSent) this.send(w, { type: 'visible', visible });
    }
  }

  /** The label, as panel chrome: over the placeholder's bar, the frame's width, clipped like the frame. */
  private positionLabel(w: Widget): void {
    const { box, outer } = w.layout!;
    if (!w.label) {
      const label = document.createElement('div');
      label.className = 'cx-widget-label';
      label.setAttribute('aria-hidden', 'true');
      const tag = document.createElement('span');
      tag.className = 'cx-widget-label-tag';
      tag.textContent = 'Interactive';
      const name = document.createElement('span');
      name.className = 'cx-widget-label-name';
      const note = document.createElement('span');
      note.className = 'cx-widget-label-note';
      label.append(tag, name, note);
      this.panel.layer.append(label);
      w.label = label;
    }
    const l = w.label;
    setText(l.querySelector('.cx-widget-label-name')!, w.title);
    this.syncLabelNote(w);
    const left = box.left;
    const top = box.top - BAR_PX;
    const set = (k: string, v: string) => {
      if (l.style.getPropertyValue(k) !== v) l.style.setProperty(k, v);
    };
    set('left', `${left}px`);
    set('top', `${top}px`);
    set('width', `${box.width}px`);
    set('height', `${BAR_PX}px`);
    const inset = [Math.max(0, outer.top - top), Math.max(0, left + box.width - outer.right), Math.max(0, top + BAR_PX - outer.bottom), Math.max(0, outer.left - left)];
    const empty = outer.right <= outer.left || outer.bottom <= outer.top || inset[0]! + inset[2]! >= BAR_PX || inset[1]! + inset[3]! >= box.width;
    set('clip-path', inset.every((x) => x === 0) ? '' : `inset(${inset.map((x) => `${x}px`).join(' ')})`);
    set('visibility', empty || w.frame?.style.visibility === 'hidden' ? 'hidden' : '');
  }

  /** The label shows the content bar's note too (error badges, the Esc hint): it covers that bar. */
  private syncLabelNote(w: Widget): void {
    const note = w.label?.querySelector<HTMLElement>('.cx-widget-label-note');
    if (!note) return;
    setText(note, w.el.querySelector(':scope > .cx-widget-bar .cx-widget-note')?.textContent ?? '');
    note.classList.toggle('cx-error', !!w.badge || w.status === 'error');
  }

  private mount(w: Widget): void {
    if (w.unmounting) return;
    const build = this.builds.get(w.src);
    if (build === undefined) {
      this.setStatus(w, 'loading');
      if (!this.compiling.has(w.src)) {
        this.compiling.add(w.src);
        this.panel.post({ type: 'widgetCompile', src: w.src });
      }
      return;
    }
    if (build === null) {
      this.setStatus(w, 'off');
      return;
    }
    if (build.errors.length) {
      const e = build.errors[0]!;
      this.fail(w, e.message, place(e));
      this.log(w, 'error', `${place(e)}: ${e.message}`);
      return;
    }
    const missing = build.libraries.filter((id) => !this.libs.has(id));
    if (missing.length) {
      this.setStatus(w, 'loading');
      const ask = missing.filter((id) => !this.libsRequested.has(id));
      for (const id of ask) this.libsRequested.add(id);
      if (ask.length) this.panel.post({ type: 'widgetLibs', ids: ask });
      return;
    }
    const f = document.createElement('iframe');
    f.className = 'cx-widget-frame';
    f.setAttribute('sandbox', 'allow-scripts');
    // The placeholder is the tab stop (Enter goes in); the frame isn't in the panel's tab order.
    f.tabIndex = -1;
    f.title = w.title;
    f.srcdoc = widgetSrcdoc() as unknown as string;
    w.frame = f;
    w.build = build;
    w.loads = 0;
    w.booted = false;
    w.initSent = false;
    w.live = false;
    w.visible = undefined;
    w.lastPong = now();
    w.lastStep = undefined;
    w.lastAnchors = undefined;
    f.addEventListener('load', () => this.onFrameLoad(w, f));
    this.panel.layer.append(f);
    w.win = f.contentWindow;
    this.mounting = w;
    this.setStatus(w, 'loading');
  }

  private onFrameLoad(w: Widget, f: HTMLIFrameElement): void {
    if (w.frame !== f) return;
    if (++w.loads === 1) return;
    // A second load: the frame navigated (or tried to). It never gets code or state again: start over.
    this.log(w, 'error', `${w.src}: the widget's frame navigated; it was reset.`);
    this.unmount(w, false);
    if (++w.resets > MAX_RESETS) this.fail(w, 'This widget kept reloading itself, so it was stopped.', undefined, 'restart');
    this.schedule();
  }

  /** Removes a widget's frame; with `save`, asks for its state first (and waits a moment for it). */
  private unmount(w: Widget, save: boolean): void {
    if (!w.frame) {
      if (w.remount && !w.unmounting) {
        w.remount = false;
        this.schedule();
      }
      return;
    }
    if (save && w.initSent && !w.unmounting && w.loads <= 1) {
      this.send(w, { type: 'saveState' });
      w.frame.style.visibility = 'hidden';
      if (w.label) w.label.style.visibility = 'hidden';
      w.unmounting = setTimeout(() => this.remove(w), SAVE_WAIT_MS);
      return;
    }
    if (!save || !w.unmounting) this.remove(w);
  }

  private remove(w: Widget): void {
    clearTimeout(w.unmounting);
    clearTimeout(w.heightTimer);
    for (const l of w.limits.values()) clearTimeout(l.timer);
    w.limits.clear();
    w.unmounting = undefined;
    w.heightTimer = undefined;
    if (this.owner?.frame === w.frame) this.owner = undefined;
    w.frame?.remove();
    w.frame = undefined;
    w.label?.remove();
    w.label = undefined;
    w.win = undefined;
    w.build = undefined;
    w.booted = false;
    w.initSent = false;
    w.live = false;
    w.visible = undefined;
    w.vis = undefined;
    w.codeAnchors.clear();
    this.departing.delete(w);
    if (this.mounting === w) this.mounting = undefined;
    if (this.recent === w) this.recent = undefined;
    if (w.status === 'live' || w.status === 'loading') this.setStatus(w, 'idle');
    this.persistStates(false); // on unmount, now
    this.sendStates(true);
    if (w.remount) {
      w.remount = false;
      this.schedule();
    }
    this.timers();
  }

  private setStatus(w: Widget, status: Status): void {
    if (w.status === status) return;
    w.status = status;
    w.el.setAttribute('data-cx-wstate', status);
    pinBox(w.el, status, w.showFallback);
    // The error box follows: a problem that went away (placement fine again) leaves no note behind.
    const err = [...w.el.children].find((c) => c.getAttribute('data-cx-box') === this.panel.boxToken && c.classList.contains('cx-widget-error')) as HTMLElement | undefined;
    if (err) syncErrorBox(err, w, status);
    const note = w.el.querySelector<HTMLElement>(':scope > .cx-widget-bar .cx-widget-note');
    if (note && !w.badge) setText(note, status === 'off' ? this.offNote() : '');
    this.syncLabelNote(w);
  }

  /** Shows a problem in the widget's box (the reader sees the message; authors get details in Output). */
  private fail(w: Widget, message: string, where?: string, action?: 'retry' | 'restart'): void {
    w.error = { message, where, ...(action ? { action } : {}) };
    w.status = 'error';
    w.el.setAttribute('data-cx-wstate', 'error');
    this.decorate(this.panel.contentRoot());
  }

  // ---- messages from widget frames ----

  private onMessage(e: MessageEvent): void {
    // Widgets have the opaque origin; the host's messages (on the panel's origin) are main.ts's.
    if (e.origin !== 'null' || !e.source) return;
    let w: Widget | undefined;
    for (const x of [...this.widgets.values(), ...this.departing]) if (x.win && x.win === e.source) w = x;
    if (!w || !w.frame || w.loads > 1) return;
    const t = now();
    w.messages = w.messages.filter((m) => t - m < 1000);
    if (w.messages.push(t) > MAX_MESSAGES_PER_SECOND) {
      this.logOnce(w, 'flood', `${w.src}: more than ${MAX_MESSAGES_PER_SECOND} messages a second; extra messages are dropped.`);
      return;
    }
    let size = 0;
    try {
      size = JSON.stringify(e.data)?.length ?? 0;
    } catch {
      return;
    }
    if (size > MAX_MESSAGE_CHARS) {
      this.logOnce(w, 'oversize', `${w.src}: a message over ${MAX_MESSAGE_CHARS / 1000} KB was dropped.`);
      return;
    }
    const parsed = fromWidgetSchema.safeParse(e.data);
    if (!parsed.success) return;
    const m = parsed.data;
    if (m.type !== 'pong' && m.type !== 'height') this.recent = w;
    // Before judging focus: the frame's report of the reader's input, which may explain focus arriving.
    if (m.type === 'input') w.lastInput = t;
    this.checkFocus();
    switch (m.type) {
      case 'boot':
        if (w.booted) return;
        w.booted = true;
        this.send(w, { type: 'load', scripts: w.build!.libraries.map((id) => this.libs.get(id) ?? '') });
        break;
      case 'ready':
        if (!w.booted || w.initSent) return;
        this.sendInit(w);
        break;
      case 'pong':
        w.lastPong = t;
        break;
      case 'height':
        if (!w.initSent) return;
        w.pendingHeight = Math.max(1, Math.round(m.px));
        if (!w.live) {
          w.live = true;
          if (this.mounting === w) this.mounting = undefined;
          this.setStatus(w, 'live');
          this.applyHeight(w);
        } else if (!this.pointerDown) this.throttleHeight(w);
        break;
      case 'highlight':
        this.limited(w, 'highlight', m, true);
        break;
      case 'reveal':
      case 'step':
      case 'key':
        this.navigate(w, m);
        break;
      case 'state':
        if (!this.states.set(this.stateKey(w), m.json)) this.logOnce(w, 'state', `${w.src}: its state is over 64 KB and isn't saved.`);
        else this.queueState(w, m.json);
        this.persistStates(false);
        if (w.unmounting) this.remove(w);
        break;
      case 'error': {
        const where = m.file ? `${m.file}${m.line ? `:${m.line}` : ''}` : '';
        // Readers get a short note (a message like "highlight(): lines must be …" is for the author, in Output).
        w.badge = 'hit an error (details in Output)';
        this.decorate(this.panel.contentRoot());
        this.log(w, 'error', `${w.src}${where ? ` (${where})` : ''}: ${m.message}`);
        break;
      }
      case 'activity':
        this.panel.readerInput();
        break;
      case 'focusExit':
        this.focusExit(w, m.dir);
        break;
      case 'requestCode':
        this.limited(w, 'requestCode', m, false);
        break;
    }
  }

  private sendInit(w: Widget): void {
    const build = w.build!;
    let props: Record<string, unknown> = Object.create(null);
    if (w.props) {
      try {
        props = nullProto(JSON.parse(w.props)) as Record<string, unknown>;
        if (typeof props !== 'object' || props === null || Array.isArray(props)) throw new Error('props must be a JSON object');
      } catch (e) {
        const msg = (e as Error).message;
        const line = /line (\d+)/.exec(msg)?.[1] ?? (/position (\d+)/.exec(msg) ? String(w.props.slice(0, Number(/position (\d+)/.exec(msg)![1])).split('\n').length) : undefined);
        this.log(w, 'error', `${w.src}: props JSON${line ? ` (line ${line})` : ''}: ${msg}`);
        w.badge = `props aren't valid JSON${line ? ` (line ${line})` : ''}`;
        props = Object.create(null);
        this.decorate(this.panel.contentRoot());
      }
      if (w.props.length > MAX_WIDGET_PROPS) props = Object.create(null);
    }
    const active = this.panel.active() ?? null;
    w.lastStep = active;
    const anchors = this.panel.anchors();
    w.lastAnchors = JSON.stringify(anchors);
    w.initSent = true;
    this.send(w, {
      type: 'init',
      props,
      state: this.states.get(this.stateKey(w)),
      theme: theme(),
      viewportHeight: this.panel.scroller.clientHeight,
      activeStep: active,
      myAnchor: w.anchor,
      anchors,
      reducedMotion: reducedMotion(),
      entry: build.entry,
      modules: build.modules,
      icons: build.icons,
    });
    if (w.visible === false) this.send(w, { type: 'visible', visible: false });
  }

  private send(w: Widget, m: ToWidget): void {
    // Never to a frame that navigated: it might not be ours any more.
    if (!w.win || w.loads > 1) return;
    try {
      w.win.postMessage(m, '*');
    } catch {
      // the frame went away
    }
  }

  private stateKey(w: Widget): string {
    return `${w.dir}\n${w.key}`;
  }

  // ---- heights ----

  private throttleHeight(w: Widget): void {
    if (w.heightTimer) return;
    const wait = Math.max(0, w.lastHeightAt + HEIGHT_THROTTLE_MS - now());
    w.heightTimer = setTimeout(() => {
      w.heightTimer = undefined;
      if (!this.pointerDown) this.applyHeight(w);
    }, wait);
  }

  /** Sets the placeholder to the widget's height; a change above the reading line is compensated in scrollTop. */
  private applyHeight(w: Widget): void {
    const px = w.pendingHeight;
    w.pendingHeight = undefined;
    if (px === undefined || px === w.height) return;
    w.lastHeightAt = now();
    const delta = px - w.height;
    // Only a widget wholly above the reading line keeps the reader's place by scrolling; one the reader is
    // using (it holds the reading line, or lies below it) stays where it is.
    const bottom = this.panel.contentFrame().getBoundingClientRect().top + w.el.getBoundingClientRect().bottom;
    w.height = px;
    w.el.style.setProperty('--cx-wh', `${px}px`);
    if (bottom < this.panel.readingLine()) this.panel.compensate(delta);
    const key = this.stateKey(w);
    this.heights.delete(key);
    this.heights.set(key, px);
    while (this.heights.size > MAX_HEIGHTS) this.heights.delete(this.heights.keys().next().value!);
    this.heightsToSend.set(w.key, px);
    this.heightsTimer ??= setTimeout(() => {
      this.heightsTimer = undefined;
      const heights = Object.fromEntries(this.heightsToSend);
      this.heightsToSend.clear();
      this.panel.post({ type: 'widgetHeights', heights });
      this.persistStates(false);
    }, HEIGHTS_SAVE_MS);
    this.schedule();
  }

  // ---- calls: highlight, navigation, code ----

  /** Rate limit with trailing coalescing: over the limit, the latest call is delivered when room frees up. */
  private limited(w: Widget, kind: 'highlight' | 'requestCode', m: FromWidget, coalesce: boolean): void {
    const per = RATE[kind];
    let l = w.limits.get(kind);
    if (!l) w.limits.set(kind, (l = { times: [] }));
    const t = now();
    l.times = l.times.filter((x) => t - x < 1000);
    if (l.times.length < per && !l.timer) {
      l.times.push(t);
      this.deliver(w, m);
      return;
    }
    if (!coalesce) {
      if (l.times.length < per * 5) this.deliver(w, m); // code requests: each anchor is asked for once anyway
      return;
    }
    if (l.latest && kind === 'highlight') this.logOnce(w, 'highlight-rate', `${w.src}: more than ${per} highlight() calls a second; the calls in between were dropped (the latest is delivered). Keep animations that highlight at about 8 steps a second or slower.`);
    l.latest = m;
    l.timer ??= setTimeout(() => {
      const lim = w.limits.get(kind);
      if (!lim) return;
      lim.timer = undefined;
      const latest = lim.latest;
      lim.latest = undefined;
      if (latest && w.frame) this.limited(w, kind, latest, coalesce);
    }, Math.max(0, l.times[0]! + 1000 - t));
  }

  private deliver(w: Widget, m: FromWidget): void {
    if (m.type === 'highlight') this.highlight(w, m);
    else if (m.type === 'requestCode') this.requestCode(w, m.anchor);
  }

  /**
   * Decoration needs no click: lines of any anchor that is the current step or inside it (by default the
   * widget's own anchor), wherever the widget sits. The editor already shows that step's code; this never
   * scrolls, opens files or takes focus.
   */
  private highlight(w: Widget, m: Extract<FromWidget, { type: 'highlight' }>): void {
    const anchor = m.anchor ?? w.anchor;
    const step = this.panel.activeStepEl();
    const section = anchor ? this.panel.sectionEl(anchor) : null;
    if (!anchor || !step || !section || !step.contains(section)) {
      this.logOnce(w, 'highlight', `${w.src}: highlight() only works on an anchor that is the current step or inside it (now: '${this.panel.active() ?? 'none'}'; asked: '${anchor ?? 'no anchor'}'); the call was dropped.`);
      return;
    }
    this.highlighted = true;
    this.panel.post({ type: 'widgetHighlight', anchor, lines: m.lines, identifiers: m.identifiers });
  }

  private requestCode(w: Widget, anchor: string): void {
    if (!this.panel.anchors().some((a) => a.id === anchor)) {
      this.send(w, { type: 'code', code: { anchor, status: 'unavailable', reason: 'lost' } });
      return;
    }
    w.codeAnchors.add(anchor);
    const key = `${w.src}\n${anchor}`;
    const cached = this.codes.get(key);
    if (cached) this.send(w, { type: 'code', code: cached });
    if (!this.codeRequested.has(key)) {
      this.codeRequested.add(key);
      this.panel.post({ type: 'widgetCode', src: w.src, anchor });
    }
  }

  /**
   * reveal, goToStep, next/prev and Back: only from the reader's click or key in this widget, at the moment
   * the message arrives (docs/WIDGETS-PLAN.md §5.3).
   */
  private navigate(w: Widget, m: Extract<FromWidget, { type: 'reveal' | 'step' | 'key' }>): void {
    let l = w.limits.get('nav');
    if (!l) w.limits.set('nav', (l = { times: [] }));
    const t = now();
    l.times = l.times.filter((x) => t - x < 1000);
    let ok = l.times.length < RATE.nav && this.interacting(w);
    if (ok) {
      l.times.push(t);
      if (m.type === 'reveal') {
        ok = this.panel.anchors().some((a) => a.id === m.anchor);
        if (ok) this.panel.post({ type: 'widgetReveal', anchor: m.anchor, lines: m.lines, highlight: m.highlight });
      } else if (m.type === 'step') ok = this.panel.goToStep(m.anchor);
      else if (m.action === 'back') ok = this.panel.back();
      else this.panel.step(m.action === 'next' ? 1 : -1);
    } else {
      const what = m.type === 'reveal' ? 'reveal()' : m.type === 'step' ? 'goToStep()' : `${m.action}()`;
      this.logOnce(w, `nav-${m.type}`, `${w.src}: ${what} only works from a click in the widget, called synchronously (not after an await or from a timer); the call returned false.`);
    }
    this.send(w, { type: 'result', id: m.id, ok });
  }

  /** The reader is interacting with this widget: activation, focus in its frame (legitimately), and no evidence against. */
  private interacting(w: Widget): boolean {
    const ua = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
    if (!ua?.isActive || !w.frame || document.activeElement !== w.frame) return false;
    if (this.owner?.frame !== w.frame || !this.owner.legit) return false;
    return this.evidence.allows(this.visibleNow(w), now(), this.vp(), w.frame);
  }

  /**
   * The widget's visible box measured now, for a judgment (cached placement can be a moment stale: text
   * reflowing as fonts load moves widgets without a scroll).
   */
  private visibleNow(w: Widget): Box | null {
    if (!w.frame) return null;
    const win = this.panel.contentDoc().defaultView!;
    w.layout = this.measure(w, win);
    if (w.layout.place.kind !== 'ok') return null;
    this.position(w, this.panel.contentFrame().getBoundingClientRect(), this.panel.scroller.getBoundingClientRect());
    return w.vis ?? null;
  }

  // ---- focus ----

  private frameOwner(el: Element | null): Widget | undefined {
    if (!(el instanceof HTMLIFrameElement)) return undefined;
    for (const w of this.widgets.values()) if (w.frame === el) return w;
    return undefined;
  }

  /**
   * Judges focus once, when it arrives in a widget frame: legitimate if the panel moved it there itself, or
   * with activation and no evidence against; otherwise it is theft, and focus goes back to the placeholder.
   */
  private checkFocus(): void {
    const had = this.hadFocus;
    this.hadFocus = document.hasFocus();
    const a = document.activeElement;
    const w = this.frameOwner(a);
    if (!w) {
      this.owner = undefined;
      return;
    }
    if (this.owner?.frame === a) return;
    const ua = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
    const verdict = ua?.isActive ? this.evidence.judge(this.visibleNow(w), now(), this.vp(), w.frame) : 'refuse';
    const legit = verdict === 'allow';
    this.owner = { frame: w.frame!, legit };
    if (legit) {
      if (w.anchor) this.panel.touchSection(w.anchor);
      return;
    }
    this.theft(w, !had, verdict === 'unsure');
  }

  /**
   * Focus arrived without evidence of the reader's interaction: given back, always (the security rule). Counted
   * against the widget, toward stopping it, only when the panel is sure: not `unsure` (the pointer is on the
   * widget; it just can't be told apart from one that moved under it), and not while the frame reports the
   * reader's own pointer or key input around that moment (an instant click by automation or assistive
   * technology, with no pointer travel the panel could see). That report is the widget's claim: it can spare
   * the widget from being stopped, never grant focus. Focus pulled from outside the webview (the editor)
   * always counts.
   */
  private theft(w: Widget, fromOutside: boolean, unsure = false): void {
    const at = now();
    this.lastTheftAt = at;
    this.owner = undefined;
    this.panel.focusSelf(w.el);
    // From the editor: the extension puts focus back there.
    if (fromOutside) this.panel.post({ type: 'focusTheft' });
    if (unsure) return;
    // Judged a moment later: the frame's report of input may still be on its way.
    setTimeout(() => {
      if (!w.frame || w.status === 'error') return;
      const claimed = w.lastInput !== undefined && w.lastInput >= at - INPUT_CLAIM_MS && w.lastInput <= at + CLAIM_WAIT_MS;
      if (claimed && !fromOutside) return;
      w.thefts++;
      this.logOnce(w, 'focus', `${w.src}: took focus without a click in it; focus was given back.`);
      if (w.thefts >= MAX_FOCUS_THEFTS) {
        this.unmount(w, true);
        this.fail(w, 'This widget kept taking focus, so it was stopped.', undefined, 'restart');
      }
    }, CLAIM_WAIT_MS);
  }

  /** Enter or a click on a placeholder: the panel moves focus into the widget itself (always legitimate). */
  private focusWidget(w: Widget): void {
    if (!w.frame || !w.live) return;
    this.owner = { frame: w.frame, legit: true };
    this.evidence.panelMove(now());
    // Through its window, not the iframe element: focusing the element leaves the page unable to move focus
    // back into the content frame from script (Chromium).
    w.win?.focus();
    if (document.activeElement !== w.frame) w.frame.focus();
    if (w.anchor) this.panel.touchSection(w.anchor);
    if (!this.hinted) {
      this.hinted = true;
      this.persistStates(false);
      const note = w.el.querySelector<HTMLElement>(':scope > .cx-widget-bar .cx-widget-note');
      if (note && !w.badge) {
        setText(note, 'Esc leaves the widget');
        this.syncLabelNote(w);
        setTimeout(() => {
          if (!w.badge && note.textContent === 'Esc leaves the widget') setText(note, '');
          this.syncLabelNote(w);
        }, HINT_MS);
      }
      this.panel.announce('Esc leaves the widget');
    }
  }

  private onPlaceholderKey(e: KeyboardEvent): void {
    if (e.key !== 'Enter' || e.altKey || e.ctrlKey || e.metaKey) return;
    const el = e.target as HTMLElement;
    const w = el.localName === 'explain-widget' ? this.widgets.get(el.getAttribute('data-cx-w') ?? '') : undefined;
    if (!w || w.el !== el) return;
    e.preventDefault();
    this.focusWidget(w);
  }

  private onPlaceholderClick(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    const el = t.closest?.<HTMLElement>('explain-widget[data-cx-w]');
    const w = el ? this.widgets.get(el.getAttribute('data-cx-w') ?? '') : undefined;
    if (!w || w.el !== el) return;
    const own = (b: Element | null) => !!b && b.parentElement?.parentElement?.getAttribute('data-cx-box') === this.panel.boxToken;
    const fb = t.closest('.cx-widget-fallback');
    if (own(fb)) {
      w.showFallback = true;
      this.decorate(this.panel.contentRoot());
      return;
    }
    const act = t.closest('.cx-widget-action');
    if (own(act) && w.error?.action) {
      this.act(w, w.error.action);
      return;
    }
    this.focusWidget(w);
  }

  /**
   * The reader's remedy in a stopped widget's box. `retry`: the extension turns on what its watchdog turned
   * off (it still counts toward stopping the explainer); `restart`: a widget the panel stopped (it kept taking
   * focus, or reloading itself) mounts again, its count started over.
   */
  private act(w: Widget, action: 'retry' | 'restart'): void {
    this.panel.focusSelf(w.el); // the button goes away with the error
    if (action === 'retry') {
      this.panel.post({ type: 'widgetRetry', src: w.src });
      return;
    }
    w.thefts = 0;
    w.resets = 0;
    w.error = undefined;
    this.setStatus(w, 'idle');
    this.decorate(this.panel.contentRoot());
    this.schedule();
  }

  /** The runtime gives focus back: Tab past the end goes on in reading order; anything else to the placeholder. */
  private focusExit(w: Widget, dir: string): void {
    if (document.activeElement !== w.frame) return;
    this.owner = undefined;
    if (dir === 'forward') {
      const doc = this.panel.contentDoc();
      const all = [...doc.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, summary, [tabindex]')].filter(
        (x) => x.tabIndex >= 0 && !(x as HTMLButtonElement).disabled && !w.el.contains(x) && x.checkVisibility() && (w.el.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
      );
      if (all[0]) {
        this.panel.focusSelf(all[0]);
        return;
      }
    }
    this.panel.focusSelf(w.el);
  }

  // ---- watchdogs and timers ----

  /** Timers run only while something is mounted (or for heartbeats, while the explainer has widgets). */
  private timers(): void {
    const mounted = [...this.widgets.values()].some((w) => w.frame);
    if (mounted && !this.measureTimer) this.measureTimer = setInterval(() => this.schedule(), MEASURE_MS);
    if (!mounted && this.measureTimer) {
      clearInterval(this.measureTimer);
      this.measureTimer = undefined;
    }
    if (mounted && !this.pingTimer) {
      this.lastPingAt = 0;
      this.pingTimer = setInterval(() => this.ping(), PING_MS);
    }
    if (!mounted && this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
    // While no widget holds focus legitimately, focus is polled: a theft from the editor fires no event here.
    if (mounted && !this.focusTimer) this.focusTimer = setInterval(() => {
      if (!this.owner?.legit) this.checkFocus();
      else this.hadFocus = document.hasFocus();
    }, FOCUS_POLL_MS);
    if (!mounted && this.focusTimer) {
      clearInterval(this.focusTimer);
      this.focusTimer = undefined;
    }
    const beating = this.widgets.size > 0 && this.gate.status === 'on';
    if (beating && this.heartbeatTimer === undefined) {
      this.heartbeatDue = now() + HEARTBEAT_MS;
      this.heartbeatTimer = setTimeout(() => this.heartbeat(), HEARTBEAT_MS);
    }
    if (!beating && this.heartbeatTimer !== undefined) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private breadcrumbs() {
    const mounted = [...this.widgets.values()].filter((w) => w.frame).map((w) => w.src);
    return { mounted: [...new Set(mounted)].slice(0, MAX_WIDGETS), mounting: this.mounting?.frame ? this.mounting.src : null, recent: this.recent?.frame ? this.recent.src : null };
  }

  /** Every second while visible: how late this timer fired, and which widgets are mounted (§4). */
  private heartbeat(): void {
    const t = now();
    const delay = Math.max(0, t - this.heartbeatDue);
    this.heartbeatDue = t + HEARTBEAT_MS;
    this.heartbeatTimer = setTimeout(() => this.heartbeat(), HEARTBEAT_MS);
    this.checkFocus();
    // Also while hidden (the extension's watchdog disarms on visible: false; silence would look like a hang).
    // A hidden page's timers are throttled, so its lateness says nothing.
    const visible = document.visibilityState === 'visible';
    this.panel.post({ type: 'heartbeat', delay: visible ? Math.round(delay) : 0, visible, ...this.breadcrumbs() });
  }

  /** A beat now, on time (visibility changed): the timer starts over. */
  private beatNow(): void {
    if (this.heartbeatTimer === undefined) return;
    clearTimeout(this.heartbeatTimer);
    this.heartbeatDue = now();
    this.heartbeat();
  }

  /** Pongs stopping for 3 s while visible: tell the extension, which coordinates every panel (§4). */
  private ping(): void {
    const t = now();
    const late = this.lastPingAt > 0 && t - this.lastPingAt > PING_MS + PING_DRIFT_MS;
    this.lastPingAt = t;
    if (late) {
      // This timer was paused too (sleep, a debugger, a busy panel): the silence is ours, start counting again.
      for (const w of this.widgets.values()) w.lastPong = t;
      return;
    }
    let stuck = false;
    for (const w of this.widgets.values()) {
      if (!w.frame || !w.booted || w.unmounting) continue;
      if (t - w.lastPong > PONG_TIMEOUT_MS) stuck = true;
      this.send(w, { type: 'ping', n: ++w.pingN });
    }
    if (stuck && document.visibilityState === 'visible' && !this.unresponsiveReported) {
      this.unresponsiveReported = true;
      this.panel.post({ type: 'widgetsUnresponsive', ...this.breadcrumbs() });
    }
  }

  private onVisibility(): void {
    const hidden = document.visibilityState !== 'visible';
    for (const w of this.widgets.values()) if (w.initSent) {
      w.visible = hidden ? false : undefined;
      if (hidden) this.send(w, { type: 'visible', visible: false });
    }
    if (hidden) {
      this.persistStates(false);
      this.sendStates(true);
    } else {
      for (const w of this.widgets.values()) w.lastPong = now(); // a hidden page's pongs wait; don't count that
      this.lastPingAt = 0;
      this.schedule();
    }
    this.beatNow();
  }

  // ---- state and logs ----

  /** Saved with the panel's state at most once a second (now, with `soon` false). */
  private persistStates(soon = true): void {
    const write = () => {
      this.saveTimer = undefined;
      this.panel.save({ states: this.states.save(), heights: [...this.heights], hinted: this.hinted });
    };
    if (!soon) {
      clearTimeout(this.saveTimer);
      write();
      return;
    }
    this.saveTimer ??= setTimeout(write, STATE_SAVE_MS);
  }

  /** State the extension keeps (by explainer and widget key), sent at most once a second, and at once on unmount and hide. */
  private queueState(w: Widget, json: string): void {
    let m = this.statesToSend.get(w.dir);
    if (!m) this.statesToSend.set(w.dir, (m = new Map()));
    m.delete(w.key);
    m.set(w.key, json);
    this.sendStates(false);
  }

  private sendStates(now: boolean): void {
    const send = () => {
      clearTimeout(this.statesTimer);
      this.statesTimer = undefined;
      for (const [dir, m] of this.statesToSend) this.panel.post({ type: 'widgetStates', dir, states: [...m].slice(-MAX_WIDGETS) });
      this.statesToSend.clear();
    };
    if (now) send();
    else this.statesTimer ??= setTimeout(send, STATE_SAVE_MS);
  }

  /**
   * The state the extension kept for the explainer shown (after a window reload, or the panel closed and
   * opened again): it fills in what the panel's own state lacks (which, when there, is the newer).
   */
  restoreStates(entries: [string, string][]): void {
    for (const [key, json] of entries) {
      const k = `${this.panel.dir()}\n${key}`;
      if (typeof key === 'string' && typeof json === 'string' && !this.states.has(k)) this.states.set(k, json);
    }
  }

  private log(w: Widget, level: 'error' | 'warn' | 'info', message: string): void {
    if (w.logged.size >= MAX_LOGS_PER_WIDGET) return;
    w.logged.add(`${level}:${message}`);
    this.panel.post({ type: 'widgetLog', src: w.src, level, message: message.slice(0, 1000) });
  }

  private logOnce(w: Widget, what: string, message: string): void {
    if (w.logged.has(`once:${what}`)) return;
    w.logged.add(`once:${what}`);
    this.panel.post({ type: 'widgetLog', src: w.src, level: 'warn', message });
  }

  /** For tests: what is mounted. */
  debug(): { key: string; src: string; status: Status; mounted: boolean; height: number }[] {
    return [...this.widgets.values()].map((w) => ({ key: w.key, src: w.src, status: w.status, mounted: !!w.frame, height: w.height }));
  }
}

// ---- helpers ----

/** Where a compile error is, as `file:line:column` (as far as known). */
function place(e: { file: string; line?: number; column?: number }): string {
  return `${e.file}${e.line ? `:${e.line}${e.column ? `:${e.column}` : ''}` : ''}`;
}

/** A short, stable hash (FNV-1a) for capping long placeholder keys (ids, sources) in messages. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

function setText(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

const px = (v: string) => parseFloat(v) || 0;

/** The fallback's text (and image descriptions), for aria-describedby. */
function fallbackText(el: HTMLElement, token: string): string {
  const parts: string[] = [];
  const walk = (n: Node) => {
    if (n.nodeType === 3) parts.push(n.textContent ?? '');
    else if (n.nodeType === 1) {
      const e = n as Element;
      if (e.getAttribute('data-cx-box') === token) return;
      if (e.localName === 'img') parts.push(e.getAttribute('alt') ?? '');
      for (const c of e.childNodes) walk(c);
    }
  };
  for (const c of el.childNodes) walk(c);
  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 2000);
}

/**
 * JSON values with null-prototype objects, without `__proto__` keys: copied into a props object on the
 * other side, such a key would set that object's prototype.
 */
function nullProto(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(nullProto);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = Object.create(null);
    for (const [k, x] of Object.entries(v)) if (k !== '__proto__') o[k] = nullProto(x);
    return o;
  }
  return v;
}

/** The OS setting or VS Code's `workbench.reduceMotion` (the `vscode-reduce-motion` body class). */
export function reducedMotion(): boolean {
  return matchMedia('(prefers-reduced-motion: reduce)').matches || document.body.classList.contains('vscode-reduce-motion');
}

/**
 * Placeholder geometry and the label, inline and !important: author CSS (even !important, more specific)
 * can't shrink the box the frame lies over or hide the "Interactive" label.
 */
function pinBox(el: HTMLElement, status: Status, showFallback: boolean): void {
  // The fallback shows at its own height: widgets off, or the reader chose "Show fallback" (no frame there).
  const off = status === 'off' || (showFallback && status !== 'live' && status !== 'loading');
  const props: [string, string][] = [
    ['display', 'block'], ['box-sizing', 'content-box'], ['height', off ? 'auto' : 'var(--cx-wh, 240px)'], ['min-height', '0'],
    ['max-height', 'none'], ['padding', `${BAR_PX}px 0 0`], ['overflow', off ? 'visible' : 'hidden'], ['visibility', 'visible'],
  ];
  for (const [k, v] of props) if (el.style.getPropertyValue(k) !== v || el.style.getPropertyPriority(k) !== 'important') el.style.setProperty(k, v, 'important');
}

/**
 * The error box shows only while there is an error and no frame is live over it; hidden, it is inert, so its
 * "Show fallback" button is no Tab stop (author CSS could display a hidden element; inert still holds).
 */
function syncErrorBox(err: HTMLElement, w: Widget | undefined, status: Status): void {
  const show = !!w?.error && !w.showFallback && status === 'error';
  if (err.hidden === show) err.hidden = !show;
  if (err.inert === show) err.inert = !show;
}

function pinLabel(bar: HTMLElement): void {
  const set = (e: HTMLElement, props: [string, string][]) => {
    for (const [k, v] of props) if (e.style.getPropertyValue(k) !== v || e.style.getPropertyPriority(k) !== 'important') e.style.setProperty(k, v, 'important');
  };
  const shown: [string, string][] = [['visibility', 'visible'], ['opacity', '1'], ['transform', 'none'], ['clip-path', 'none'], ['filter', 'none']];
  set(bar, [...shown, ['display', 'flex'], ['position', 'absolute'], ['top', '0'], ['left', '0'], ['right', '0'], ['height', `${BAR_PX}px`], ['font-size', '11px'], ['z-index', '1']]);
  const tag = bar.querySelector<HTMLElement>('.cx-widget-tag');
  if (tag) set(tag, [...shown, ['display', 'block'], ['font-size', '11px'], ['color', 'var(--vscode-badge-foreground)'], ['background', 'var(--vscode-badge-background)']]);
}

function theme(): { kind: ThemeKind; vars: Record<string, string>; bodyClass: string; reducedMotion: boolean } {
  const vars: Record<string, string> = {};
  const style = document.documentElement.style;
  for (let i = 0; i < style.length; i++) {
    const k = style.item(i);
    if (k.startsWith('--vscode-')) vars[k] = style.getPropertyValue(k);
  }
  const c = document.body.classList;
  const kind: ThemeKind = c.contains('vscode-high-contrast-light') ? 'high-contrast-light' : c.contains('vscode-high-contrast') ? 'high-contrast' : c.contains('vscode-light') ? 'light' : 'dark';
  return { kind, vars, bodyClass: document.body.className, reducedMotion: reducedMotion() };
}

type Placement = { kind: 'ok' } | { kind: 'hidden' } | { kind: 'unsupported'; reader: string; author: string };

/** Describes an element for authors: `div.card`, `section#refill`. */
function describe(el: Element): string {
  const id = el.getAttribute('id');
  const cls = el.classList[0];
  return `${el.localName}${id ? `#${id}` : cls ? `.${cls}` : ''}`;
}

/**
 * The placement contract (docs/WIDGETS-PLAN.md §3): normal flow, clip-only ancestors and scrolling ancestors
 * that don't overflow are fine; not rendered means simply unmounted; transforms, clip-path, mask, filter,
 * content-visibility, fixed/sticky positioning and geometry animations above the widget are not supported.
 */
export function placement(el: HTMLElement, win: Window): Placement {
  if (!el.isConnected || !el.checkVisibility({ visibilityProperty: true } as CheckVisibilityOptions)) return { kind: 'hidden' };
  const stop = el.ownerDocument.body;
  for (let a: Element | null = el; a && a !== stop; a = a.parentElement) {
    const cs = win.getComputedStyle(a);
    const bad = (prop: string) => ({ kind: 'unsupported' as const, reader: "This widget can't be shown here.", author: `\`${describe(a!)}\`: ${prop} (widgets can't be placed inside it; see the placement rules)` });
    if (cs.transform !== 'none' || (cs.translate && cs.translate !== 'none') || (cs.rotate && cs.rotate !== 'none') || (cs.scale && cs.scale !== 'none')) return bad('transform');
    if (cs.clipPath !== 'none') return bad('clip-path');
    const mask = cs.maskImage || (cs as CSSStyleDeclaration & { webkitMaskImage?: string }).webkitMaskImage;
    if (mask && mask !== 'none') return bad('mask');
    if (cs.filter !== 'none') return bad('filter');
    if (cs.contentVisibility && cs.contentVisibility !== 'visible') return bad('content-visibility');
    if (cs.position === 'fixed' || cs.position === 'sticky') return bad(`position: ${cs.position}`);
    if (a !== el) {
      for (const [axis, overflow] of [['x', cs.overflowX], ['y', cs.overflowY]] as const) {
        if (overflow !== 'auto' && overflow !== 'scroll') continue;
        const overflows = axis === 'x' ? a.scrollWidth > a.clientWidth + 1 : a.scrollHeight > a.clientHeight + 1;
        if (overflows) return { kind: 'unsupported', reader: "This widget can't be shown at this width.", author: `\`${describe(a)}\`: overflow-${axis}: ${overflow} and its content overflows (a widget can't scroll inside it)` };
      }
    }
    const hovered = a.matches(':hover');
    for (const anim of a.getAnimations()) {
      // The panel's own animations, and transitions that run only while hovered (a "lift"), are allowed.
      if ('transitionProperty' in anim ? hovered : ((anim as CSSAnimation).animationName ?? '').startsWith('cx-')) continue;
      const effect = anim.effect as KeyframeEffect | null;
      const props = effect?.getKeyframes().flatMap((k) => Object.keys(k).filter((p) => !KEYFRAME_META.has(p))) ?? [];
      if (props.some((p) => GEOMETRY.test(p.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)))) return bad('a geometry animation');
    }
    const durations = cs.transitionDuration.split(',').map((d) => parseFloat(d));
    if (durations.some((d) => d > 0) && !hovered) {
      const props = cs.transitionProperty.split(',').map((p) => p.trim());
      if (props.some((p, i) => GEOMETRY.test(p) && (durations[i % durations.length] ?? 0) > 0)) return bad('transition of its geometry');
    }
  }
  return { kind: 'ok' };
}

/** Padding boxes of ancestors that clip (overflow hidden or clip, or auto/scroll that doesn't overflow), in content coordinates. */
function clipBoxes(el: HTMLElement, win: Window): Box[] {
  const out: Box[] = [];
  const stop = el.ownerDocument.body;
  for (let a = el.parentElement; a && a !== stop; a = a.parentElement) {
    const cs = win.getComputedStyle(a);
    const clipX = cs.overflowX !== 'visible';
    const clipY = cs.overflowY !== 'visible';
    if (!clipX && !clipY) continue;
    const r = a.getBoundingClientRect();
    const l = r.left + px(cs.borderLeftWidth);
    const t = r.top + px(cs.borderTopWidth);
    out.push({
      left: clipX ? l : -Infinity,
      right: clipX ? l + a.clientWidth : Infinity,
      top: clipY ? t : -Infinity,
      bottom: clipY ? t + a.clientHeight : Infinity,
    });
  }
  return out;
}

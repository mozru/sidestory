// The explainer page. It renders author HTML in a sandboxed iframe, keeps the reader's place through
// every update (DOM morphing, never a reload), and syncs the active section with the editor.
import { Idiomorph } from 'idiomorph';
import { ANCHOR_ID_RE } from '../core/paths.ts';
import { type CodeLink, formatCodeLink, MAX_CODE_LINKS, parseCodeLink } from '../shared/code-link.ts';
import diagramTokensCss from '../shared/diagram-tokens.css';
import type { AnchorView, DetailInfo, FromWebview, ToWebview, TrailItem } from '../shared/protocol.ts';
import type { WidgetAnchor } from '../shared/widget-protocol.ts';
import contentCssText from './content.css';
import { Assets } from './assets.ts';
import { stepTitle } from '../core/step-title.ts';
import { DIAGRAM_CLASSES, Diagrams, litIds, MAX_TAGGED } from './diagram.ts';
import { CodeHighlighter } from './highlight.ts';
import { HoverCard } from './hover.ts';
import { sanitize } from './sanitize.ts';
import { randomToken, staticHtml } from './trusted.ts';
import { reducedMotion, type SavedWidgets, WidgetFrames } from './widgets.ts';
import { CommentsPane } from './comments.ts';
import { type HistoryEntry, NavHistory, samePage, type SavedHistory } from './history.ts';
import { forVsCode, historyKey, keyInfo, MAC, passToVsCode, typingIn, WINDOWS } from './keys.ts';

interface VsCodeApi {
  postMessage(m: FromWebview): void;
  getState(): SavedState | undefined;
  setState(s: SavedState): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

interface Place {
  active?: string;
  /** The section at the reading line and how far from the top of the viewport it was. */
  scroll?: { anchor: string; offset: number };
}

interface SavedState extends Place {
  /** The explainer shown (its folder URI); the panel is restored to it after a restart. */
  dir: string;
  /** The reader's place in every explainer visited, so going back up the trail returns there. */
  places?: Record<string, Place>;
  /** The trail's explainer names, root first, so a restart can restore the way back. */
  trail?: string[];
  /** Widget state (`useWidgetState`), last heights, hints shown. */
  widgets?: SavedWidgets;
  /** Comment drafts, the Comments pane's height and scope (docs/COMMENTS-PLAN.md §6.2). */
  comments?: { drafts?: Record<string, string>; height?: number; all?: boolean };
  /** Back / Forward (history.ts). */
  history?: SavedHistory;
}

interface Step {
  id: string;
  el: HTMLElement;
  label: string;
}

type Source = 'scroll' | 'click' | 'step';

const READING_LINE = 0.3; // fraction of the viewport height
const PILL_MS = 8000;
const UPDATED_MS = 1800;
const STATE_TEXT: Record<string, { badge: string; spoken: string; title: string }> = {
  changed: { badge: 'Code changed', spoken: 'code changed', title: 'The code this section explains was edited a little. The text is probably still right.' },
  stale: { badge: 'Out of date', spoken: 'out of date', title: 'The code this section explains changed a lot. The text may no longer be right.' },
  lost: { badge: 'Code not found', spoken: 'code not found', title: "The code this section explains can't be found in the file any more." },
  unknown: { badge: 'Not linked', spoken: 'not linked', title: 'This section names an anchor that the manifest does not define.' },
};

const vscode = acquireVsCodeApi();
const app = document.getElementById('app')!;
// Normalized the way the URL parser does it: in remote windows VS Code's resource host contains a
// percent-encoded '+', which resolved URLs spell decoded, so the raw string wouldn't prefix-match them.
let baseUrl = new URL(app.dataset.base!).href;
const pendingAssets = new Map<number, (b: Blob | null) => void>();
let assetId = 0;
function requestAsset(path: string): Promise<Blob | null> {
  const id = ++assetId;
  vscode.postMessage({ type: 'requestAsset', id, path });
  return new Promise<Blob | null>((resolve) => {
    // Don't hold a render forever if the reply never comes (e.g. the panel was hidden meanwhile).
    const timer = setTimeout(() => {
      if (pendingAssets.delete(id)) resolve(null);
    }, 5_000);
    pendingAssets.set(id, (b) => {
      clearTimeout(timer);
      resolve(b);
    });
  });
}
let assets = new Assets(baseUrl, requestAsset);
/** The trail: the root explainer, the details dived into, the one shown last. */
let trail: TrailItem[] = [];
/** What we know about detail explainers named in the current one. */
const details = new Map<string, DetailInfo>();
const describing = new Set<string>();
/** Details whose summary ("peek") is open. */
const peeked = new Set<string>();
/**
 * Marks the detail boxes this script made: author HTML can contain look-alikes, but can't guess this.
 * (An attribute, not a WeakSet: the morph may insert copies of the nodes it was given.)
 */
const BOX_TOKEN = randomToken();
const ownBox = (el: Element | null | undefined): el is HTMLElement => el?.getAttribute('data-cx-box') === BOX_TOKEN;

let state: SavedState = vscode.getState() ?? { dir: app.dataset.dir! };
/** Back / Forward: where the reader has been in this panel. */
const navHistory = new NavHistory(state.history);
/** A Back or Forward to another sidestory (or a trail move that is one), until its `init` arrives. */
let pendingHistory: { index: number; dir: string; trail: string[]; id: number } | undefined;
/** Numbers the requests that move the panel (Back / Forward, a dive, the way up), so a refusal is matched to its own. */
let navRequestId = 0;
let anchors = new Map<string, AnchorView>();
let steps: Step[] = [];
let active: string | undefined = state.active;
let focusTimer: ReturnType<typeof setTimeout> | undefined;
let pillTimer: ReturnType<typeof setTimeout> | undefined;
let initialized = false;
// Declared up here: the frame's listeners (attached in buildFrame, before the code below runs) use them.
let lastKeyAt = 0;
/** Keys from the content frame passed on to VS Code and not yet released (forwardKey). */
const passedDown = new Set<string>();
/** When the reader last pressed Tab (trusted), in the panel or the content. */
let lastTabAt = 0;
/**
 * The linked element the reader put focus on themselves (a Tab, or a pointer press on it). Enter opens a link only
 * then: focus that arrives otherwise (an in-page link's target, a dialog, a widget giving focus back) isn't aimed.
 */
let aimedLink: Element | null = null;
/** What the aimed link pointed at when the reader aimed: a live edit that retargets it needs a new aim. */
let aimedKey = '';
const linkKey = (el: Element) => {
  const ref = el.getAttribute('data-explain-ref');
  const link = ref === null ? codeLinkOf(el) : null;
  return ref !== null ? `r:${ref}` : link ? `c:${formatCodeLink(link)}` : '';
};
let lastFocused: HTMLElement | undefined;
let focusingSelf = false;
/** Set by `init`; applied by whichever render completes first after it. */
let pendingInit: { active?: string; after?: () => void } | undefined;
/** Next/Previous Step pressed before the explainer rendered (right after opening it): taken once it has. */
const pendingSteps: (1 | -1)[] = [];
/** Widget frames over their placeholders (created once the content frame exists). */
let widgets: WidgetFrames | undefined;
/** The hover preview's card (`sidestory.hoverPreview`); created before the content frame's listeners can fire. */
let hoverCard: HoverCard | undefined;
/** The hidden copy of the card's text in the content frame (an IDREF can't cross documents); its id is unguessable. */
let hoverDesc: HTMLElement | undefined;
const HOVER_DESC_ID = `cx-hover-${randomToken()}`;
/** Code block colors (docs/HIGHLIGHT-PLAN.md): tokens come from the extension host. */
const highlighter = new CodeHighlighter({ post: (m) => vscode.postMessage(m), root: () => content });
/** Sanitizer warnings already sent to Output for the explainer shown. */
const warned = new Set<string>();
/** Places kept per explainer; the oldest are dropped past this. */
const MAX_PLACES = 32;
const DETAIL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/**
 * Form controls a `<label for>` forwards trusted clicks to: links on them, or clicked through them, are ignored, so a
 * label can never fire a link (docs/AUTHORING-PLAN.md §8.1).
 */
const LABELABLE = 'button, input, select, textarea, meter, output, progress';
/** Diagram lighting for the live content (data-explain-on); the incoming tree gets a fresh instance per render. */
const diagrams = new Diagrams();
/** The code target the editor cursor is in (`here`), which rings the elements that link to it (cx-here). */
let here: { ref?: string; link?: string } = {};
/** The linked elements of the live content, with the key `here` matches (`r:<anchor>` or `c:<link>`). */
let linkEls: { el: HTMLElement; key: string }[] = [];
/** What `codeTargets` last said, so it's sent only when it changes. */
let sentTargets = '';
/** The content changed (a morph, a new frame) since the diagrams were indexed. */
let needsIndex = true;

// ---- skeleton ----

app.innerHTML = staticHtml`
<header class="cx-header">
  <nav class="cx-trail" aria-label="Sidestory path" hidden></nav>
  <div class="cx-preview" role="status" hidden><span class="codicon codicon-eye" aria-hidden="true"></span><span class="cx-preview-text">Preview: the next sidestory you open from code or a list replaces this one.</span><button class="cx-preview-keep" type="button">Keep Open</button></div>
  <div class="cx-titlerow">
    <span class="cx-history">
      <button class="cx-hist" type="button" data-delta="-1" aria-label="Back" aria-disabled="true"><span class="codicon codicon-arrow-left" aria-hidden="true"></span></button>
      <button class="cx-hist" type="button" data-delta="1" aria-label="Forward" aria-disabled="true"><span class="codicon codicon-arrow-right" aria-hidden="true"></span></button>
    </span>
    <h1 class="cx-title"></h1>
    <span class="cx-status"><span class="codicon" aria-hidden="true"></span><span class="cx-status-text"></span></span>
  </div>
  <nav class="cx-steps" aria-label="Steps"></nav>
  <div class="cx-steps-compact">
    <div class="cx-step-picker">
      <label class="cx-sr" for="cx-step-select">Step</label>
      <select id="cx-step-select" class="cx-step-select"></select>
      <button class="cx-nav" type="button" data-delta="-1" aria-label="Previous step"><span class="codicon codicon-chevron-left" aria-hidden="true"></span></button>
      <button class="cx-nav" type="button" data-delta="1" aria-label="Next step"><span class="codicon codicon-chevron-right" aria-hidden="true"></span></button>
    </div>
    <div class="cx-progress" aria-hidden="true"></div>
  </div>
</header>
<div class="cx-banner" role="alert" hidden><span class="codicon codicon-warning" aria-hidden="true"></span><span class="cx-banner-text"></span><button class="cx-banner-open" type="button" hidden>Open manifest.json</button></div>
<div class="cx-consent" role="region" aria-label="Interactive widgets" hidden></div>
<main class="cx-scroll" tabindex="0" aria-label="Sidestory"><div class="cx-frame"><div class="cx-widget-layer"></div><div class="cx-comment-layer"></div></div></main>
<section class="cx-comments" role="region" aria-label="Comments" hidden></section>
<div class="cx-pill" hidden>
  <button class="cx-pill-show" type="button"></button>
  <button class="cx-pill-close" type="button" aria-label="Dismiss"><span class="codicon codicon-close" aria-hidden="true"></span></button>
</div>
<footer class="cx-footer">
  <button class="cx-nav" type="button" data-delta="-1" aria-label="Previous step"><span class="codicon codicon-chevron-left" aria-hidden="true"></span></button>
  <button class="cx-nav" type="button" data-delta="1" aria-label="Next step"><span class="codicon codicon-chevron-right" aria-hidden="true"></span></button>
  <span class="cx-position"></span>
  <button class="cx-back" type="button" hidden></button>
  <span class="cx-hint">J / K steps</span>
</footer>
<div class="cx-sr" role="status" aria-live="polite"></div>`;

const $ = <T extends HTMLElement>(sel: string) => app.querySelector<T>(sel)!;
const titleEl = $('.cx-title');
const statusEl = $('.cx-status');
const statusText = $('.cx-status-text');
const statusIcon = $('.cx-status .codicon');
const stepsEl = $('.cx-steps');
const selectEl = $<HTMLSelectElement>('.cx-step-select');
const progressEl = $('.cx-progress');
const bannerEl = $('.cx-banner');
const bannerText = $('.cx-banner-text');
const scroller = $('.cx-scroll');
const pillEl = $('.cx-pill');
const pillShow = $<HTMLButtonElement>('.cx-pill-show');
const positionEl = $('.cx-position');
const liveEl = $('[aria-live]');
const trailEl = $('.cx-trail');
const bannerOpen = $<HTMLButtonElement>('.cx-banner-open');
const headerEl = $('.cx-header');
const backEl = $<HTMLButtonElement>('.cx-back');
const histBack = $<HTMLButtonElement>('.cx-hist[data-delta="-1"]');
const histForward = $<HTMLButtonElement>('.cx-hist[data-delta="1"]');
/** Shown while this is a preview panel (docs/NAVIGATION-PLAN.md §7.5). */
const previewEl = $('.cx-preview');
/** Widget frames live here, over the content, scrolling with it (docs/WIDGETS-PLAN.md §3). */
const layerEl = $('.cx-widget-layer');
/** Comment badges over each section (docs/COMMENTS-PLAN.md §6.1): host chrome over the content frame. */
const commentLayerEl = $('.cx-comment-layer');
const comments = new CommentsPane($('.cx-comments'), commentLayerEl, {
  post: (m) => vscode.postMessage(m as FromWebview),
  steps: () => steps,
  activeStep: () => activeStepId(),
  goToStep: (id) => jumpTo(id, 'click'),
  stepButton: (id) => stepsEl.querySelector<HTMLElement>(`.cx-step[data-anchor="${CSS.escape(id)}"]`),
  contentFrame: () => frame?.el ?? $('.cx-frame'),
  announce: (t) => announce(t),
  keepPlace: (f) => {
    const p = initialized ? readingPosition() : undefined;
    f();
    if (p) requestAnimationFrame(() => restorePosition(p));
  },
  reducedMotion: () => reducedMotion(),
  load: () => state.comments,
  save: (c) => {
    state = { ...state, comments: c };
    vscode.setState(state);
  },
});

hoverCard = new HoverCard(app, {
  post: (m) => vscode.postMessage(m),
  // As openLinked: a ref wins over code, and only anchors the page knows.
  ask: (el) => {
    if (el.hasAttribute('data-explain-ref')) {
      const id = el.dataset.explainRef!;
      return anchors.has(id) ? { type: 'previewRef', anchorId: id } : undefined;
    }
    const link = codeLinkOf(el);
    if (!link) return undefined;
    return link.target === undefined ? { type: 'previewCode', path: link.path } : { type: 'previewCode', path: link.path, target: link.target };
  },
  rect: (el) => {
    const f = frame.el.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return new DOMRect(r.left + f.left, r.top + f.top, r.width, r.height);
  },
  describer: () => hoverDesc,
});

/*
 * Explainer content lives in a sandboxed iframe: no scripts run in it (only this script, from
 * outside, touches its DOM), and anything it draws, even in the browser's top layer, stays inside
 * its box, so it can never cover the panel's own controls. The frame is as tall as its content;
 * the panel scrolls, not the frame.
 */
interface Frame {
  el: HTMLIFrameElement;
  /** Captured before any content goes in: named elements can override document members (clobbering). */
  root: HTMLElement;
  body: HTMLElement;
  createElement: Document['createElement'];
  importNode: Document['importNode'];
  getSelection: () => Selection | null;
  location: Location;
}

let frame!: Frame;
let content!: HTMLElement;
let lastRender: { title: string; html: string } | undefined;

async function buildFrame(): Promise<void> {
  const el = document.createElement('iframe');
  el.className = 'cx-content-frame';
  el.title = 'Sidestory content';
  el.setAttribute('sandbox', 'allow-same-origin');
  el.srcdoc = staticHtml`<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body></body></html>` as unknown as string;
  $('.cx-frame').replaceChildren(el, layerEl, commentLayerEl);
  await new Promise<void>((resolve) => el.addEventListener('load', () => resolve(), { once: true }));
  const d = el.contentDocument!;
  frame = {
    el,
    root: d.documentElement,
    body: d.body,
    createElement: Document.prototype.createElement.bind(d) as Document['createElement'],
    importNode: Document.prototype.importNode.bind(d) as Document['importNode'],
    getSelection: () => el.contentWindow?.getSelection() ?? null,
    location: el.contentWindow!.location,
  };
  const style = frame.createElement('style');
  // The tokens first: content.css and the author's CSS use them.
  style.textContent = `${diagramTokensCss}\n${contentCssText}`;
  d.head.append(style);
  content = frame.createElement('div');
  needsIndex = true;
  content.className = 'cx-content';
  hoverDesc = frame.createElement('div');
  hoverDesc.id = HOVER_DESC_ID;
  hoverDesc.hidden = true;
  frame.body.append(content, hoverDesc);
  bindFrameEvents(d);
  highlighter.bind(d);
  widgets?.bindContent(d);
  syncTheme();
  new ResizeObserver(fitFrame).observe(frame.body);
  // Nothing in the content can navigate the frame (links are intercepted, forms removed), but if
  // it ever happens, start over with a fresh frame rather than leave a dead page.
  el.addEventListener('load', () => {
    if (el.contentDocument !== d) void rebuildFrame();
  });
}

async function rebuildFrame(): Promise<void> {
  await buildFrame();
  if (lastRender) await render(lastRender.title, lastRender.html, false);
  markActive();
}

// The frame doesn't inherit the theme: copy VS Code's variables, body classes and the panel's
// gutter, and keep them in sync.
function syncTheme(): void {
  if (!frame) return;
  frame.root.setAttribute('style', document.documentElement.getAttribute('style') ?? '');
  frame.body.className = document.body.className;
  svgClocks(content);
  syncTail();
  widgets?.onTheme();
}

/** The space below the last section and the gutter, which follow the panel's size (not a theme change). */
function syncTail(): void {
  if (!frame) return;
  const set = (k: string, v: string) => {
    if (frame.root.style.getPropertyValue(k) !== v) frame.root.style.setProperty(k, v);
  };
  set('--cx-tail', `${Math.round(scroller.clientHeight * 0.4)}px`);
  set('--cx-gutter', getComputedStyle($('.cx-header')).getPropertyValue('--cx-gutter').trim() || '20px');
}

// The frame is as tall as its content, so the panel's scroller does the scrolling. Measured from the
// content (not the document, which never reports less than the frame's current height), synchronously
// after every render, and again when images or fonts load.
function fitFrame(): void {
  if (!frame) return;
  const h = `${Math.ceil(content.getBoundingClientRect().bottom)}px`;
  if (frame.el.style.height !== h) frame.el.style.height = h;
  if (Date.now() - resizedAt < 1000) holdPlace();
  widgets?.schedule();
  comments?.placeBadges();
}

/*
 * When the panel changes width (typically: choosing a step opens the code beside it), the content
 * reflows and everything moves. Put back the section being scrolled to, or else the reader's place.
 */
let panelWidth = 0;
let resizedAt = 0;
let heldPlace: Position | undefined;
let scrollTarget: { id: string; until: number } | undefined;
/**
 * A step a widget (in section `from`) made current without scrolling (`to`): until the step changes another way,
 * touching that widget again doesn't put back its own section.
 */
let widgetHold: { to: string; from: string | undefined; dir: string } | undefined;

function onPanelResize(): void {
  if (scroller.clientWidth === panelWidth) return;
  panelWidth = scroller.clientWidth;
  resizedAt = Date.now();
  holdPlace();
  notePlaceWhenSettled();
}

/** Not mid-resize, nor on the way to a section: the scroll position is the reader's place. */
const placeSettled = () => Date.now() - resizedAt > 1000 && !(scrollTarget && Date.now() < scrollTarget.until);

let placeTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * Records the reader's place once the page settles. Scrolling while it settles isn't recorded, and nothing may
 * scroll after: a step chosen as the panel resizes would otherwise leave the place from before the step held,
 * and the next resize would put that back (the page jumps away from the step).
 */
function notePlaceWhenSettled(): void {
  clearTimeout(placeTimer);
  const wait = Math.max(resizedAt + 1000, scrollTarget?.until ?? 0) - Date.now() + 50;
  placeTimer = setTimeout(() => {
    if (!initialized) return;
    if (placeSettled()) heldPlace = readingPosition();
    else notePlaceWhenSettled();
  }, Math.max(0, wait));
}

function holdPlace(): void {
  if (!initialized) return;
  if (scrollTarget && Date.now() < scrollTarget.until) {
    const el = sectionEl(scrollTarget.id);
    if (!el) return;
    scroller.scrollTo({ top: scroller.scrollTop + topOf(el) - scroller.getBoundingClientRect().top - 12, behavior: 'auto' });
  } else if (heldPlace) restorePosition(heldPlace);
}

await buildFrame();
widgets = new WidgetFrames({
  post: (m) => vscode.postMessage(m),
  contentFrame: () => frame.el,
  contentDoc: () => frame.root.ownerDocument,
  contentRoot: () => content,
  scroller,
  layer: layerEl,
  bar: $('.cx-consent'),
  boxToken: BOX_TOKEN,
  dir: () => state.dir,
  active: () => active,
  activeStepEl: () => steps.find((s) => s.id === activeStepId())?.el,
  anchors: widgetAnchors,
  sectionEl: (id) => sectionEl(id),
  touchSection: (id) => {
    if (held() && id === widgetHold!.from) return;
    widgetHold = undefined;
    if (sectionEl(id)?.dataset.cxState !== 'lost') pick(id, 'click');
  },
  // From a widget the page stays on the widget the reader is using: the step becomes current and its code
  // shows in the editor, without scrolling to the step's text.
  goToStep: (id, from) => {
    if (!anchors.has(id) || !sectionEl(id)) return false;
    const before = active;
    if (id === active) setActive(id, 'step'); // shows its code again, as asked
    else pick(id, 'step');
    holdForWidget(before, from);
    return true;
  },
  step: (delta, from) => {
    const before = active;
    step(delta, false);
    holdForWidget(before, from);
  },
  back: () => {
    if (trail.length < 2) return false;
    goTo(trail.length - 2);
    return true;
  },
  history: (delta) => goHistory(delta),
  compensate: (dy) => {
    scroller.scrollTop += dy;
  },
  focusSelf: (el) => {
    focusingSelf = true;
    // The content frame first: after the panel focused a widget frame itself, focusing an element inside the
    // content frame alone moves that frame's own focus but not the page's.
    if (document.activeElement !== frame.el) frame.el.contentWindow?.focus();
    el.focus({ preventScroll: true });
    focusingSelf = false;
  },
  announce,
  saved: () => state.widgets,
  save: (w) => {
    state = { ...state, widgets: w };
    vscode.setState(state);
  },
  readingLine: () => {
    const view = scroller.getBoundingClientRect();
    return view.top + view.height * READING_LINE;
  },
});
widgets.bindContent(frame.root.ownerDocument);
new MutationObserver(syncTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
new MutationObserver(syncTheme).observe(document.body, { attributes: true, attributeFilter: ['class'] });
matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => svgClocks(content));
new ResizeObserver(syncTail).observe(scroller);
new ResizeObserver(onPanelResize).observe(scroller);
new ResizeObserver(() => fitSteps()).observe(headerEl);

const sectionEl = (id: string) => content.querySelector<HTMLElement>(`[data-explain-anchor="${CSS.escape(id)}"]`);
/** An element's top, in the panel's coordinates. */
const topOf = (el: Element) => el.getBoundingClientRect().top + frame.el.getBoundingClientRect().top;

/** Anchors as widgets see them (`useAnchors`): title, step index (−1 when nested), where, state, color. */
function widgetAnchors(): WidgetAnchor[] {
  const css = getComputedStyle(document.documentElement);
  return [...anchors.values()].map((a) => {
    const el = sectionEl(a.id);
    return {
      id: a.id,
      title: el ? stepLabel(el, a.id) : a.id,
      step: steps.findIndex((s) => s.id === a.id),
      file: a.file,
      range: a.range,
      state: a.state,
      color: a.colorVar ? css.getPropertyValue(a.colorVar).trim() || undefined : undefined,
    };
  });
}

// ---- messages ----

window.addEventListener('message', (e: MessageEvent<ToWebview>) => {
  // Only VS Code's webview host speaks for the extension. It posts on the panel's own origin, which is shared
  // only by this extension's explainer panels (all running just this script); sandboxed frames (widgets) have
  // the opaque origin "null", and the content frame on this origin runs no script. If a same-origin frame
  // that runs script is ever added, this check is no longer enough. (The host's message source isn't
  // window.parent, so the origin is the check.)
  if (e.origin !== window.origin) return;
  const m = e.data;
  if ((m.type === 'threads' || m.type === 'commentsShow') && comments?.onMessage(m)) return;
  switch (m.type) {
    case 'init': {
      const entering = m.dir !== state.dir;
      const names = m.trail.map((t) => t.name);
      // Back or Forward (or a trail move that is one) arriving: the entry it was for becomes current.
      // Still that entry (a jump meanwhile may have dropped what was ahead): otherwise it's a new page like any other.
      const page = { dir: m.dir, trail: names };
      const waited = pendingHistory && navHistory.at(pendingHistory.index);
      const back = pendingHistory && samePage(pendingHistory, page) && waited && samePage(waited, page) ? pendingHistory : undefined;
      setPending(undefined);
      if (initialized) navHistory.update(hereEntry()); // the place being left, as it is now
      const target = back ? navHistory.go(back.index) : undefined;
      // A different explainer (dive / back): remember the reader's place here, forget the rest.
      if (entering) {
        if (initialized) savePlace();
        // Until the new explainer renders, the old one is still on screen: don't save or hold its places.
        initialized = false;
        details.clear();
        describing.clear();
        peeked.clear();
        warned.clear();
        here = {};
        sentTargets = '';
        widgets?.switchExplainer();
        lastRender = undefined;
        hidePill();
        try {
          // No :target carried over. Not an empty fragment, which would scroll to the top.
          frame.location.replace('about:srcdoc#cx-none');
        } catch {
          // a nicety
        }
        const place = target ? { active: target.active, scroll: target.scroll } : state.places?.[m.dir];
        active = place?.active;
        state = { ...state, dir: m.dir, active: place?.active, scroll: place?.scroll };
      } else if (target) {
        active = target.active;
        state = { ...state, active: target.active, scroll: target.scroll };
      }
      // Anywhere else new (a dive, a sidestory opened here): a new entry, as a link in a browser.
      const cur = navHistory.current;
      if (!target && !(cur && samePage(cur, { dir: m.dir, trail: names }))) {
        navHistory.push({ dir: m.dir, trail: names, title: m.title, active: m.active ?? state.active });
      }
      // The panel's shell may have been built for another folder (it is rebuilt when hidden and shown).
      if (new URL(m.base).href !== baseUrl) {
        assets.invalidate();
        baseUrl = new URL(m.base).href;
        assets = new Assets(baseUrl, requestAsset);
      }
      const left = trail.length > m.trail.length ? trail[m.trail.length]?.name : undefined;
      const wasInitialized = initialized;
      trail = m.trail;
      state = { ...state, trail: names, history: navHistory.toJSON() };
      vscode.setState(state);
      renderTrail();
      renderHistory();
      anchors = new Map(m.anchors.map((a) => [a.id, a]));
      pendingInit = { active: m.active, after: entering && wasInitialized ? () => arrived(m.title, left) : undefined };
      void render(m.title, m.html, false);
      break;
    }
    case 'details':
      for (const d of m.items) {
        details.set(d.name, d);
        describing.delete(d.name);
      }
      decorate();
      break;
    case 'childHint':
      showDivePill(m.name, m.title);
      break;
    case 'content':
      // Always render the newest content, even if the first render is still loading its assets.
      void render(m.title, m.html, initialized);
      break;
    case 'assetsChanged':
      assets.invalidate(m.paths);
      if (lastRender) void render(lastRender.title, lastRender.html, initialized);
      break;
    case 'anchors':
      anchors = new Map(m.anchors.map((a) => [a.id, a]));
      decorate();
      break;
    case 'menu':
      onMenu(m.action);
      break;
    case 'syncTo':
      if (m.jump && initialized) navHistory.update(hereEntry());
      followEditor(m.anchorId, !!m.jump);
      // Go to Step, a CodeLens: the reader asked for this step, as for a tab.
      if (m.jump && initialized && active === m.anchorId) remember('push');
      break;
    case 'here':
      here = { ref: typeof m.ref === 'string' ? m.ref : undefined, link: typeof m.link === 'string' ? m.link : undefined };
      markHere();
      break;
    case 'navigate':
      if (initialized) step(m.delta);
      else if (pendingSteps.length < 20) pendingSteps.push(m.delta);
      break;
    case 'history':
      goHistory(m.delta === -1 ? -1 : 1);
      break;
    case 'historyFailed': {
      // The extension couldn't show what the panel is waiting for (gone, or out of reach): stop waiting, and forget it.
      if (!pendingHistory || m.id !== pendingHistory.id) break; // another request's, or one already given up on
      setPending(undefined);
      const title = navHistory.drop({ dir: m.dir, trail: m.trail });
      persistHistory();
      if (title !== undefined) announce(m.reason === 'gone' ? `${title} is no longer available` : `${title} can't be opened from here`);
      break;
    }
    case 'asset': {
      const resolve = pendingAssets.get(m.id);
      pendingAssets.delete(m.id);
      resolve?.(m.data && m.mime ? new Blob([Uint8Array.from(atob(m.data), (c) => c.charCodeAt(0))], { type: m.mime }) : null);
      break;
    }
    case 'widgets':
      widgets?.setGate(m.gate);
      break;
    case 'widget':
      widgets?.onBuild(m.src, m.build);
      break;
    case 'widgetLibs':
      widgets?.onLibs(m.libs);
      break;
    case 'widgetCode':
      widgets?.onCode(m.src, m.code);
      break;
    case 'widgetsReset':
      widgets?.reset(m.phase);
      break;
    case 'widgetStates':
      widgets?.restoreStates(m.states);
      break;
    case 'highlighted':
    case 'highlightTheme':
      highlighter.onMessage(m);
      break;
    case 'preview':
      previewEl.hidden = !m.on;
      break;
    case 'settings':
      hoverCard?.setMode(['card', 'editor', 'both', 'off'].includes(m.hoverPreview) ? m.hoverPreview : 'off');
      break;
    case 'codePreview':
      hoverCard?.onReply(m);
      break;
    case 'focusQuery':
      widgets?.focusAnswer(m.id);
      break;
    case 'error':
      bannerEl.hidden = m.message === null;
      bannerText.textContent = m.message ?? '';
      bannerOpen.hidden = !/manifest|linked/.test(m.message ?? '') || /^Can't read/.test(m.message ?? '');
      break;
  }
});

// ---- rendering ----

let renderSeq = 0;

/** Renders explainer HTML into the frame. Resolves false if a newer render overtook this one. */
async function render(title: string, html: string, isUpdate: boolean): Promise<boolean> {
  const seq = ++renderSeq;
  lastRender = { title, html };
  hoverCard?.hide(); // the link it is for may change or go
  const parsed = sanitize(html, baseUrl, frame.importNode);
  for (const w of parsed.warnings) {
    if (warned.has(w) || warned.size > 50) continue;
    warned.add(w);
    vscode.postMessage({ type: 'widgetLog', src: '', level: 'warn', message: `sidestory.html: ${w}` });
  }
  const next = frame.createElement('div');
  next.append(...parsed.styles, ...parsed.body);
  await assets.localize(next, frame.createElement);
  if (seq !== renderSeq) return false;
  titleEl.textContent = title;
  // Stable ids let the morph match sections across edits.
  for (const el of next.querySelectorAll<HTMLElement>('[data-explain-anchor]')) if (!el.id) el.id = `cx-a-${el.dataset.explainAnchor}`;
  // Give the incoming tree the attributes this script adds, so the morph leaves them alone
  // (removing tabindex from a focused link would blur it).
  decorateTree(next);
  const nextActive = pendingInit?.active ?? active;
  for (const el of next.querySelectorAll<HTMLElement>('[data-explain-anchor]')) if (el.dataset.explainAnchor === nextActive) el.classList.add('cx-active');
  // Diagram lighting and cursor rings too: set after the morph, fitFrame's style flush would restart their fades.
  const incoming = new Diagrams();
  incoming.index(next);
  incoming.apply(litIds(next, nextActive));
  const keys = hereKeys();
  for (const { el, key } of linkedElements(next)) el.classList.toggle('cx-here', keys.has(key));

  const before = isUpdate ? snapshot() : new Map<string, string>();
  const keep = isUpdate ? readingPosition() : undefined;
  Idiomorph.morph(content, next, {
    morphStyle: 'innerHTML',
    ignoreActiveValue: true,
    restoreFocus: true,
    // data-cx-off is the visibility observer's: it only says so again when visibility changes.
    callbacks: {
      // Colored code blocks whose text didn't change are left alone (spans and all).
      beforeNodeMorphed: (old, nextNode) => highlighter.morph(old, nextNode) && keepReaderState(old, nextNode),
      beforeAttributeUpdated: (name, el, type) =>
        name !== 'data-cx-off' &&
        // An input with no value in the source: what the reader typed or slid to stands (idiomorph would clear it).
        !(name === 'value' && type === 'remove' && el.localName === 'input' && !el.hasAttribute('value')),
    },
  });
  highlighter.afterRender();
  fitFrame();
  if (keep) restorePosition(keep);
  if (isUpdate) markUpdated(before);
  needsIndex = true;
  // The step the new page opens at, before decorating: lighting it once, as the incoming tree was lit.
  if (pendingInit) active = pendingInit.active ?? active;
  decorate();
  if (pendingInit) {
    const init = pendingInit;
    pendingInit = undefined;
    // A section the extension asked for (Go to Step, a CodeLens) wins over the place saved for this sidestory.
    if (init.active && init.active !== state.active) state = { ...state, scroll: undefined };
    active = init.active ?? active;
    restoreScroll();
    if (!active) active = openingStep();
    markActive();
    // A section the page chose itself (not the one the extension sent): the extension shows its code when no
    // editor is open, and otherwise only highlights it, so opening a sidestory never takes over the reader's editor.
    if (active && active !== init.active) vscode.postMessage({ type: 'focusAnchor', anchorId: active, source: 'initial' });
    initialized = true;
    noteHistory();
    init.after?.();
    for (const d of pendingSteps.splice(0)) step(d);
  } else if (initialized && !active && steps.length) {
    // The page had no steps when it opened (its content arrived after `init`): open at the first, as `init` does.
    active = openingStep();
    markActive();
    if (active) vscode.postMessage({ type: 'focusAnchor', anchorId: active, source: 'initial' });
  }
  return true;
}

/**
 * Switches, tabs, open <details> and typed text are the reader's, not the author's: an edit elsewhere
 * in the explainer keeps them. Only when the author changes that element's own default (its checked,
 * value, selected or open attribute) does the new default win.
 */
function keepReaderState(old: Node, next: Node): boolean {
  if (old.nodeType !== 1 || next.nodeType !== 1) return true;
  const o = old as HTMLElement;
  const n = next as HTMLElement;
  if (o.localName !== n.localName) return true;
  const same = (attr: string) => o.getAttribute(attr) === n.getAttribute(attr);
  switch (o.localName) {
    case 'input': {
      const oi = o as HTMLInputElement;
      const ni = n as HTMLInputElement;
      if (oi.type !== ni.type) break;
      if (same('checked')) ni.checked = oi.checked;
      if (same('value') && oi.type !== 'file') ni.value = oi.value;
      break;
    }
    case 'option':
      if (same('selected')) (n as HTMLOptionElement).selected = (o as HTMLOptionElement).selected;
      break;
    case 'textarea':
      if ((o as HTMLTextAreaElement).defaultValue === (n as HTMLTextAreaElement).defaultValue) (n as HTMLTextAreaElement).value = (o as HTMLTextAreaElement).value;
      break;
    case 'details':
    case 'dialog':
      // `open` is both the author's default and the reader's state; data-cx-open remembers the default.
      if (o.dataset.cxOpen === n.dataset.cxOpen) n.toggleAttribute('open', o.hasAttribute('open'));
      break;
  }
  return true;
}

/** The HTML of each section, to tell which ones an update changed. */
function snapshot(): Map<string, string> {
  return new Map([...content.querySelectorAll<HTMLElement>('[data-explain-anchor]')].map((el) => [el.dataset.explainAnchor!, cleanHtml(el)]));
}

/** A section's HTML without the attributes this script adds. */
function cleanHtml(el: HTMLElement): string {
  const c = highlighter.plainClone(el);
  for (const d of c.querySelectorAll('.cx-detail, .cx-fix, .cx-widget-bar, .cx-widget-desc, .cx-widget-error')) d.remove();
  for (const w of c.querySelectorAll<HTMLElement>('explain-widget')) {
    for (const a of ['data-cx-w', 'data-cx-wstate', 'data-cx-showfb', 'tabindex', 'role', 'aria-label', 'aria-describedby']) w.removeAttribute(a);
    w.style.removeProperty('--cx-wh');
  }
  // Compare what the author wrote, not what the reader opened or closed.
  for (const d of c.querySelectorAll<HTMLElement>('[data-cx-open]')) {
    d.toggleAttribute('open', d.dataset.cxOpen === '1');
    d.removeAttribute('data-cx-open');
  }
  for (const x of [c, ...c.querySelectorAll<HTMLElement>('*')]) {
    x.classList.remove('cx-active', 'cx-updated', 'cx-here', ...DIAGRAM_CLASSES);
    if (x.classList.length === 0) x.removeAttribute('class');
    for (const a of ['data-cx-state', 'data-cx-label', 'data-cx-off']) x.removeAttribute(a);
    if (x.hasAttribute('data-cx-ref')) for (const a of ['data-cx-ref', 'tabindex', 'role']) x.removeAttribute(a);
    if (x.dataset.cxTitled) {
      x.removeAttribute('title');
      x.removeAttribute('data-cx-titled');
    }
    x.style.removeProperty('--cx-accent');
    if (x.getAttribute('style') === '') x.removeAttribute('style');
  }
  return c.outerHTML;
}

function markUpdated(before: Map<string, string>): void {
  const changed: string[] = [];
  for (const el of content.querySelectorAll<HTMLElement>('[data-explain-anchor]')) {
    const id = el.dataset.explainAnchor!;
    if (before.get(id) === cleanHtml(el)) continue;
    changed.push(stepLabel(el, id));
    el.classList.add('cx-updated');
    setTimeout(() => el.classList.remove('cx-updated'), UPDATED_MS);
  }
  if (changed.length) announce(`${changed.join(', ')} updated`);
}

/** Section states, accents and inline-reference behaviour, on any tree (live or about to be morphed in). */
function decorateTree(root: HTMLElement): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-explain-anchor]')) {
    const a = anchors.get(el.dataset.explainAnchor!);
    const s = a?.state ?? 'unknown';
    el.dataset.cxState = s;
    const text = STATE_TEXT[s];
    el.setAttribute('data-cx-label', text?.badge ?? '');
    // Explain the state on the section's heading (not the whole section, which you hover while reading).
    const heading = el.querySelector<HTMLElement>('h1, h2, h3, h4, h5, h6');
    if (heading && text && (!heading.hasAttribute('title') || heading.dataset.cxTitled)) {
      heading.title = text.title;
      heading.dataset.cxTitled = '1';
    } else if (heading && !text && heading.dataset.cxTitled) {
      heading.removeAttribute('title');
      delete heading.dataset.cxTitled;
    }
    if (a?.colorVar) el.style.setProperty('--cx-accent', `var(${a.colorVar})`);
    else el.style.removeProperty('--cx-accent');
    // A section whose code is gone or much changed offers to point it at the code again.
    let fix = [...el.children].find((c) => ownBox(c) && c.classList.contains('cx-fix')) as HTMLElement | undefined;
    if (s === 'stale' || s === 'lost') {
      if (!fix) {
        fix = frame.createElement('div');
        fix.className = 'cx-fix';
        fix.setAttribute('data-cx-box', BOX_TOKEN);
        fix.innerHTML = staticHtml`<button type="button" class="cx-reanchor">Re-anchor to the selected code</button>` as unknown as string;
        fix.querySelector('button')!.title = 'Select the code this section explains in the editor, then click';
        el.append(fix);
      }
    } else fix?.remove();
  }
  // Inline references and code links behave like links for the keyboard and screen readers (data-cx-ref marks them,
  // and gives them the built-in look). Not form controls (see LABELABLE), nor code links that don't parse.
  for (const ref of root.querySelectorAll<HTMLElement>('[data-explain-ref], [data-explain-code]')) {
    if (ref.matches(LABELABLE)) {
      warnOnce(`a link (data-explain-ref, data-explain-code) on a <${ref.localName}> is ignored: a click on a form control is for the control. Put it on another element.`);
      continue;
    }
    if (!ref.hasAttribute('data-explain-ref') && !codeLinkOf(ref)) {
      warnOnce(`data-explain-code="${(ref.getAttribute('data-explain-code') ?? '').slice(0, 100)}" isn't a valid code link (a path from the repository root, optionally #L10, #L10-L20 or #symbol; an empty path needs data-explain-code-file on an ancestor). It was ignored.`);
      continue;
    }
    ref.dataset.cxRef = '1';
    if (!ref.hasAttribute('tabindex')) ref.tabIndex = 0;
    if (!ref.hasAttribute('role') && !(ref.localName === 'a' && ref.hasAttribute('href'))) ref.setAttribute('role', 'link');
  }
  // The author's `open`, before the reader toggles it (see keepReaderState).
  for (const el of root.querySelectorAll<HTMLElement>('details, dialog')) if (el.dataset.cxOpen === undefined) el.dataset.cxOpen = el.hasAttribute('open') ? '1' : '0';
  decorateDetails(root);
  widgets?.decorate(root);
}

/**
 * Elements marked data-explain-detail="<explainer>" name a more detailed explainer (a sibling folder).
 * Each gets controls to peek at its summary here or dive into it; readers who don't care just read on.
 */
function decorateDetails(root: HTMLElement): void {
  const unknown: string[] = [];
  for (const host of root.querySelectorAll<HTMLElement>('[data-explain-detail]')) {
    const name = host.dataset.explainDetail!;
    let box = [...host.children].find(ownBox) as HTMLElement | undefined;
    // Not inside links or controls (a click there means something else), and only real names.
    if (!DETAIL_NAME.test(name) || host.closest('a, button, label, summary, [data-explain-ref], [data-explain-code]')) {
      box?.remove();
      continue;
    }
    const info = details.get(name);
    if (!info && !describing.has(name)) unknown.push(name);
    if (!box) {
      box = frame.createElement('div');
      box.className = 'cx-detail';
      box.innerHTML = staticHtml`<div class="cx-detail-row"><button type="button" class="cx-peek" aria-expanded="false"></button><button type="button" class="cx-dive"></button><span class="cx-detail-steps"></span></div><p class="cx-peek-body" hidden></p>` as unknown as string;
      host.append(box);
      box.setAttribute('data-cx-box', BOX_TOKEN);
    }
    const title = info?.title || name;
    const missing = info?.found === false;
    const depth = trail.findIndex((t) => t.name === name);
    const open = peeked.has(name) && !missing;
    const peek = box.querySelector<HTMLButtonElement>('.cx-peek')!;
    const dive = box.querySelector<HTMLButtonElement>('.cx-dive')!;
    const body = box.querySelector<HTMLElement>('.cx-peek-body')!;
    setText(peek, `${open ? '▾' : '▸'} ${title} in brief`);
    peek.setAttribute('aria-expanded', String(open));
    peek.disabled = missing;
    setText(dive, missing ? `No sidestory named “${name}”` : depth === trail.length - 1 ? 'You are reading it' : depth >= 0 ? `‹ Up to ${title}` : `Dive into ${title} ›`);
    dive.disabled = missing || depth === trail.length - 1;
    setText(box.querySelector('.cx-detail-steps')!, info?.found ? `${info.steps} step${info.steps === 1 ? '' : 's'}` : '');
    setText(body, info?.summary || (info ? 'No summary.' : 'Loading…'));
    body.hidden = !open;
  }
  if (unknown.length) {
    // In batches the extension accepts; the next decorate asks for the rest.
    const names = [...new Set(unknown)].slice(0, 50);
    for (const n of names) describing.add(n);
    vscode.postMessage({ type: 'describe', names });
  }
}

function renderTrail(): void {
  trailEl.hidden = trail.length < 2;
  trailEl.replaceChildren(
    ...trail.flatMap((t, i) => {
      const last = i === trail.length - 1;
      const item = document.createElement(last ? 'span' : 'button');
      item.className = 'cx-crumb';
      item.textContent = t.title || t.name;
      if (last) item.setAttribute('aria-current', 'page');
      else {
        (item as HTMLButtonElement).type = 'button';
        item.addEventListener('click', () => goTo(i));
      }
      if (i === 0) return [item];
      const sep = document.createElement('span');
      sep.className = 'cx-crumb-sep';
      sep.setAttribute('aria-hidden', 'true');
      sep.textContent = '›';
      return [sep, item];
    }),
  );
  const parent = trail.at(-2);
  backEl.hidden = !parent;
  if (parent) backEl.textContent = `‹ Up to ${parent.title || parent.name}`;
}

/** After a dive or going back: say where the reader is, and put focus somewhere sensible. */
function arrived(title: string, leftDetail: string | undefined): void {
  announce(leftDetail ? `Back to ${title}` : `Opened ${title}`);
  if (!app.contains(document.activeElement) && document.activeElement !== document.body && !frame.root.contains(frame.root.ownerDocument.activeElement)) return;
  if (document.activeElement?.classList.contains('cx-hist')) return; // pressing Back again goes on back
  const dive = leftDetail ? [...content.querySelectorAll<HTMLElement>('[data-explain-detail]')].find((h) => h.dataset.explainDetail === leftDetail)?.querySelector<HTMLElement>('.cx-dive') : undefined;
  if (dive) {
    focusingSelf = true; // not the reader tabbing into its section
    dive.focus({ preventScroll: true });
    focusingSelf = false;
    return;
  }
  titleEl.tabIndex = -1;
  titleEl.focus({ preventScroll: true });
}

function goTo(depth: number): void {
  if (depth >= trail.length - 1) return;
  savePlace();
  // Up to where the reader just came from: that's Back, so Forward returns here.
  expectEntry(-1, trail.slice(0, depth + 1).map((t) => t.name));
  vscode.postMessage({ type: 'goTo', depth, id: navRequestId });
}

function dive(name: string): void {
  // Already on the way here (a detail that points back to its overview): go back up instead.
  const i = trail.findIndex((t) => t.name === name);
  if (i >= 0) return goTo(i);
  savePlace();
  // Into the detail the reader just came back from: that's Forward, so what lay beyond it stays.
  expectEntry(1, [...trail.map((t) => t.name), name]);
  vscode.postMessage({ type: 'dive', name, id: navRequestId });
}

/** A sibling sidestory's folder (details live next to each other under `.sidestory/`). */
const siblingDir = (name: string) => state.dir.replace(/[^/]*$/, name);

/** If the entry `delta` away is the page a trail move leads to, its `init` makes that entry current. */
function expectEntry(delta: 1 | -1, names: string[]): void {
  const index = navHistory.position + delta;
  const e = navHistory.at(index);
  const id = ++navRequestId;
  setPending(e && samePage(e, { dir: siblingDir(names.at(-1)!), trail: names }) ? { index, dir: e.dir, trail: e.trail, id } : undefined);
  renderHistory();
}

/** Applies anchor states, accents and the active section, then rebuilds the navigator. */
function decorate(): void {
  decorateTree(content);
  const all = [...content.querySelectorAll<HTMLElement>('[data-explain-anchor]')];
  steps = all
    .filter((el) => !el.parentElement?.closest('[data-explain-anchor]'))
    .map((el) => ({ id: el.dataset.explainAnchor!, el, label: stepLabel(el, el.dataset.explainAnchor!) }));
  if (active && !steps.some((s) => s.id === active) && !anchors.has(active)) active = undefined;
  offscreen.disconnect(); // sections the morph replaced aren't watched forever
  for (const s of steps) offscreen.observe(s.el);
  svgClocks(content);
  // Only after a render: `anchors` arrives on every keystroke in linked code, and changes no diagram.
  if (needsIndex) {
    needsIndex = false;
    diagrams.index(content);
  }
  if (diagrams.capped) warnOnce(`more than ${MAX_TAGGED.toLocaleString('en')} elements have data-explain-on; diagrams don't light up in this sidestory.`);
  linkEls = linkedElements(content);
  markHere();
  sendCodeTargets();
  renderNavigator();
  renderStatus();
  markActive();
  widgets?.refresh();
  widgets?.onAnchors();
  comments?.decorate();
}

/** The shared rule (src/core/step-title.ts): an empty title falls through, as in the workspace index. */
function stepLabel(el: HTMLElement, id: string): string {
  return stepTitle(el.dataset.explainTitle, el.querySelector('h1, h2, h3, h4')?.textContent, id);
}

function spokenState(id: string): string {
  const s = anchors.get(id)?.state ?? 'unknown';
  const t = STATE_TEXT[s];
  return t ? `, ${t.spoken}` : '';
}

/** Keeps one button, option and progress segment per step, updated in place (a focused button survives edits). */
function renderNavigator(): void {
  const buttons = new Map([...stepsEl.querySelectorAll<HTMLButtonElement>('.cx-step')].map((b) => [b.dataset.anchor!, b]));
  const ordered = steps.map((s) => {
    let b = buttons.get(s.id);
    if (!b) {
      b = document.createElement('button');
      b.type = 'button';
      b.className = 'cx-step';
      b.dataset.anchor = s.id;
      // Visible: "1  Interface". Spoken: "Step 1: Interface, out of date" (the hidden parts carry the rest).
      b.innerHTML = staticHtml`<span class="cx-sr cx-step-prefix"></span><span class="cx-step-num" aria-hidden="true"></span><span class="cx-step-label"></span><span class="cx-sr cx-step-state"></span>` as unknown as string;
    }
    buttons.delete(s.id);
    return b;
  });
  for (const stale of buttons.values()) stale.remove();
  ordered.forEach((b, i) => {
    if (stepsEl.children[i] !== b) stepsEl.insertBefore(b, stepsEl.children[i] ?? null);
  });
  while (selectEl.options.length > steps.length) selectEl.remove(selectEl.options.length - 1);
  while (selectEl.options.length < steps.length) selectEl.add(document.createElement('option'));
  while (progressEl.children.length > steps.length) progressEl.lastElementChild!.remove();
  while (progressEl.children.length < steps.length) progressEl.append(document.createElement('span'));

  steps.forEach((s, i) => {
    const b = ordered[i]!;
    setText(b.querySelector('.cx-step-prefix')!, `Step ${i + 1}: `);
    setText(b.querySelector('.cx-step-num')!, String(i + 1));
    setText(b.querySelector('.cx-step-label')!, s.label);
    setText(b.querySelector('.cx-step-state')!, spokenState(s.id));
    b.title = s.label;
    const accent = anchors.get(s.id)?.colorVar;
    const stateName = anchors.get(s.id)?.state ?? 'unknown';
    for (const el of [b, progressEl.children[i] as HTMLElement]) {
      if (accent) el.style.setProperty('--cx-accent', `var(${accent})`);
      else el.style.removeProperty('--cx-accent');
      el.dataset.cxState = stateName;
    }
    const o = selectEl.options[i]!;
    o.value = s.id;
    setText(o, `${i + 1}. ${s.label}${spokenState(s.id) ? ` (${spokenState(s.id).slice(2)})` : ''}`);
  });
  fitSteps();
}

/** Each tab needs room for its number and a few letters of its name; with less, use the picker. */
const MIN_LABEL_PX = 56;
const STEP_CHROME_PX = 48; // number, gaps, padding, border
function fitSteps(): void {
  const width = headerEl.clientWidth - parseFloat(getComputedStyle(headerEl).paddingLeft) * 2;
  const n = steps.length;
  const perLabel = (width - 4 * (n - 1)) / n - STEP_CHROME_PX;
  app.classList.toggle('cx-cramped', n > 1 && perLabel < MIN_LABEL_PX);
}

function setText(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

function renderStatus(): void {
  const counts = { stale: 0, lost: 0 };
  for (const a of anchors.values()) if (a.state === 'stale' || a.state === 'lost') counts[a.state]++;
  // Sections whose anchor is missing from the manifest or invalid there (the banner says why).
  const unlinked = new Set([...content.querySelectorAll<HTMLElement>('[data-explain-anchor]')].map((el) => el.dataset.explainAnchor!).filter((id) => !anchors.has(id))).size;
  const parts = [counts.stale && `${counts.stale} out of date`, counts.lost && `${counts.lost} not found`, unlinked && `${unlinked} not linked`].filter(Boolean) as string[];
  const text = parts.length ? parts.join(' · ') : 'Linked';
  // Only touch the DOM when something changed: this runs on every keystroke in linked code.
  if (statusText.textContent === text) return;
  statusText.textContent = text;
  statusEl.dataset.ok = String(parts.length === 0);
  statusEl.title = parts.length ? 'Some sections no longer match their code' : 'Every section matches its code';
  statusIcon.className = `codicon ${parts.length ? 'codicon-warning' : 'codicon-link'}`;
  if (initialized && parts.length) announce(text);
}

function markActive(): void {
  const stepId = activeStepId();
  const index = steps.findIndex((s) => s.id === stepId);
  for (const el of content.querySelectorAll<HTMLElement>('.cx-active')) el.classList.remove('cx-active');
  if (active) sectionEl(active)?.classList.add('cx-active');
  diagrams.apply({ active, step: stepId });
  // Lit diagram parts take the color of what's active (--cx-on defaults to it). On the content root, which the morph
  // never touches, so no section's HTML changes.
  const accent = (active && anchors.get(active)?.colorVar) || (stepId && anchors.get(stepId)?.colorVar);
  if (accent) content.style.setProperty('--cx-step-accent', `var(${accent})`);
  else content.style.setProperty('--cx-step-accent', 'var(--vscode-sidestory-focusBorder, var(--vscode-focusBorder))');
  [...stepsEl.children].forEach((b, i) => {
    if (i === index) b.setAttribute('aria-current', 'step');
    else b.removeAttribute('aria-current');
    // One Tab stop for the whole bar (the current step); arrow keys move between steps.
    (b as HTMLButtonElement).tabIndex = i === Math.max(index, 0) ? 0 : -1;
    b.classList.toggle('cx-done', index >= 0 && i < index);
  });
  [...progressEl.children].forEach((p, i) => p.classList.toggle('cx-on', index >= 0 && i <= index));
  if (index >= 0) selectEl.value = steps[index]!.id;
  positionEl.textContent = steps.length ? `Step ${index >= 0 ? index + 1 : '–'} of ${steps.length}` : 'No linked sections';
  for (const b of app.querySelectorAll<HTMLButtonElement>('.cx-nav')) {
    b.disabled = steps.length === 0 || (b.dataset.delta === '-1' ? index <= 0 : index === steps.length - 1);
  }
  widgets?.onActive(active);
  comments?.onActive();
}

/** The step containing the active anchor (which may be nested inside a step). */
function activeStepId(): string | undefined {
  if (!active) return undefined;
  const el = sectionEl(active);
  return steps.find((s) => el && s.el.contains(el))?.id;
}

// ---- moving between sections ----

/** Makes a section current. Choosing the current one again (a click, a step) still reveals its code. */
function setActive(id: string | undefined, notify?: Source): void {
  if (id === active) {
    if (id && notify && notify !== 'scroll') vscode.postMessage({ type: 'focusAnchor', anchorId: id, source: notify });
    return;
  }
  active = id;
  if (widgetHold && id !== widgetHold.to) widgetHold = undefined;
  markActive();
  saveState();
  if (!id || !notify) return;
  clearTimeout(focusTimer);
  const send = () => vscode.postMessage({ type: 'focusAnchor', anchorId: id, source: notify });
  if (notify === 'scroll') focusTimer = setTimeout(send, 120);
  else send();
}

function holdForWidget(before: string | undefined, from: string | undefined): void {
  if (active === before) return; // nothing moved
  widgetHold = active ? { to: active, from, dir: state.dir } : undefined;
}

/** The widget hold applies: still on that page, at that step (other paths set `active` without setActive). */
function held(): boolean {
  return !!widgetHold && widgetHold.to === active && widgetHold.dir === state.dir;
}

function scrollToSection(id: string): void {
  const el = sectionEl(id);
  if (!el) return;
  scrollTarget = { id, until: Date.now() + 1500 };
  scrollToTop(topOf(el));
  notePlaceWhenSettled();
}

/** Scrolls the panel so that a point (in panel coordinates) sits just below the top. */
function scrollToTop(top: number): void {
  scroller.scrollTo({ top: scroller.scrollTop + top - scroller.getBoundingClientRect().top - 12, behavior: reducedMotion() ? 'auto' : 'smooth' });
}

function step(delta: 1 | -1, scroll = true): void {
  if (steps.length === 0) return;
  const i = steps.findIndex((s) => s.id === activeStepId());
  const target = steps[Math.min(steps.length - 1, Math.max(0, i < 0 ? 0 : i + delta))]!;
  if (target.id === activeStepId()) return; // already at the first or last step
  hidePill();
  if (initialized) navHistory.update(hereEntry());
  setActive(target.id, 'step');
  if (scroll) scrollToSection(target.id);
  if (initialized) remember('step');
}

/** The reader chose a step (a tab, the picker, a comment): a new history entry, as a link in a browser. */
function jumpTo(id: string, source?: Source): void {
  hidePill();
  if (initialized) navHistory.update(hereEntry());
  setActive(id, source);
  scrollToSection(id);
  if (initialized) remember('push');
}

/**
 * The reader chose a step where the page already is (a click in its text or a widget, Tab into it, a widget's
 * goToStep): no scroll, a history entry as for a jump (`step`: one entry for a run, as J/K). The current step again
 * does nothing, so a click that only gives the panel focus doesn't send the editor back to the step's code.
 */
function pick(id: string, source: Source, kind: 'push' | 'step' = 'push'): void {
  if (id === active) return;
  hidePill();
  if (initialized) navHistory.update(hereEntry());
  setActive(id, source);
  if (initialized) remember(kind);
}

// ---- history (Back / Forward) ----

/** The page shown, as history entries name it. */
const shownPage = () => ({ dir: state.dir, trail: trail.map((t) => t.name) });

/** Where the reader is now, as a history entry. */
function hereEntry(): HistoryEntry {
  const n = steps.findIndex((s) => s.id === activeStepId());
  return { ...shownPage(), title: titleEl.textContent || trail.at(-1)?.title || '', active, step: n >= 0 ? n + 1 : undefined, scroll: readingPosition() };
}

/** A new entry for the step just made current; its scroll is recorded once the page settles there (savePlace). */
function remember(kind: 'push' | 'step'): void {
  const e = { ...hereEntry(), scroll: undefined };
  if (kind === 'push') navHistory.push(e);
  else navHistory.step(e);
  persistHistory();
}

function noteHistory(): void {
  if (initialized) navHistory.update(hereEntry());
  persistHistory();
}

function persistHistory(): void {
  state = { ...state, history: navHistory.toJSON() };
  vscode.setState(state);
  renderHistory();
}

const describeEntry = (e: HistoryEntry) => `${e.title || e.trail.at(-1)}${e.step ? ` · step ${e.step}` : ''}`;

/** The buttons' shortcuts: the page's own on macOS; elsewhere VS Code's, which run Sidestory: Back / Forward. */
const HIST_KEYS = MAC
  ? { Back: ['⌘[', 'Meta+BracketLeft'], Forward: ['⌘]', 'Meta+BracketRight'] }
  : { Back: ['Alt+←', 'Alt+ArrowLeft'], Forward: ['Alt+→', 'Alt+ArrowRight'] };
histBack.setAttribute('aria-keyshortcuts', HIST_KEYS.Back[1]!);
histForward.setAttribute('aria-keyshortcuts', HIST_KEYS.Forward[1]!);
/** What the extension was last told (it lets VS Code's own Go Back / Forward act when the panel has nowhere to go). */
let sentNav = '';

function renderHistory(): void {
  const at = pendingHistory?.index ?? navHistory.position;
  const can: boolean[] = [];
  for (const [b, delta, word] of [[histBack, -1, 'Back'], [histForward, 1, 'Forward']] as const) {
    const e = navHistory.at(at + delta);
    can.push(!!e);
    const label = e ? `${word} to ${describeEntry(e)}` : word;
    const title = `${word} (${HIST_KEYS[word][0]})${e ? ` to ${describeEntry(e)}` : ''}`;
    // aria-disabled, not disabled: a focused button that runs out keeps focus.
    b.setAttribute('aria-disabled', String(!e));
    if (b.title !== title) b.title = title;
    if (b.getAttribute('aria-label') !== label) b.setAttribute('aria-label', label);
  }
  const [canBack = false, canForward = false] = can;
  if (sentNav !== `${canBack}${canForward}`) {
    sentNav = `${canBack}${canForward}`;
    vscode.postMessage({ type: 'historyState', canBack, canForward });
  }
}

let pendingTimer: ReturnType<typeof setTimeout> | undefined;
/** Waits for a Back or Forward to another sidestory; one that never arrives is given up after a while. */
function setPending(p: typeof pendingHistory): void {
  pendingHistory = p;
  clearTimeout(pendingTimer);
  if (p) {
    pendingTimer = setTimeout(() => {
      pendingHistory = undefined;
      renderHistory();
    }, 10_000);
  }
}

/** Back (-1) or Forward (1): the step and scroll position as the reader left them, in whichever sidestory. */
function goHistory(delta: 1 | -1): void {
  const index = (pendingHistory?.index ?? navHistory.position) + delta;
  const e = navHistory.at(index);
  if (!e) return;
  hidePill();
  hoverCard?.hide();
  if (!pendingHistory && initialized && samePage(e, shownPage())) {
    navHistory.update(hereEntry());
    navHistory.go(index);
    restoreEntry(e);
    persistHistory();
    announce(`${delta < 0 ? 'Back' : 'Forward'} to ${describeEntry(e)}`);
    return;
  }
  if (initialized) savePlace();
  const id = ++navRequestId;
  setPending({ index, dir: e.dir, trail: e.trail, id });
  vscode.postMessage(e.active ? { type: 'openHistory', dir: e.dir, trail: e.trail, active: e.active, id } : { type: 'openHistory', dir: e.dir, trail: e.trail, id });
  renderHistory();
}

/** Puts the reader back on an entry of the page shown: its step (the editor follows), then its scroll position. */
function restoreEntry(e: HistoryEntry): void {
  const id = e.active && (anchors.has(e.active) || sectionEl(e.active)) ? e.active : undefined;
  if (id) setActive(id, 'step');
  const el = e.scroll && sectionEl(e.scroll.anchor);
  if (!el || !e.scroll) {
    if (id) scrollToSection(id);
    return;
  }
  scrollTarget = undefined;
  const top = scroller.scrollTop + topOf(el) - scroller.getBoundingClientRect().top - e.scroll.offset;
  scroller.scrollTo({ top, behavior: reducedMotion() ? 'auto' : 'smooth' });
  notePlaceWhenSettled();
}

/**
 * The editor's cursor moved into a step's code, or the reader asked for a step from the editor (`jump`: Go to Step, a
 * CodeLens). Only the asking moves the panel: a cursor offers the step (the pill), so diagrams, widgets and the page
 * stay where the reader left them until they click.
 */
function followEditor(id: string, jump: boolean): void {
  if (!anchors.has(id)) return;
  const el = sectionEl(id);
  if (!el) return;
  if (!jump) {
    if (id !== active) showPill(id, el);
    return;
  }
  hidePill();
  setActive(id);
  scrollToSection(id);
}

function showPill(id: string, el: HTMLElement): void {
  pillShow.textContent = `Cursor is in “${stepLabel(el, id)}” · Show`;
  delete pillEl.dataset.dive;
  pillEl.dataset.anchor = id;
  if (pillEl.hidden) announce(`Editor cursor is in ${stepLabel(el, id)}`);
  pillEl.hidden = false;
  clearTimeout(pillTimer);
  pillTimer = setTimeout(hidePill, PILL_MS);
}

/** The editor cursor is in code a detail explainer covers: offer to dive into it. */
function showDivePill(name: string, title: string): void {
  if (!DETAIL_NAME.test(name)) return;
  pillShow.textContent = `Cursor is in ${title || name} · Dive`;
  delete pillEl.dataset.anchor;
  pillEl.dataset.dive = name;
  if (pillEl.hidden) announce(`Editor cursor is in ${title || name}`);
  pillEl.hidden = false;
  clearTimeout(pillTimer);
  pillTimer = setTimeout(hidePill, PILL_MS);
}

function hidePill(): void {
  clearTimeout(pillTimer);
  pillEl.hidden = true;
  delete pillEl.dataset.anchor;
  delete pillEl.dataset.dive;
}

/**
 * The step a sidestory opens at when nothing chose one: the section at the reading line. At the top, that's the
 * first step, however many short sections fit above the line.
 */
function openingStep(): string | undefined {
  return (scroller.scrollTop === 0 ? steps[0] : sectionAtReadingLine())?.id;
}

function sectionAtReadingLine(): Step | undefined {
  const view = scroller.getBoundingClientRect();
  if (scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) return steps[steps.length - 1];
  const y = view.top + view.height * READING_LINE;
  let found: Step | undefined;
  for (const s of steps) if (topOf(s.el) <= y) found = s;
  return found ?? steps[0];
}

let scrollFrame = 0;
scroller.addEventListener('scroll', () => {
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    hoverCard?.scrolled();
    widgets?.onScroll();
    saveState();
    // Where the reader is, however they got there, so a resize can put it back (not mid-resize, nor on the way
    // to a section: notePlaceWhenSettled records those once they end).
    if (placeSettled()) heldPlace = readingPosition();
    // Scrolling never picks the step: diagrams, widgets and the editor change only on a click or a key.
  });
});
// A hoisted function, not a const: the frame's listeners are attached (in buildFrame) before this line runs.
function bindFrameEvents(d: Document): void {
  d.addEventListener('click', onContentClick);
  d.addEventListener('keydown', onContentKey);
  d.addEventListener('keydown', noteKey, true);
  d.addEventListener('focusin', onContentFocus);
  d.addEventListener('contextmenu', onContentMenu);
  d.addEventListener('pointerdown', (e) => {
    if (!e.isTrusted) return;
    hoverCard?.hide(); // a click opens the code (or does something else): the card is done
    lastTabAt = 0; // the pointer, not the Tab, is the reader's last input
    aim(linkedTarget(e.target) ?? null);
  }, true);
  // The hover preview: resting on a linked element, by mouse or pen (a touch is a tap, which opens it).
  d.addEventListener('pointerover', (e) => {
    if (!e.isTrusted || e.pointerType === 'touch') return;
    const link = linkedTarget(e.target);
    if (link) hoverCard?.enter(link, false);
    else hoverCard?.pointerAway();
  });
  d.addEventListener('pointerout', (e) => {
    if (e.relatedTarget === null) hoverCard?.pointerAway(true); // out of the content
  });
  d.addEventListener('focusout', (e) => hoverCard?.blur(e.target as Element));
  d.addEventListener('keydown', () => hoverCard?.keyInContent(), true);
  // Last, on the frame's window: keys nothing in the page took are VS Code's (Cmd+Shift+P and the like).
  d.defaultView!.addEventListener('keydown', forwardKey);
  d.defaultView!.addEventListener('keyup', forwardKey);
  d.defaultView!.addEventListener('blur', () => passedDown.clear()); // their key-ups happen elsewhere
  for (const ev of ['mousedown', 'mouseup']) d.addEventListener(ev, onMouseNav as EventListener);
}

/**
 * VS Code only sees keys pressed in the panel's own document (keys.ts): one pressed in the content frame that the page
 * didn't handle and that VS Code may have a binding for is passed on, so its shortcuts work while reading.
 */
function forwardKey(e: KeyboardEvent): void {
  if (!e.isTrusted || e.defaultPrevented || e.isComposing || typingIn(e.target as Element)) return;
  const k = keyInfo(e);
  if (k.type === 'keyup') {
    // The release of a key passed on (or of a modifier): not of one the page kept.
    if (!passedDown.delete(k.code) && !forVsCode(k)) return;
  } else {
    if (!forVsCode(k)) return;
    passedDown.add(k.code);
    e.preventDefault(); // VS Code's, not the frame's (Alt+Left would navigate the frame)
  }
  passToVsCode(k);
}

/**
 * The mouse's back and forward buttons, as in a browser. Not in VS Code desktop on Windows: there the buttons are app
 * commands VS Code itself turns into its own Go Back / Go Forward, which would move the editor too.
 */
const OWN_MOUSE_NAV = !(WINDOWS && /Electron/.test(navigator.userAgent));
function onMouseNav(e: MouseEvent): void {
  if (!OWN_MOUSE_NAV || (e.button !== 3 && e.button !== 4)) return;
  e.preventDefault();
  if (e.type === 'mouseup') goHistory(e.button === 3 ? -1 : 1);
}

function noteKey(e: KeyboardEvent): void {
  lastKeyAt = Date.now();
  // Any other key clears it, so "the last key was a Tab" doesn't hang on two presses landing in the same millisecond.
  lastTabAt = e.isTrusted && e.key === 'Tab' ? lastKeyAt : 0;
}
document.addEventListener('keydown', noteKey, true);

/**
 * Tabbing from one section into another makes it the current step, as a click there would. Tabbing into the page
 * from outside it (the step bar, Back) doesn't: the first link of the page isn't where the reader is.
 */
function onContentFocus(e: FocusEvent): void {
  lastFocused = e.target as HTMLElement;
  // Aimed only when the reader's last input was a Tab that landed on the link itself (not on a control inside it, and
  // not an Enter on an in-page link whose target took focus).
  const link = linkedTarget(e.target) ?? null;
  if (link !== aimedLink) aim(link && link === e.target && !focusingSelf && lastKeyAt === lastTabAt && Date.now() - lastTabAt < 500 ? link : null);
  // The keyboard brought focus to a link (not a click, nor the panel itself): its card, as for the pointer.
  if (link && link === e.target && !focusingSelf && lastKeyAt === lastTabAt && Date.now() - lastTabAt < 500) hoverCard?.enter(link, true);
  // Only the reader's Tab (a click: the click handler decides; a key that opened something: not the reader's move).
  if (focusingSelf || lastKeyAt !== lastTabAt || Date.now() - lastTabAt > 500) return;
  const from = (e.relatedTarget as HTMLElement | null)?.closest?.<HTMLElement>('[data-explain-anchor]');
  const section = (e.target as HTMLElement).closest?.<HTMLElement>('[data-explain-anchor]');
  if (!from || !section || from === section || section.dataset.cxState === 'lost') return;
  pick(section.dataset.explainAnchor!, 'scroll', 'step');
}

/*
 * Coming back to the panel (after a reference took focus to the code), focus returns to where it
 * was rather than to the top of the page.
 */
document.addEventListener('focusin', (e) => {
  // Not a widget frame: the panel only ever moves focus into a widget on the reader's Enter or click.
  if (e.target !== frame.el && !(e.target as Element).classList?.contains('cx-widget-frame')) lastFocused = e.target as HTMLElement;
});
window.addEventListener('focus', () => {
  setTimeout(() => {
    const now = document.activeElement;
    if ((now === document.body || now === null) && lastFocused?.isConnected) lastFocused.focus({ preventScroll: true });
  });
});

/* Animations in sections far off screen are paused: an explainer full of them shouldn't keep the CPU busy. */
const offscreen = new IntersectionObserver(
  (entries) => {
    for (const en of entries) {
      (en.target as HTMLElement).toggleAttribute('data-cx-off', !en.isIntersecting);
      svgClocks(en.target);
    }
  },
  { rootMargin: '300px 0px' },
);

/**
 * SVG animation (`<animate>` and the like) ignores the CSS that pauses animations: its clocks stop in sections far
 * off screen, and everywhere for readers who asked for less motion (at about its first frame). Every `<svg>` has its
 * own clock, nested ones too, so each is paused.
 */
function svgClocks(root: Element): void {
  const less = reducedMotion();
  const svgs = [...(root.localName === 'svg' ? [root] : []), ...root.querySelectorAll('svg')] as SVGSVGElement[];
  for (const svg of svgs) {
    if (less || svg.closest('[data-cx-off]')) svg.pauseAnimations();
    else svg.unpauseAnimations();
  }
}

// ---- input ----

function openRef(ref: HTMLElement): void {
  const id = ref.dataset.explainRef!;
  if (anchors.has(id)) vscode.postMessage({ type: 'openRef', anchorId: id });
}

function aim(link: Element | null): void {
  aimedLink = link;
  aimedKey = link ? linkKey(link) : '';
}

/**
 * The linked element (data-explain-ref or data-explain-code) an event in the content is for, if any. Not when the
 * event is on a form control: a `<label for>` forwards a trusted click to its control, and must never fire a link.
 */
function linkedTarget(target: EventTarget | null): HTMLElement | undefined {
  const t = target as Element | null;
  // Not on form controls, nor on a widget (its placeholder, its bar and buttons), nor in the panel's own boxes.
  if (!t?.closest || t.closest(`${LABELABLE}, explain-widget, [data-cx-box]`)) return undefined;
  return t.closest<HTMLElement>('[data-cx-ref]') ?? undefined;
}

/**
 * Opens what a linked element points at. Only ever called synchronously from the panel's own click and key handlers,
 * for trusted input: the content runs no script and widgets can't reach this, so the reader asked (§8.1).
 * A `data-explain-ref` wins over a `data-explain-code` on the same element.
 */
/** The element a node is, or is in. Content nodes come from the frame's realm, where `instanceof Element` fails. */
function elementOf(n: Node | null): Element | null {
  return !n ? null : n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement;
}

/**
 * A new comment (C, A, or the right-click menu). Text selected in a step starts it, quoted, on that step; else it is
 * on the step `at` is in (where the reader right-clicked), else on the current step.
 */
function composeAt(mode: 'comment' | 'ask', at?: Element | null): void {
  const sel = frame.getSelection();
  const from = sel && !sel.isCollapsed && sel.anchorNode ? elementOf(sel.anchorNode) : null;
  const inStep = from ? steps.find((s) => s.el.contains(from)) : undefined;
  const clicked = at ? steps.find((s) => s.el.contains(at)) : undefined;
  comments?.compose(mode, inStep?.id ?? clicked?.id ?? activeStepId(), inStep ? sel!.toString() : undefined);
}

// ---- the right-click menu: VS Code's own (webview/context in package.json) ----

/** What the reader right-clicked, for the menu command that follows. */
let menuTarget: Element | null = null;

/**
 * The content is a nested frame, where VS Code's webview doesn't see a right-click: hand it on to the panel's own
 * document at the same place, with what was clicked as `data-vscode-context` (the keys the menu's `when` reads).
 */
function onContentMenu(e: MouseEvent): void {
  if (!e.isTrusted) return;
  e.preventDefault();
  const t = elementOf(e.target as Node | null);
  menuTarget = t;
  const step = t ? steps.find((s) => s.el.contains(t)) : undefined;
  const host = frame.el.parentElement!;
  host.dataset.vscodeContext = JSON.stringify({
    webviewSection: 'page',
    preventDefaultContextMenuItems: true,
    sidestorySelection: !(frame.getSelection()?.isCollapsed ?? true),
    sidestoryStep: !!step || !!activeStepId(),
    sidestoryOtherStep: !!step && step.id !== activeStepId(),
    sidestoryLink: !!(t && linkedTarget(t)),
  });
  const r = frame.el.getBoundingClientRect();
  host.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + e.clientX, clientY: r.top + e.clientY }));
}

/** A command from the right-click menu, for what was right-clicked. */
function onMenu(action: 'copy' | 'comment' | 'ask' | 'step' | 'open'): void {
  const t = menuTarget;
  switch (action) {
    case 'copy': {
      const text = frame.getSelection()?.toString() ?? '';
      if (text) vscode.postMessage({ type: 'copyText', text: text.slice(0, 100_000) });
      break;
    }
    case 'comment':
    case 'ask':
      composeAt(action, t);
      break;
    case 'step': {
      const step = t ? steps.find((s) => s.el.contains(t)) : undefined;
      if (step) pick(step.id, 'click');
      break;
    }
    case 'open': {
      const link = t ? linkedTarget(t) : undefined;
      if (link) openLinked(link);
      break;
    }
  }
}

function openLinked(el: HTMLElement): void {
  hoverCard?.hide();
  if (el.hasAttribute('data-explain-ref')) return openRef(el);
  const link = codeLinkOf(el);
  if (link) vscode.postMessage(link.target === undefined ? { type: 'openCode', path: link.path } : { type: 'openCode', path: link.path, target: link.target });
}

/** An element's `data-explain-code`, with the path from the nearest `data-explain-code-file` when it has none. */
function codeLinkOf(el: Element): CodeLink | null {
  const value = el.getAttribute('data-explain-code');
  if (value === null) return null;
  return parseCodeLink(value, el.closest('[data-explain-code-file]')?.getAttribute('data-explain-code-file') ?? undefined);
}

/** The linked elements of a tree, with what they point at: `r:<anchor>` for a ref (which wins), `c:<link>` for code. */
function linkedElements(root: HTMLElement): { el: HTMLElement; key: string }[] {
  return [...root.querySelectorAll<HTMLElement>('[data-cx-ref]')].map((el) => ({ el, key: linkKey(el) })).filter((l) => l.key);
}

function hereKeys(): Set<string> {
  const keys = new Set<string>();
  if (here.ref) keys.add(`r:${here.ref}`);
  if (here.link) keys.add(`c:${here.link}`);
  return keys;
}

/** Rings the elements linked to the code the editor cursor is in (`here`); a class, so the morph keeps it (§8.2). */
function markHere(): void {
  const keys = hereKeys();
  for (const { el, key } of linkEls) {
    const on = keys.has(key);
    if (el.classList.contains('cx-here') !== on) el.classList.toggle('cx-here', on);
  }
}

/** Tells the extension what the page links to, so cursor lighting knows what to look for (§8.2); only on change. */
function sendCodeTargets(): void {
  const valid = (id: string) => ANCHOR_ID_RE.test(id);
  const distinct = (xs: string[]) => [...new Set(xs)].slice(0, MAX_CODE_LINKS);
  const sections = distinct([...content.querySelectorAll('[data-explain-anchor]')].map((el) => el.getAttribute('data-explain-anchor') ?? '').filter(valid));
  const refs = distinct(linkEls.filter((l) => l.key.startsWith('r:')).map((l) => l.key.slice(2)).filter(valid));
  const links = distinct(linkEls.filter((l) => l.key.startsWith('c:')).map((l) => l.key.slice(2)));
  const text = JSON.stringify([sections, refs, links]);
  if (text === sentTargets) return;
  sentTargets = text;
  vscode.postMessage({ type: 'codeTargets', sections, refs, links });
}

/** A problem with the page, for its author: once per sidestory, in Output. */
function warnOnce(message: string): void {
  if (warned.has(message) || warned.size > 50) return;
  warned.add(message);
  vscode.postMessage({ type: 'widgetLog', src: '', level: 'warn', message: `sidestory.html: ${message}` });
}

function onContentClick(e: MouseEvent): void {
  const target = e.target as HTMLElement;
  const reanchor = target.closest<HTMLElement>('.cx-reanchor');
  const fixBox = reanchor?.parentElement;
  const fixFor = ownBox(fixBox) ? fixBox.parentElement?.dataset.explainAnchor : undefined;
  if (reanchor && fixFor) {
    e.preventDefault();
    vscode.postMessage({ type: 'reanchor', anchorId: fixFor });
    return;
  }
  const control = target.closest<HTMLElement>('.cx-peek, .cx-dive');
  const box = control?.closest('.cx-detail');
  const host = ownBox(box) ? box.parentElement : undefined;
  const name = host?.dataset.explainDetail;
  if (control && name) {
    e.preventDefault();
    if (control.classList.contains('cx-dive')) dive(name);
    else {
      if (peeked.has(name)) peeked.delete(name);
      else peeked.add(name);
      decorateDetails(content);
      fitFrame();
    }
    return;
  }
  const linked = linkedTarget(target);
  // A link or summary inside a linked element is what the reader clicked: it acts as itself.
  const inner = target.closest('a[href], area[href], summary');
  if (linked && !(inner && inner !== linked && linked.contains(inner))) {
    const handled = e.defaultPrevented;
    e.preventDefault();
    if (e.isTrusted && !handled) openLinked(linked);
    return;
  }
  const link = target.closest('a, area');
  if (link) {
    // Links never navigate the frame. Web and mail links go to VS Code, which asks before opening them;
    // in-page links scroll the panel.
    e.preventDefault();
    const href = link.getAttribute('href') ?? '';
    if (href.startsWith('#')) {
      let id = href.slice(1);
      try {
        id = decodeURIComponent(id);
      } catch {
        // keep it as written
      }
      const dest = content.querySelector(`[id="${CSS.escape(id)}"]`);
      if (dest) {
        // Set the frame's fragment so CSS :target works (pop-outs, highlighted footnotes); the panel,
        // not the frame, scrolls, just below.
        const section = dest.closest<HTMLElement>('[data-explain-anchor]');
        const from = scroller.scrollTop;
        try {
          // Absolute: a srcdoc frame resolves '#x' against the panel's URL, which would navigate it away.
          frame.location.replace(`about:srcdoc#${encodeURIComponent(id)}`);
        } catch {
          // :target is a nicety
        }
        scroller.scrollTop = from; // the fragment jumps there; scroll smoothly instead
        if (initialized) navHistory.update(hereEntry());
        scrollToTop(topOf(dest));
        if (section) setActive(section.dataset.explainAnchor!, 'click');
        if (initialized) remember('push');
      }
    } else if (href.startsWith(baseUrl)) {
      // Another file in the explainer folder (the sanitizer made it absolute): open it in VS Code.
      try {
        vscode.postMessage({ type: 'openFile', path: decodeURI(href.slice(baseUrl.length).split(/[?#]/)[0]!) });
      } catch {
        // malformed path: ignore the click
      }
    } else if (/^(https?|mailto):/i.test(href)) {
      vscode.postMessage({ type: 'openExternal', url: href });
    }
    return;
  }
  if (target.closest('button, input, select, textarea, summary, label') || (frame.getSelection()?.toString() ?? '') !== '') return;
  const section = target.closest<HTMLElement>('[data-explain-anchor]');
  if (!section || section.dataset.cxState === 'lost') return;
  pick(section.dataset.explainAnchor!, 'click');
}

function onContentKey(e: KeyboardEvent): void {
  // Enter, as for a native link (Space is the reader's scroll key), once per press, on a link the reader focused.
  const linked = linkedTarget(e.target);
  // On a control inside the link (an <a href>, a <summary>), Enter is that control's.
  if (linked && e.key === 'Enter' && e.target === linked) {
    const handled = e.defaultPrevented;
    e.preventDefault();
    if (e.isTrusted && !handled && !e.repeat && linked === aimedLink && linkKey(linked) === aimedKey) openLinked(linked);
    return;
  }
  // The frame can't scroll itself, so Space scrolls the panel, unless it is for a control.
  const onControl = (e.target as HTMLElement).closest?.('summary, button, input, select, textarea, a[href], [tabindex], [contenteditable]');
  if (e.key === ' ' && !onControl && !e.altKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    scroller.scrollBy({ top: (e.shiftKey ? -1 : 1) * scroller.clientHeight * 0.9, behavior: reducedMotion() ? 'auto' : 'smooth' });
    return;
  }
  onKey(e);
}

stepsEl.addEventListener('keydown', (e) => {
  if (e.altKey || e.ctrlKey || e.metaKey) return; // Alt+Left is Back
  const buttons = [...stepsEl.querySelectorAll<HTMLButtonElement>('.cx-step')];
  const i = buttons.indexOf(e.target as HTMLButtonElement);
  if (i < 0) return;
  const to = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: buttons.length - 1 }[e.key];
  if (to === undefined) return;
  e.preventDefault();
  e.stopPropagation();
  const b = buttons[Math.min(Math.max(to, 0), buttons.length - 1)]!;
  for (const x of buttons) x.tabIndex = x === b ? 0 : -1;
  b.focus();
});

stepsEl.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('.cx-step');
  if (b) jumpTo(b.dataset.anchor!, 'step');
});

selectEl.addEventListener('change', () => jumpTo(selectEl.value, 'step'));

for (const b of app.querySelectorAll<HTMLButtonElement>('.cx-nav')) b.addEventListener('click', () => step(Number(b.dataset.delta) as 1 | -1));

pillShow.addEventListener('click', () => {
  const id = pillEl.dataset.anchor;
  const detail = pillEl.dataset.dive;
  hidePill();
  if (detail) return dive(detail);
  if (id) jumpTo(id, 'click'); // the reader took the cursor's step: the extension moves the editor's step too
});
$('.cx-pill-close').addEventListener('click', hidePill);
backEl.addEventListener('click', () => goTo(trail.length - 2));
for (const b of [histBack, histForward]) {
  b.addEventListener('click', () => {
    if (b.getAttribute('aria-disabled') !== 'true') goHistory(b === histBack ? -1 : 1);
  });
}
$('.cx-preview-keep').addEventListener('click', () => {
  // The button goes away with the bar: keep keyboard focus somewhere sensible instead of dropping it on the body.
  const hadFocus = app.contains(document.activeElement);
  previewEl.hidden = true;
  vscode.postMessage({ type: 'keepOpen' });
  if (hadFocus) {
    titleEl.tabIndex = -1;
    titleEl.focus({ preventScroll: true });
  }
});
bannerOpen.addEventListener('click', () => vscode.postMessage({ type: 'openFile', path: 'manifest.json' }));

document.addEventListener('keydown', onKey);
for (const ev of ['mousedown', 'mouseup']) document.addEventListener(ev, onMouseNav as EventListener);

function onKey(e: KeyboardEvent): void {
  const t = e.target as HTMLElement | undefined;
  // Keys belong to controls that take typing; a switch or radio button doesn't, so J/K still step.
  const typing = typingIn(t);
  const nav = typing ? 0 : historyKey(e);
  if (nav) {
    e.preventDefault();
    goHistory(nav);
    return;
  }
  if (e.altKey || e.ctrlKey || e.metaKey || typing) {
    if (e.key === 'Escape') hidePill();
    return;
  }
  // Escape hides the hover card, then closes the comment composer, then the Comments pane, then dismisses the pill;
  // with nothing to dismiss, it goes back up the trail.
  if (e.key === 'Escape') {
    const selection = frame.getSelection();
    if (hoverCard?.hide()) return;
    if (comments?.escape()) return;
    if (!pillEl.hidden) hidePill();
    else if (selection && !selection.isCollapsed) selection.removeAllRanges();
    else if (trail.length > 1) goTo(trail.length - 2);
    return;
  }
  if (e.key === 'j') step(1);
  else if (e.key === 'k') step(-1);
  // Comments (docs/COMMENTS-PLAN.md §11.3).
  else if ((e.key.toLowerCase() === 'c' || e.key.toLowerCase() === 'a') && e.isTrusted) {
    composeAt(e.key.toLowerCase() === 'c' ? 'comment' : 'ask');
  }
  else if (e.key.toLowerCase() === 't' && e.isTrusted) comments?.toggle();
  else if ((e.key === 'n' || e.key === 'N') && e.isTrusted) comments?.next(e.shiftKey ? -1 : 1);
  else return;
  if (/^[cantN]$/i.test(e.key)) e.preventDefault();
}

// ---- keeping the reader's place ----

interface Position {
  anchor: string;
  offset: number;
}

function readingPosition(): Position | undefined {
  const s = sectionAtReadingLine();
  if (!s) return undefined;
  return { anchor: s.id, offset: topOf(s.el) - scroller.getBoundingClientRect().top };
}

function restorePosition(p: Position): void {
  const el = sectionEl(p.anchor);
  if (!el) return;
  const now = topOf(el) - scroller.getBoundingClientRect().top;
  if (Math.abs(now - p.offset) > 1) {
    scroller.scrollTop += now - p.offset;
  }
}

function restoreScroll(): void {
  if (state.scroll) restorePosition(state.scroll);
  else if (active) scrollToSection(active);
  else scroller.scrollTop = 0; // a newly entered explainer starts at the top
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function saveState(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(savePlace, 200);
}

/** Records the reader's place in the explainer shown, now (before switching away from it). */
function savePlace(): void {
  clearTimeout(saveTimer);
  if (!initialized) return; // nothing rendered yet: keep what was saved
  const place: Place = { active, scroll: readingPosition() };
  const places = { ...state.places };
  delete places[state.dir]; // re-inserted last: the most recent is kept longest
  places[state.dir] = place;
  const keys = Object.keys(places);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_PLACES))) delete places[k];
  navHistory.update(hereEntry());
  state = { ...state, ...place, places, history: navHistory.toJSON() };
  vscode.setState(state);
  renderHistory();
}

const pendingAnnouncements: string[] = [];
function announce(text: string): void {
  // Collect messages from one update into one announcement; clear first so a repeat is announced again.
  if (pendingAnnouncements.push(text) > 1) return;
  liveEl.textContent = '';
  requestAnimationFrame(() => {
    liveEl.textContent = pendingAnnouncements.splice(0).join('. ');
  });
}

vscode.setState(state);
vscode.postMessage({ type: 'ready' });

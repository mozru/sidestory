// The explainer page. It renders author HTML in a sandboxed iframe, keeps the reader's place through
// every update (DOM morphing, never a reload), and syncs the active section with the editor.
import { Idiomorph } from 'idiomorph';
import type { AnchorView, FromWebview, ToWebview } from '../shared/protocol.ts';
import contentCssText from './content.css';
import { Assets } from './assets.ts';
import { sanitize } from './sanitize.ts';

interface VsCodeApi {
  postMessage(m: FromWebview): void;
  getState(): SavedState | undefined;
  setState(s: SavedState): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

interface SavedState {
  dir: string;
  active?: string;
  /** The section at the reading line and how far from the top of the viewport it was. */
  scroll?: { anchor: string; offset: number };
}

interface Step {
  id: string;
  el: HTMLElement;
  label: string;
}

type Source = 'scroll' | 'click' | 'step';

const READING_LINE = 0.3; // fraction of the viewport height
const USER_LEAD_MS = 1500; // after the reader scrolls, the editor doesn't move the page for this long
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
const baseUrl = new URL(app.dataset.base!).href;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const pendingAssets = new Map<number, (b: Blob | null) => void>();
let assetId = 0;
const assets = new Assets(baseUrl, (path) => {
  const id = ++assetId;
  vscode.postMessage({ type: 'requestAsset', id, path });
  return new Promise<Blob | null>((resolve) => {
    pendingAssets.set(id, resolve);
    // Don't hold a render forever if the reply never comes (e.g. the panel was hidden meanwhile).
    setTimeout(() => {
      if (pendingAssets.delete(id)) resolve(null);
    }, 5_000);
  });
});

let state: SavedState = vscode.getState() ?? { dir: app.dataset.dir! };
let anchors = new Map<string, AnchorView>();
let steps: Step[] = [];
let active: string | undefined = state.active;
let lastUserScroll = 0;
let programmaticUntil = 0;
let focusTimer: ReturnType<typeof setTimeout> | undefined;
let pillTimer: ReturnType<typeof setTimeout> | undefined;
let initialized = false;
/** Set by `init`; applied by whichever render completes first after it. */
let pendingInit: { active?: string } | undefined;

// ---- skeleton ----

app.innerHTML = `
<header class="cx-header">
  <div class="cx-titlerow">
    <h1 class="cx-title"></h1>
    <span class="cx-status"><span class="codicon" aria-hidden="true"></span><span class="cx-status-text"></span></span>
  </div>
  <nav class="cx-steps" aria-label="Steps"></nav>
  <div class="cx-steps-compact">
    <label class="cx-sr" for="cx-step-select">Step</label>
    <select id="cx-step-select" class="cx-step-select"></select>
    <div class="cx-progress" aria-hidden="true"></div>
  </div>
</header>
<div class="cx-banner" role="alert" hidden><span class="codicon codicon-warning" aria-hidden="true"></span><span class="cx-banner-text"></span></div>
<main class="cx-scroll" tabindex="0" aria-label="Explainer"><div class="cx-frame"></div></main>
<div class="cx-pill" hidden>
  <button class="cx-pill-show" type="button"></button>
  <button class="cx-pill-close" type="button" aria-label="Dismiss"><span class="codicon codicon-close" aria-hidden="true"></span></button>
</div>
<footer class="cx-footer">
  <button class="cx-nav" type="button" data-delta="-1" aria-label="Previous step"><span class="codicon codicon-chevron-left" aria-hidden="true"></span></button>
  <button class="cx-nav" type="button" data-delta="1" aria-label="Next step"><span class="codicon codicon-chevron-right" aria-hidden="true"></span></button>
  <span class="cx-position"></span>
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
}

let frame!: Frame;
let content!: HTMLElement;
let lastRender: { title: string; html: string } | undefined;

async function buildFrame(): Promise<void> {
  const el = document.createElement('iframe');
  el.className = 'cx-content-frame';
  el.title = 'Explainer content';
  el.setAttribute('sandbox', 'allow-same-origin');
  el.srcdoc = '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body></body></html>';
  $('.cx-frame').replaceChildren(el);
  await new Promise<void>((resolve) => el.addEventListener('load', () => resolve(), { once: true }));
  const d = el.contentDocument!;
  frame = {
    el,
    root: d.documentElement,
    body: d.body,
    createElement: Document.prototype.createElement.bind(d) as Document['createElement'],
    importNode: Document.prototype.importNode.bind(d) as Document['importNode'],
    getSelection: () => el.contentWindow?.getSelection() ?? null,
  };
  const style = frame.createElement('style');
  style.textContent = contentCssText;
  d.head.append(style);
  content = frame.createElement('div');
  content.className = 'cx-content';
  frame.body.append(content);
  bindFrameEvents(d);
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
  frame.root.style.setProperty('--cx-tail', `${Math.round(scroller.clientHeight * 0.4)}px`);
  frame.root.style.setProperty('--cx-gutter', getComputedStyle($('.cx-header')).getPropertyValue('--cx-gutter') || '20px');
}

// The frame is as tall as its content, so the panel's scroller does the scrolling. Measured from the
// content (not the document, which never reports less than the frame's current height), synchronously
// after every render, and again when images or fonts load.
function fitFrame(): void {
  if (!frame) return;
  const h = `${Math.ceil(content.getBoundingClientRect().bottom)}px`;
  if (frame.el.style.height !== h) frame.el.style.height = h;
}

await buildFrame();
new MutationObserver(syncTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
new MutationObserver(syncTheme).observe(document.body, { attributes: true, attributeFilter: ['class'] });
new ResizeObserver(syncTheme).observe(scroller);

const sectionEl = (id: string) => content.querySelector<HTMLElement>(`[data-explain-anchor="${CSS.escape(id)}"]`);
/** An element's top, in the panel's coordinates. */
const topOf = (el: Element) => el.getBoundingClientRect().top + frame.el.getBoundingClientRect().top;

// ---- messages ----

window.addEventListener('message', (e: MessageEvent<ToWebview>) => {
  const m = e.data;
  switch (m.type) {
    case 'init':
      anchors = new Map(m.anchors.map((a) => [a.id, a]));
      pendingInit = { active: m.active };
      void render(m.title, m.html, false);
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
    case 'syncTo':
      followEditor(m.anchorId);
      break;
    case 'navigate':
      step(m.delta);
      break;
    case 'asset': {
      const resolve = pendingAssets.get(m.id);
      pendingAssets.delete(m.id);
      resolve?.(m.data && m.mime ? new Blob([Uint8Array.from(atob(m.data), (c) => c.charCodeAt(0))], { type: m.mime }) : null);
      break;
    }
    case 'error':
      bannerEl.hidden = m.message === null;
      bannerText.textContent = m.message ?? '';
      break;
  }
});

// ---- rendering ----

let renderSeq = 0;

/** Renders explainer HTML into the frame. Resolves false if a newer render overtook this one. */
async function render(title: string, html: string, isUpdate: boolean): Promise<boolean> {
  const seq = ++renderSeq;
  lastRender = { title, html };
  const parsed = sanitize(html, baseUrl, frame.importNode);
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
  for (const el of next.querySelectorAll<HTMLElement>('[data-explain-anchor]')) if (el.dataset.explainAnchor === active) el.classList.add('cx-active');

  const before = isUpdate ? snapshot() : new Map<string, string>();
  const keep = isUpdate ? readingPosition() : undefined;
  Idiomorph.morph(content, next, { morphStyle: 'innerHTML', ignoreActiveValue: true, restoreFocus: true });
  fitFrame();
  if (keep) restorePosition(keep);
  if (isUpdate) markUpdated(before);
  decorate();
  if (pendingInit) {
    const init = pendingInit;
    pendingInit = undefined;
    active = init.active ?? active;
    restoreScroll();
    // Nothing chosen yet: the section at the reading line is the current one (the editor isn't told).
    if (!active) active = sectionAtReadingLine()?.id;
    markActive();
    initialized = true;
  }
  return true;
}

/** The HTML of each section, to tell which ones an update changed. */
function snapshot(): Map<string, string> {
  return new Map([...content.querySelectorAll<HTMLElement>('[data-explain-anchor]')].map((el) => [el.dataset.explainAnchor!, cleanHtml(el)]));
}

/** A section's HTML without the attributes this script adds. */
function cleanHtml(el: HTMLElement): string {
  const c = el.cloneNode(true) as HTMLElement;
  for (const x of [c, ...c.querySelectorAll<HTMLElement>('*')]) {
    x.classList.remove('cx-active', 'cx-updated');
    if (x.classList.length === 0) x.removeAttribute('class');
    for (const a of ['data-cx-state', 'data-cx-label']) x.removeAttribute(a);
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
  }
  // Inline references behave like links for the keyboard and screen readers.
  for (const ref of root.querySelectorAll<HTMLElement>('[data-explain-ref]')) {
    ref.dataset.cxRef = '1';
    if (!ref.hasAttribute('tabindex')) ref.tabIndex = 0;
    if (!ref.hasAttribute('role') && !(ref.localName === 'a' && ref.hasAttribute('href'))) ref.setAttribute('role', 'link');
  }
}

/** Applies anchor states, accents and the active section, then rebuilds the navigator. */
function decorate(): void {
  decorateTree(content);
  const all = [...content.querySelectorAll<HTMLElement>('[data-explain-anchor]')];
  steps = all
    .filter((el) => !el.parentElement?.closest('[data-explain-anchor]'))
    .map((el) => ({ id: el.dataset.explainAnchor!, el, label: stepLabel(el, el.dataset.explainAnchor!) }));
  if (active && !steps.some((s) => s.id === active) && !anchors.has(active)) active = undefined;
  renderNavigator();
  renderStatus();
  markActive();
}

function stepLabel(el: HTMLElement, id: string): string {
  return el.dataset.explainTitle ?? el.querySelector('h1, h2, h3, h4')?.textContent?.trim() ?? id;
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
      b.innerHTML = '<span class="cx-sr cx-step-prefix"></span><span class="cx-step-num" aria-hidden="true"></span><span class="cx-step-label"></span><span class="cx-sr cx-step-state"></span>';
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
}

function setText(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

function renderStatus(): void {
  const counts = { stale: 0, lost: 0 };
  for (const a of anchors.values()) if (a.state === 'stale' || a.state === 'lost') counts[a.state]++;
  const parts = [counts.stale && `${counts.stale} out of date`, counts.lost && `${counts.lost} not found`].filter(Boolean) as string[];
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
  const index = steps.findIndex((s) => s.id === activeStepId());
  for (const el of content.querySelectorAll<HTMLElement>('.cx-active')) el.classList.remove('cx-active');
  if (active) sectionEl(active)?.classList.add('cx-active');
  [...stepsEl.children].forEach((b, i) => {
    if (i === index) b.setAttribute('aria-current', 'step');
    else b.removeAttribute('aria-current');
    b.classList.toggle('cx-done', index >= 0 && i < index);
  });
  [...progressEl.children].forEach((p, i) => p.classList.toggle('cx-on', index >= 0 && i <= index));
  if (index >= 0) selectEl.value = steps[index]!.id;
  positionEl.textContent = steps.length ? `Step ${index >= 0 ? index + 1 : '–'} of ${steps.length}` : 'No linked sections';
  for (const b of app.querySelectorAll<HTMLButtonElement>('.cx-nav')) {
    b.disabled = steps.length === 0 || (b.dataset.delta === '-1' ? index <= 0 : index === steps.length - 1);
  }
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
  markActive();
  saveState();
  if (!id || !notify) return;
  clearTimeout(focusTimer);
  const send = () => vscode.postMessage({ type: 'focusAnchor', anchorId: id, source: notify });
  if (notify === 'scroll') focusTimer = setTimeout(send, 120);
  else send();
}

function scrollToSection(id: string): void {
  const el = sectionEl(id);
  if (!el) return;
  programmaticUntil = Date.now() + 1000;
  scrollToTop(topOf(el));
}

/** Scrolls the panel so that a point (in panel coordinates) sits just below the top. */
function scrollToTop(top: number): void {
  scroller.scrollTo({ top: scroller.scrollTop + top - scroller.getBoundingClientRect().top - 12, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
}

function step(delta: 1 | -1): void {
  if (steps.length === 0) return;
  const i = steps.findIndex((s) => s.id === activeStepId());
  const target = steps[Math.min(steps.length - 1, Math.max(0, i < 0 ? 0 : i + delta))]!;
  if (target.id === activeStepId()) return; // already at the first or last step
  hidePill();
  setActive(target.id, 'step');
  scrollToSection(target.id);
}

const readerLeads = () => Date.now() - lastUserScroll < USER_LEAD_MS;

/**
 * The editor cursor moved into a section. Follow it, unless the reader is scrolling the page:
 * then leave everything where it is and offer a pill instead.
 */
function followEditor(id: string): void {
  if (!anchors.has(id)) return;
  const el = sectionEl(id);
  if (!el) return;
  const view = scroller.getBoundingClientRect();
  const top = topOf(el);
  if (readerLeads()) {
    // Already on screen: nothing to offer.
    if (!(top >= view.top && top <= view.bottom - 40)) showPill(id, el);
    return;
  }
  hidePill();
  setActive(id);
  const visible = top >= view.top && top <= view.top + view.height * 0.6;
  if (!visible) scrollToSection(id);
}

function showPill(id: string, el: HTMLElement): void {
  pillShow.textContent = `Cursor is in “${stepLabel(el, id)}” · Show`;
  pillEl.dataset.anchor = id;
  if (pillEl.hidden) announce(`Editor cursor is in ${stepLabel(el, id)}`);
  pillEl.hidden = false;
  clearTimeout(pillTimer);
  pillTimer = setTimeout(hidePill, PILL_MS);
}

function hidePill(): void {
  clearTimeout(pillTimer);
  pillEl.hidden = true;
  delete pillEl.dataset.anchor;
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
    saveState();
    if (Date.now() < programmaticUntil) return;
    const s = sectionAtReadingLine();
    if (s && pillEl.dataset.anchor === s.id) hidePill(); // the reader got there on their own
    if (s && s.id !== activeStepId()) setActive(s.id, 'scroll');
  });
});
scroller.addEventListener('scrollend', () => {
  programmaticUntil = 0;
});
// A hoisted function, not a const: the frame's listeners are attached (in buildFrame) before this line runs.
function readerInput(): void {
  lastUserScroll = Date.now();
}
// The scrollbar belongs to the panel; events over the content happen in the frame (bindFrameEvents).
for (const ev of ['wheel', 'touchmove', 'pointerdown']) scroller.addEventListener(ev, readerInput, { passive: true });

function bindFrameEvents(d: Document): void {
  for (const ev of ['wheel', 'touchmove', 'pointerdown']) d.addEventListener(ev, readerInput, { passive: true });
  d.addEventListener('click', onContentClick);
  d.addEventListener('keydown', onContentKey);
}

// ---- input ----

function openRef(ref: HTMLElement): void {
  const id = ref.dataset.explainRef!;
  if (anchors.has(id)) vscode.postMessage({ type: 'openRef', anchorId: id });
}

function onContentClick(e: MouseEvent): void {
  const target = e.target as HTMLElement;
  const ref = target.closest<HTMLElement>('[data-explain-ref]');
  if (ref) {
    e.preventDefault();
    openRef(ref);
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
        const section = dest.closest<HTMLElement>('[data-explain-anchor]');
        programmaticUntil = Date.now() + 1000;
        scrollToTop(topOf(dest));
        if (section) setActive(section.dataset.explainAnchor!, 'click');
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
  const id = section.dataset.explainAnchor!;
  setActive(id, 'click');
}

function onContentKey(e: KeyboardEvent): void {
  const ref = (e.target as HTMLElement).closest?.<HTMLElement>('[data-explain-ref]');
  if (ref && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    openRef(ref);
    return;
  }
  // The frame can't scroll itself, so Space scrolls the panel, unless it is for a control.
  const onControl = (e.target as HTMLElement).closest?.('summary, button, input, select, textarea, a[href], [tabindex], [contenteditable]');
  if (e.key === ' ' && !onControl && !e.altKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    readerInput();
    scroller.scrollBy({ top: (e.shiftKey ? -1 : 1) * scroller.clientHeight * 0.9, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
    return;
  }
  onKey(e);
}

stepsEl.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('.cx-step');
  if (!b) return;
  const id = b.dataset.anchor!;
  hidePill();
  setActive(id, 'step');
  scrollToSection(id);
});

selectEl.addEventListener('change', () => {
  hidePill();
  setActive(selectEl.value, 'step');
  scrollToSection(selectEl.value);
});

for (const b of app.querySelectorAll<HTMLButtonElement>('.cx-nav')) b.addEventListener('click', () => step(Number(b.dataset.delta) as 1 | -1));

pillShow.addEventListener('click', () => {
  const id = pillEl.dataset.anchor;
  hidePill();
  if (!id) return;
  setActive(id);
  scrollToSection(id);
});
$('.cx-pill-close').addEventListener('click', hidePill);

document.addEventListener('keydown', onKey);

function onKey(e: KeyboardEvent): void {
  const t = e.target as HTMLElement | undefined;
  if (e.key === 'Escape') hidePill();
  if (e.altKey || e.ctrlKey || e.metaKey || (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))) return;
  if (['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' '].includes(e.key)) readerInput();
  if (e.key === 'j') step(1);
  else if (e.key === 'k') step(-1);
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
    programmaticUntil = Date.now() + 200;
    scroller.scrollTop += now - p.offset;
  }
}

function restoreScroll(): void {
  if (state.scroll) restorePosition(state.scroll);
  else if (active) scrollToSection(active);
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function saveState(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    state = { dir: state.dir, active, scroll: readingPosition() };
    vscode.setState(state);
  }, 200);
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

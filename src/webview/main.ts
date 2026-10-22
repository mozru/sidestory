// The explainer page. It renders author HTML in a shadow root, keeps the reader's place through
// every update (DOM morphing, never a reload), and syncs the active section with the editor.
import { Idiomorph } from 'idiomorph';
import type { AnchorView, FromWebview, ToWebview } from '../shared/protocol.ts';
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
  /** The section at the top of the viewport and how far into it the reader was. */
  scroll?: { anchor: string; offset: number };
}

interface Step {
  id: string;
  el: HTMLElement;
  label: string;
}

const READING_LINE = 0.3; // fraction of the viewport height
const USER_LEAD_MS = 1500; // after the reader scrolls, the editor doesn't move the page for this long
const UPDATED_MS = 1800;
const LABELS: Record<string, string> = { changed: 'Code changed', stale: 'Out of date', lost: 'Code not found', unknown: 'Not linked' };

const vscode = acquireVsCodeApi();
const app = document.getElementById('app')!;
const baseUrl = app.dataset.base!;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

let state: SavedState = vscode.getState() ?? { dir: app.dataset.dir! };
let anchors = new Map<string, AnchorView>();
let steps: Step[] = [];
let active: string | undefined = state.active;
let lastUserScroll = 0;
let programmaticUntil = 0;
let focusTimer: ReturnType<typeof setTimeout> | undefined;
let initialized = false;

// ---- skeleton ----

app.innerHTML = `
<header class="cx-header">
  <div class="cx-titlerow">
    <h1 class="cx-title"></h1>
    <span class="cx-status" role="status"></span>
  </div>
  <nav class="cx-steps" aria-label="Steps"></nav>
  <div class="cx-steps-compact">
    <label class="cx-sr" for="cx-step-select">Step</label>
    <select id="cx-step-select" class="cx-step-select"></select>
    <div class="cx-progress" aria-hidden="true"></div>
  </div>
</header>
<div class="cx-banner" role="alert" hidden></div>
<main class="cx-scroll" tabindex="0" aria-label="Explainer"><div class="cx-host"></div></main>
<button class="cx-pill" type="button" hidden></button>
<footer class="cx-footer">
  <button class="cx-nav" type="button" data-delta="-1" aria-label="Previous step"><span class="codicon codicon-chevron-left"></span></button>
  <button class="cx-nav" type="button" data-delta="1" aria-label="Next step"><span class="codicon codicon-chevron-right"></span></button>
  <span class="cx-position"></span>
  <span class="cx-hint">J / K</span>
</footer>
<div class="cx-sr" aria-live="polite"></div>`;

const $ = <T extends HTMLElement>(sel: string) => app.querySelector<T>(sel)!;
const titleEl = $('.cx-title');
const statusEl = $('.cx-status');
const stepsEl = $('.cx-steps');
const selectEl = $<HTMLSelectElement>('.cx-step-select');
const progressEl = $('.cx-progress');
const bannerEl = $('.cx-banner');
const scroller = $('.cx-scroll');
const pillEl = $<HTMLButtonElement>('.cx-pill');
const positionEl = $('.cx-position');
const liveEl = $('[aria-live]');

const shadow = $('.cx-host').attachShadow({ mode: 'open' });
const contentCss = document.createElement('link');
contentCss.rel = 'stylesheet';
contentCss.href = app.dataset.contentCss!;
const content = document.createElement('div');
content.className = 'cx-content';
shadow.append(contentCss, content);

// ---- messages ----

window.addEventListener('message', (e: MessageEvent<ToWebview>) => {
  const m = e.data;
  switch (m.type) {
    case 'init':
      anchors = new Map(m.anchors.map((a) => [a.id, a]));
      render(m.title, m.html, false);
      active = m.active ?? active;
      decorate();
      restoreScroll();
      initialized = true;
      break;
    case 'content':
      if (initialized) render(m.title, m.html, true);
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
    case 'error':
      bannerEl.hidden = m.message === null;
      bannerEl.textContent = m.message ?? '';
      break;
  }
});

// ---- rendering ----

function render(title: string, html: string, isUpdate: boolean): void {
  titleEl.textContent = title;
  const parsed = sanitize(html, baseUrl);
  const next = document.createElement('div');
  next.append(...parsed.styles, ...parsed.body);
  // Stable ids let the morph match sections across edits.
  for (const el of next.querySelectorAll<HTMLElement>('[data-explain-anchor]')) if (!el.id) el.id = `cx-a-${el.dataset.explainAnchor}`;

  const before = isUpdate ? snapshot() : new Map<string, string>();
  const keep = isUpdate ? readingPosition() : undefined;
  Idiomorph.morph(content, next, { morphStyle: 'innerHTML', ignoreActiveValue: true, restoreFocus: true });
  if (keep) restorePosition(keep);
  if (isUpdate) markUpdated(before);
  decorate();
}

/** The HTML of each section, to tell which ones an update changed. */
function snapshot(): Map<string, string> {
  return new Map([...content.querySelectorAll<HTMLElement>('[data-explain-anchor]')].map((el) => [el.dataset.explainAnchor!, cleanHtml(el)]));
}

function cleanHtml(el: HTMLElement): string {
  const c = el.cloneNode(true) as HTMLElement;
  for (const x of [c, ...c.querySelectorAll<HTMLElement>('*')]) {
    x.classList.remove('cx-active', 'cx-updated');
    if (x.classList.length === 0) x.removeAttribute('class');
    x.removeAttribute('data-cx-state');
    x.removeAttribute('data-cx-label');
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
  if (changed.length) announce(`Updated: ${changed.join(', ')}`);
}

/** Applies anchor states, accents and the active section, then rebuilds the navigator. */
function decorate(): void {
  const all = [...content.querySelectorAll<HTMLElement>('[data-explain-anchor]')];
  for (const el of all) {
    const a = anchors.get(el.dataset.explainAnchor!);
    el.dataset.cxState = a?.state ?? 'unknown';
    el.setAttribute('data-cx-label', LABELS[el.dataset.cxState] ?? '');
    if (a?.colorVar) el.style.setProperty('--cx-accent', `var(${a.colorVar})`);
    else el.style.removeProperty('--cx-accent');
  }
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

function renderNavigator(): void {
  const signature = steps.map((s) => `${s.id}:${s.label}`).join('|');
  if (stepsEl.dataset.signature !== signature) {
    stepsEl.dataset.signature = signature;
    stepsEl.replaceChildren(
      ...steps.map((s, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'cx-step';
        b.dataset.anchor = s.id;
        b.innerHTML = `<span class="cx-step-num">${i + 1}</span><span class="cx-step-label"></span>`;
        b.querySelector('.cx-step-label')!.textContent = s.label;
        b.title = s.label;
        return b;
      }),
    );
    selectEl.replaceChildren(
      ...steps.map((s, i) => {
        const o = document.createElement('option');
        o.value = s.id;
        o.textContent = `${i + 1}. ${s.label}`;
        return o;
      }),
    );
    progressEl.replaceChildren(...steps.map(() => document.createElement('span')));
  }
  steps.forEach((s, i) => {
    const accent = anchors.get(s.id)?.colorVar;
    for (const el of [stepsEl.children[i], progressEl.children[i]] as HTMLElement[]) {
      if (accent) el.style.setProperty('--cx-accent', `var(${accent})`);
      else el.style.removeProperty('--cx-accent');
      el.dataset.cxState = anchors.get(s.id)?.state ?? 'unknown';
    }
  });
}

function renderStatus(): void {
  const counts = { stale: 0, lost: 0 };
  for (const a of anchors.values()) if (a.state === 'stale' || a.state === 'lost') counts[a.state]++;
  const parts = [counts.stale && `${counts.stale} out of date`, counts.lost && `${counts.lost} not found`].filter(Boolean);
  statusEl.dataset.ok = String(parts.length === 0);
  statusEl.innerHTML = parts.length
    ? `<span class="codicon codicon-warning" aria-hidden="true"></span><span></span>`
    : `<span class="codicon codicon-link" aria-hidden="true"></span><span>Linked</span>`;
  if (parts.length) statusEl.lastElementChild!.textContent = parts.join(' · ');
}

function markActive(): void {
  const index = steps.findIndex((s) => s.id === activeStepId());
  for (const el of content.querySelectorAll<HTMLElement>('.cx-active')) el.classList.remove('cx-active');
  if (active) content.querySelector<HTMLElement>(`[data-explain-anchor="${CSS.escape(active)}"]`)?.classList.add('cx-active');
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
  const el = content.querySelector<HTMLElement>(`[data-explain-anchor="${CSS.escape(active)}"]`);
  return steps.find((s) => el && s.el.contains(el))?.id;
}

// ---- moving between sections ----

function setActive(id: string | undefined, notify?: 'scroll' | 'click' | 'step'): void {
  if (id === active) return;
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
  const el = content.querySelector<HTMLElement>(`[data-explain-anchor="${CSS.escape(id)}"]`);
  if (!el) return;
  programmaticUntil = Date.now() + 1000;
  el.scrollIntoView({ block: 'start', behavior: reducedMotion.matches ? 'auto' : 'smooth' });
}

function step(delta: 1 | -1): void {
  if (steps.length === 0) return;
  const i = steps.findIndex((s) => s.id === activeStepId());
  const target = steps[Math.min(steps.length - 1, Math.max(0, i < 0 ? 0 : i + delta))]!;
  pillEl.hidden = true;
  setActive(target.id, 'step');
  scrollToSection(target.id);
}

/** The editor cursor moved into a section: follow it unless the reader is scrolling. */
function followEditor(id: string): void {
  if (!anchors.has(id)) return;
  const el = content.querySelector<HTMLElement>(`[data-explain-anchor="${CSS.escape(id)}"]`);
  setActive(id);
  if (!el) return;
  if (Date.now() - lastUserScroll < USER_LEAD_MS) {
    pillEl.textContent = `Cursor is in “${stepLabel(el, id)}” · Show`;
    pillEl.dataset.anchor = id;
    pillEl.hidden = false;
    return;
  }
  const r = el.getBoundingClientRect();
  const view = scroller.getBoundingClientRect();
  const visible = r.top >= view.top && r.top <= view.top + view.height * 0.6;
  if (!visible) scrollToSection(id);
}

function sectionAtReadingLine(): Step | undefined {
  const view = scroller.getBoundingClientRect();
  if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) return steps[steps.length - 1];
  const y = view.top + view.height * READING_LINE;
  let found: Step | undefined;
  for (const s of steps) if (s.el.getBoundingClientRect().top <= y) found = s;
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
    if (s && s.id !== activeStepId()) setActive(s.id, 'scroll');
  });
});
scroller.addEventListener('scrollend', () => {
  programmaticUntil = 0;
});
for (const ev of ['wheel', 'touchmove'] as const) scroller.addEventListener(ev, () => (lastUserScroll = Date.now()), { passive: true });

// ---- input ----

shadow.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const ref = target.closest<HTMLElement>('[data-explain-ref]');
  if (ref) {
    e.preventDefault();
    const id = ref.dataset.explainRef!;
    if (anchors.has(id)) vscode.postMessage({ type: 'openRef', anchorId: id });
    return;
  }
  const link = target.closest('a');
  if (link) {
    // External links open in the browser (VS Code handles http/https); anything else stays put.
    if (!/^https?:|^mailto:/i.test(link.getAttribute('href') ?? '')) e.preventDefault();
    return;
  }
  if (target.closest('button, input, select, textarea, summary, label') || (getSelection()?.toString() ?? '') !== '') return;
  const section = target.closest<HTMLElement>('[data-explain-anchor]');
  if (section) setActive(section.dataset.explainAnchor!, 'click');
  else return;
  // Clicking the active section again still reveals its code.
  vscode.postMessage({ type: 'focusAnchor', anchorId: section.dataset.explainAnchor!, source: 'click' });
});

stepsEl.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('.cx-step');
  if (!b) return;
  const id = b.dataset.anchor!;
  setActive(id, 'step');
  scrollToSection(id);
});

selectEl.addEventListener('change', () => {
  setActive(selectEl.value, 'step');
  scrollToSection(selectEl.value);
});

for (const b of app.querySelectorAll<HTMLButtonElement>('.cx-nav')) b.addEventListener('click', () => step(Number(b.dataset.delta) as 1 | -1));

pillEl.addEventListener('click', () => {
  pillEl.hidden = true;
  if (pillEl.dataset.anchor) scrollToSection(pillEl.dataset.anchor);
});

document.addEventListener('keydown', (e) => {
  const t = e.composedPath()[0] as HTMLElement | undefined;
  if (e.altKey || e.ctrlKey || e.metaKey || (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))) return;
  if (['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' '].includes(e.key)) lastUserScroll = Date.now();
  if (e.key === 'j') step(1);
  else if (e.key === 'k') step(-1);
});

// ---- keeping the reader's place ----

interface Position {
  anchor: string;
  offset: number;
}

function readingPosition(): Position | undefined {
  const s = sectionAtReadingLine();
  if (!s) return undefined;
  return { anchor: s.id, offset: s.el.getBoundingClientRect().top - scroller.getBoundingClientRect().top };
}

function restorePosition(p: Position): void {
  const el = content.querySelector<HTMLElement>(`[data-explain-anchor="${CSS.escape(p.anchor)}"]`);
  if (!el) return;
  const now = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
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

function announce(text: string): void {
  liveEl.textContent = text;
}

vscode.setState(state);
vscode.postMessage({ type: 'ready' });

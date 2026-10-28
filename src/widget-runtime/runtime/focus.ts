// Focus and keyboard inside a widget frame (docs/WIDGETS-PLAN.md §5.3, §8). Best effort: the panel's checks
// are the real control. Programmatic focus() is a no-op unless the reader is interacting with this frame,
// and the runtime hands focus back to the panel (`focusExit`) where a reader would expect to leave.
import type { FromWidget } from '../../shared/widget-protocol.ts';

type Dir = Extract<FromWidget, { type: 'focusExit' }>['dir'];

/** How long after a pointerdown/keydown in this frame programmatic focus() is still honored. */
export const INTERACTION_MS = 1500;
const ACTIVITY_MS = 250;

const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'datetime-local', 'month', 'time', 'week', 'range', 'color']);

/** Elements where a click is expected to leave focus (typing, picking, dragging a range). */
export function keepsFocus(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(el.type);
  return el instanceof HTMLElement && el.isContentEditable;
}

const TABBABLE = 'a[href], area[href], button, input, select, textarea, iframe, summary, [tabindex], [contenteditable]:not([contenteditable="false"]), audio[controls], video[controls]';

function tabbables(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(TABBABLE)].filter((el) =>
    el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled && !el.closest('[inert]') &&
    !(el instanceof HTMLInputElement && el.type === 'hidden') && el.checkVisibility?.({ visibilityProperty: true }) !== false &&
    // Radio groups: only the checked one (or the first) is a tab stop.
    !(el instanceof HTMLInputElement && el.type === 'radio' && !el.checked && !!el.name &&
      document.querySelector(`input[type=radio][name="${CSS.escape(el.name)}"]:checked`)));
}

/**
 * Where focus goes when the panel moves it into the widget (Enter on its placeholder): the widget's own root
 * element, made focusable with tabindex=-1 if it isn't, so key handlers on the root (a component's
 * `onKeyDown`) see keys at once and Tab goes on to its first control. Focusing the frame alone would leave
 * focus on <body>, outside the widget's tree.
 */
function focusEntry(root: HTMLElement, focus: (el: HTMLElement) => void): void {
  const a = document.activeElement;
  if (a && a !== document.body && a !== document.documentElement) return;
  const el = root.firstElementChild;
  if (!(el instanceof HTMLElement) && !(el instanceof SVGElement)) return;
  if (!el.hasAttribute('tabindex') && (el as HTMLElement).tabIndex < 0) el.setAttribute('tabindex', '-1');
  focus(el as HTMLElement);
}

export function installFocus(post: (m: FromWidget) => void, root?: HTMLElement): { interacting: () => boolean } {
  let lastInteraction = -Infinity;
  const interacting = () => performance.now() - lastInteraction < INTERACTION_MS;
  let lastReported = -Infinity;
  const mark = () => {
    lastInteraction = performance.now();
    // Told to the panel (throttled): a click that moves focus here with no pointer travel the panel saw (an
    // instant click by automation or assistive technology) isn't held against the widget.
    if (lastInteraction - lastReported >= ACTIVITY_MS) {
      lastReported = lastInteraction;
      post({ type: 'input' });
    }
  };
  window.addEventListener('pointerdown', mark, true);
  window.addEventListener('keydown', mark, true);

  const htmlFocus = HTMLElement.prototype.focus;
  const svgFocus = SVGElement.prototype.focus;
  // The frame got focus (the panel focused it, or a click landed on no control): into the widget's tree.
  if (root) {
    window.addEventListener('focus', () => focusEntry(root, (el) => (el instanceof SVGElement ? svgFocus : htmlFocus).call(el, { preventScroll: true })));
  }

  // focus(): only while the reader is interacting here (or the frame already has focus: moving it within
  // the frame takes nothing from anyone). React's autoFocus calls this too.
  for (const proto of [HTMLElement.prototype, SVGElement.prototype]) {
    const original = proto.focus;
    Object.defineProperty(proto, 'focus', {
      configurable: true, writable: true,
      value: function focus(this: HTMLElement, options?: FocusOptions) {
        if (document.hasFocus() || interacting()) return original.call(this, options);
      },
    });
  }
  const windowFocus = window.focus;
  Object.defineProperty(window, 'focus', { configurable: true, writable: true, value: () => { if (interacting()) windowFocus.call(window); } });

  const exit = (dir: Dir, e?: KeyboardEvent) =>
    post(e?.isTrusted
      ? { type: 'focusExit', dir, key: { key: e.key, code: e.code, keyCode: e.keyCode, shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, repeat: e.repeat } }
      : { type: 'focusExit', dir });

  // Bubble phase on window: widget handlers (React's, on its root) run first and can claim the key.
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.isComposing) return;
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const list = tabbables();
      const i = list.indexOf(document.activeElement as HTMLElement);
      // From the body (the panel just focused the frame), Tab goes to the first stop; Shift+Tab leaves.
      const atEdge = list.length === 0 || (e.shiftKey ? i <= 0 : i === list.length - 1);
      if (atEdge) {
        e.preventDefault();
        exit(e.shiftKey ? 'backward' : 'forward');
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      exit('escape');
      return;
    }
    if (((e.ctrlKey || e.metaKey || e.altKey) && !['Control', 'Meta', 'Alt', 'Shift', 'AltGraph'].includes(e.key)) || e.key === 'F1') {
      // Editing and clipboard keys stay with the widget; so does anything typed into a text field.
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && !e.altKey && ['a', 'c', 'v', 'x', 'z', 'y'].includes(k)) return;
      if (keepsFocus(document.activeElement)) return;
      // With the key, which the panel may pass on to VS Code (its keybindings don't see keys pressed in here).
      exit('shortcut', e);
    }
  });

  // A pointer click that didn't land in a text field, select or range gives focus back, so shortcuts keep
  // working; posted in a task after `click`, so the widget's handler (and any reveal() it calls) runs first.
  let pointerDown = false;
  window.addEventListener('pointerdown', () => { pointerDown = true; }, true);
  window.addEventListener('pointercancel', () => { pointerDown = false; }, true);
  window.addEventListener('click', (e) => {
    const byPointer = e.detail > 0 || pointerDown;
    pointerDown = false;
    if (!byPointer) return; // Enter/Space on a button: keep focus in the widget
    const target = e.target instanceof Element ? e.target : null;
    if (keepsFocus(target) || target?.closest('label')?.control && keepsFocus(target.closest('label')!.control)) return;
    __cxEnv!.native.setTimeout(() => {
      if (keepsFocus(document.activeElement)) return; // the handler moved focus into a field
      exit('pointer');
    }, 0);
  }, true);

  let lastActivity = -Infinity;
  const activity = () => {
    const now = performance.now();
    if (now - lastActivity < ACTIVITY_MS) return;
    lastActivity = now;
    post({ type: 'activity' });
  };
  window.addEventListener('wheel', activity, { passive: true, capture: true });
  window.addEventListener('touchmove', activity, { passive: true, capture: true });

  return { interacting };
}

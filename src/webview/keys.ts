// VS Code runs its keybindings (Cmd+Shift+P, Ctrl+P, Ctrl+-, …) on keys pressed in the panel's own document: its
// webview host listens on this window and passes them to the workbench. Keys pressed in the content frame or a widget
// frame never get here, so the panel passes on the ones meant for VS Code as an equivalent event on its own window.
// VS Code takes untrusted key events from extension webviews (`forwardUntrustedKeypressEvents`), so these work.

export interface KeyInfo {
  type: 'keydown' | 'keyup';
  key: string;
  code: string;
  keyCode: number;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  repeat: boolean;
}

const MODIFIERS = ['Control', 'Meta', 'Alt'];
const F_KEY = /^F([1-9]|1\d|2[0-4])$/;

export const keyInfo = (e: KeyboardEvent): KeyInfo => ({
  type: e.type === 'keyup' ? 'keyup' : 'keydown',
  key: e.key,
  code: e.code,
  keyCode: e.keyCode,
  shiftKey: e.shiftKey,
  altKey: e.altKey,
  ctrlKey: e.ctrlKey,
  metaKey: e.metaKey,
  repeat: e.repeat,
});

/**
 * A key VS Code may have a binding for: a combination with Ctrl, Cmd or Alt, or an F-key; for a key-up, a modifier
 * being released (the Ctrl+Tab switcher waits for it). Not clipboard, undo or select-all: those act on the frame's
 * own selection.
 */
export function forVsCode(k: KeyInfo): boolean {
  if (k.type === 'keyup') return MODIFIERS.includes(k.key);
  if (F_KEY.test(k.key)) return true;
  const mod = k.ctrlKey || k.metaKey;
  if (!mod && !k.altKey) return false;
  if (mod && !k.altKey && /^[zy]$/i.test(k.key)) return false;
  if (mod && !k.altKey && !k.shiftKey && /^[acvx]$/i.test(k.key)) return false;
  return true;
}

/** Controls that take typing: their keys (Alt+Left, Ctrl+Backspace, …) are theirs. */
export function typingIn(t: Element | null | undefined): boolean {
  const el = t as HTMLElement | null | undefined;
  if (!el?.tagName) return false;
  return el.isContentEditable || /^(TEXTAREA|SELECT)$/.test(el.tagName) || (el.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|reset|range|color)$/.test((el as HTMLInputElement).type));
}

/** Hands a key to VS Code: dispatched on the panel's window (not its document), so the panel's own handlers don't see it. */
export function passToVsCode(k: KeyInfo): void {
  const { type, ...init } = k;
  window.dispatchEvent(new KeyboardEvent(type, { ...init, bubbles: true, cancelable: true }));
}

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
/** With Ctrl or Cmd (no Alt) these move the caret or scroll: the frame's own (to the top, to the end). */
const MOVES = /^(Arrow(Up|Down|Left|Right)|Home|End|PageUp|PageDown)$/;

export const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
export const WINDOWS = /Win/.test(navigator.platform);

type Mods = Pick<KeyInfo, 'key' | 'code' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey'>;

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
  if (mod && !k.altKey && MOVES.test(k.key)) return false;
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

/**
 * Back (-1) or Forward (1) keys the page takes itself: on macOS, Alt+Left / Right and Cmd+[ / ], which VS Code binds to
 * nothing there. The ones VS Code navigates with (Ctrl+- on macOS, Alt+Left or Ctrl+Alt+- elsewhere) reach it as usual
 * and run Sidestory: Back / Forward (package.json keybindings), so VS Code sees every key of the chord: a lone Alt
 * would open its menu bar.
 */
export function historyKey(k: Mods, mac = MAC): 0 | 1 | -1 {
  if (!mac || k.shiftKey || k.ctrlKey) return 0;
  if (k.altKey && !k.metaKey && (k.key === 'ArrowLeft' || k.key === 'ArrowRight')) return k.key === 'ArrowLeft' ? -1 : 1;
  if (k.metaKey && !k.altKey && (k.code === 'BracketLeft' || k.code === 'BracketRight')) return k.code === 'BracketLeft' ? -1 : 1;
  return 0;
}

/**
 * The shortcuts a widget may pass on to VS Code. The frame's word that the reader pressed them is all the panel has (a
 * widget can claim a key after any real click), so only these: the Command Palette, Quick Open, switching editors,
 * the side bar and panel, the terminal, editor groups, zoom, Back and Forward, F1. Never a repeat.
 */
export function widgetShortcut(k: KeyInfo): boolean {
  if (k.type !== 'keydown' || k.repeat) return false;
  const { code, shiftKey: shift, altKey: alt, ctrlKey: ctrl, metaKey: meta } = k;
  const mod = ctrl !== meta; // Ctrl or Cmd, not both
  if (code === 'F1') return !ctrl && !meta && !alt;
  if (mod && !alt && code === 'KeyP') return true; // Quick Open; Command Palette with Shift
  if (mod && !alt && !shift && (code === 'KeyB' || code === 'KeyJ')) return true;
  if (ctrl && !meta && !alt && code === 'Tab') return true;
  if (ctrl && !meta && !alt && !shift && code === 'Backquote') return true;
  if (mod && !alt && !shift && /^Digit[1-9]$/.test(code)) return true;
  // Zoom; on macOS Ctrl+- and Ctrl+Shift+- are Back and Forward.
  if (mod && !alt && (code === 'Equal' || code === 'Minus' || (code === 'Digit0' && !shift))) return true;
  if (ctrl && !meta && alt && !shift && code === 'Minus') return true; // Back on Linux
  if (meta && !ctrl && !alt && !shift && (code === 'BracketLeft' || code === 'BracketRight')) return true;
  if (alt && !ctrl && !meta && !shift && (code === 'ArrowLeft' || code === 'ArrowRight')) return true;
  return false;
}

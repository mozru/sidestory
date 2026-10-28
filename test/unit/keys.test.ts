// Which keys pressed in the panel's frames go on to VS Code (src/webview/keys.ts).
import { describe, expect, it } from 'vitest';
import { forVsCode, historyKey, type KeyInfo, widgetShortcut } from '../../src/webview/keys.ts';

const k = (key: string, mods: Partial<KeyInfo> = {}): KeyInfo => ({ type: 'keydown', key, code: '', keyCode: 0, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, repeat: false, ...mods });

describe('forVsCode', () => {
  it('passes combinations with Ctrl, Cmd or Alt, and F-keys', () => {
    expect(forVsCode(k('P', { metaKey: true, shiftKey: true }))).toBe(true);
    expect(forVsCode(k('p', { ctrlKey: true }))).toBe(true);
    expect(forVsCode(k('-', { ctrlKey: true }))).toBe(true);
    expect(forVsCode(k('Meta', { metaKey: true }))).toBe(true);
    expect(forVsCode(k('F1'))).toBe(true);
    expect(forVsCode(k('F12'))).toBe(true);
    expect(forVsCode(k('C', { metaKey: true, shiftKey: true }))).toBe(true);
  });

  it('keeps plain keys, and clipboard, undo and select-all for the frame', () => {
    for (const key of ['j', 'k', 'Escape', 'Enter', ' ', 'Tab', 'ArrowDown', 'F', 'Shift']) expect(forVsCode(k(key))).toBe(false);
    expect(forVsCode(k('Tab', { shiftKey: true }))).toBe(false);
    for (const key of ['a', 'c', 'v', 'x', 'z', 'y']) {
      expect(forVsCode(k(key, { ctrlKey: true }))).toBe(false);
      expect(forVsCode(k(key, { metaKey: true }))).toBe(false);
    }
    expect(forVsCode(k('z', { metaKey: true, shiftKey: true }))).toBe(false);
  });

  it('keeps Ctrl/Cmd with arrows, Home, End and Page keys for the frame (scroll to the top or end)', () => {
    for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']) {
      expect(forVsCode(k(key, { ctrlKey: true }))).toBe(false);
      expect(forVsCode(k(key, { metaKey: true, shiftKey: true }))).toBe(false);
    }
    expect(forVsCode(k('ArrowLeft', { altKey: true }))).toBe(true); // Back, VS Code's on Windows and Linux
    expect(forVsCode(k('ArrowLeft', { ctrlKey: true, altKey: true }))).toBe(true);
  });

  it('passes a modifier being released (the Ctrl+Tab switcher waits for it), not other key-ups without one', () => {
    expect(forVsCode(k('Control', { type: 'keyup' }))).toBe(true);
    expect(forVsCode(k('Meta', { type: 'keyup' }))).toBe(true);
    expect(forVsCode(k('Shift', { type: 'keyup' }))).toBe(false);
    expect(forVsCode(k('j', { type: 'keyup' }))).toBe(false);
  });
});

const c = (code: string, mods: Partial<KeyInfo> = {}): KeyInfo => k(code.replace(/^(Key|Digit)/, ''), { code, ...mods });

describe('widgetShortcut', () => {
  it('allows the palette, Quick Open, editors, panels, the terminal, groups, zoom, Back / Forward and F1', () => {
    for (const [code, mods] of [
      ['KeyP', { ctrlKey: true, shiftKey: true }], ['KeyP', { metaKey: true }], ['Tab', { ctrlKey: true }], ['Tab', { ctrlKey: true, shiftKey: true }],
      ['KeyB', { metaKey: true }], ['KeyJ', { ctrlKey: true }], ['Backquote', { ctrlKey: true }], ['Digit3', { metaKey: true }],
      ['Equal', { ctrlKey: true }], ['Minus', { metaKey: true }], ['Digit0', { ctrlKey: true }], ['Minus', { ctrlKey: true, shiftKey: true }],
      ['Minus', { ctrlKey: true, altKey: true }], ['BracketLeft', { metaKey: true }], ['BracketRight', { metaKey: true }],
      ['ArrowLeft', { altKey: true }], ['ArrowRight', { altKey: true }], ['F1', {}],
    ] as const) expect(widgetShortcut(c(code, mods)), `${code} ${JSON.stringify(mods)}`).toBe(true);
  });

  it('refuses everything else, repeats and key-ups', () => {
    for (const [code, mods] of [
      ['KeyB', { ctrlKey: true, shiftKey: true }], ['KeyQ', { metaKey: true }], ['KeyW', { ctrlKey: true }], ['KeyW', { metaKey: true, shiftKey: true }],
      ['F4', { altKey: true }], ['KeyN', { ctrlKey: true }], ['KeyR', { ctrlKey: true }], ['KeyP', { ctrlKey: true, metaKey: true }],
      ['KeyP', { ctrlKey: true, altKey: true }], ['Digit3', { ctrlKey: true, shiftKey: true }], ['F5', {}], ['ArrowLeft', { altKey: true, shiftKey: true }],
    ] as const) expect(widgetShortcut(c(code, mods)), `${code} ${JSON.stringify(mods)}`).toBe(false);
    expect(widgetShortcut(c('KeyP', { ctrlKey: true, shiftKey: true, repeat: true }))).toBe(false);
    expect(widgetShortcut(c('KeyP', { ctrlKey: true, shiftKey: true, type: 'keyup' }))).toBe(false);
  });
});

describe('historyKey', () => {
  it('is Alt+Left / Right and Cmd+[ / ] on macOS, nothing elsewhere', () => {
    expect(historyKey(k('ArrowLeft', { altKey: true }), true)).toBe(-1);
    expect(historyKey(k('ArrowRight', { altKey: true }), true)).toBe(1);
    expect(historyKey(k('[', { code: 'BracketLeft', metaKey: true }), true)).toBe(-1);
    expect(historyKey(k(']', { code: 'BracketRight', metaKey: true }), true)).toBe(1);
    expect(historyKey(k('-', { code: 'Minus', ctrlKey: true }), true)).toBe(0); // VS Code's, through its keybinding
    expect(historyKey(k('ArrowLeft', { altKey: true }), false)).toBe(0);
  });
});

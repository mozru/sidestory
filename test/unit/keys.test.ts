// Which keys pressed in the panel's frames go on to VS Code (src/webview/keys.ts).
import { describe, expect, it } from 'vitest';
import { forVsCode, type KeyInfo } from '../../src/webview/keys.ts';

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

  it('passes a modifier being released (the Ctrl+Tab switcher waits for it), not other key-ups without one', () => {
    expect(forVsCode(k('Control', { type: 'keyup' }))).toBe(true);
    expect(forVsCode(k('Meta', { type: 'keyup' }))).toBe(true);
    expect(forVsCode(k('Shift', { type: 'keyup' }))).toBe(false);
    expect(forVsCode(k('j', { type: 'keyup' }))).toBe(false);
  });
});

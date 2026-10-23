import { describe, expect, it } from 'vitest';
import { displayText, escapeIcons, firstSentence, middleTruncate, plainForMessage } from '../../src/core/display-text.ts';

describe('displayText', () => {
  it('turns C0 and C1 controls and line separators into spaces', () => {
    expect(displayText('a\nb\tc\rd\u0000e\u001bf\u007fg\u0085h\u009fi j k', 100)).toBe('a b c d e f g h i j k');
  });
  it('removes bidirectional marks, overrides and isolates', () => {
    for (const c of ['؜', '‎', '‏', '‪', '‫', '‬', '‭', '‮', '⁦', '⁧', '⁨', '⁩']) {
      expect(displayText(`ab${c}cd`, 100), c.codePointAt(0)!.toString(16)).toBe('abcd');
    }
  });
  it('removes invisible characters', () => {
    for (const c of ['­', '​', '‌', '‍', '⁠', '⁡', '⁢', '⁣', '⁤', '﻿']) {
      expect(displayText(`ab${c}cd`, 100), c.codePointAt(0)!.toString(16)).toBe('abcd');
    }
  });
  it('removes tag characters', () => {
    expect(displayText(`ok${String.fromCodePoint(0xe0001)}${String.fromCodePoint(0xe0041)}${String.fromCodePoint(0xe007f)}!`, 100)).toBe('ok!');
  });
  it('removes lone surrogates but keeps pairs', () => {
    expect(displayText('a\ud800b\udc00c', 100)).toBe('abc');
    expect(displayText('a😀b', 100)).toBe('a😀b');
  });
  it('collapses whitespace and trims', () => {
    expect(displayText('  a    b　c  ', 100)).toBe('a b c');
  });
  it('cuts with an ellipsis, never inside a surrogate pair', () => {
    expect(displayText('abcdef', 4)).toBe('abc…');
    expect(displayText('abcdef', 6)).toBe('abcdef');
    const cut = displayText('ab😀cd', 4); // the pair would straddle the cut
    expect(cut).toBe('ab…');
    expect(cut.length).toBeLessThanOrEqual(4);
    expect(displayText('😀😀😀', 3)).toBe('😀…');
  });
});

describe('escaping', () => {
  it('escapeIcons shows icon syntax literally', () => {
    expect(escapeIcons('$(alert) hi $(x)')).toBe('\\$(alert) hi \\$(x)');
    expect(escapeIcons('$ (a) $a')).toBe('$ (a) $a');
  });
  it('plainForMessage cleans and breaks link syntax', () => {
    expect(plainForMessage('[Click](command:workbench.action.reloadWindow)‮')).toBe('[Click] (command:workbench.action.reloadWindow)');
    expect(plainForMessage('a\nb')).toBe('a b');
    expect(plainForMessage('x'.repeat(400)).length).toBe(300);
  });
});

describe('helpers', () => {
  it('firstSentence cuts at a sentence end', () => {
    expect(firstSentence('The FIFO holds beats until the sink is ready. Then it drains.', 140)).toBe('The FIFO holds beats until the sink is ready.');
    expect(firstSentence('x'.repeat(200), 140)).toHaveLength(140);
    expect(firstSentence('Short.', 140)).toBe('Short.');
  });
  it('middleTruncate keeps both ends', () => {
    expect(middleTruncate('abcdefghij', 5)).toBe('ab…ij');
    expect(middleTruncate('abc', 5)).toBe('abc');
  });
});

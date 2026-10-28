// Editor decorations (src/extension/decorations.ts): colors come from the theme, and every highlight stays
// visible in high contrast themes, which leave highlight backgrounds transparent.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { config, decorationTypes, Range, ThemeColor, Uri, window } from './vscode-stub.ts';

vi.mock('vscode', () => import('./vscode-stub.ts'));
const { Decorations } = await import('../../src/extension/decorations.ts');

const colors = (JSON.parse(readFileSync('package.json', 'utf8')) as { contributes: { colors: { id: string; defaults: Record<string, string> }[] } }).contributes.colors;
const visible = (c: string | undefined) => !!c && !/^#[0-9a-f]{6}00$|^#[0-9a-f]{3}0$/i.test(c);

describe('widget highlights', () => {
  it('have a border from the theme that high contrast themes draw (their highlight backgrounds are transparent)', () => {
    decorationTypes.length = 0;
    new Decorations().dispose();
    const widget = decorationTypes.find((o) => (o.overviewRulerColor as ThemeColor | undefined)?.id === 'editorOverviewRuler.wordHighlightForeground');
    expect(widget).toBeDefined();
    const border = (widget!.borderColor as ThemeColor | undefined)?.id;
    expect(border).toBe('sidestory.widgetHighlightBorder');
    expect(widget!.borderWidth).toBe('1px');
    const def = colors.find((c) => c.id === border)!.defaults;
    expect(visible(def.highContrast) && visible(def.highContrastLight)).toBe(true);
    // The background is the theme's word highlight, outside high contrast.
    const bg = colors.find((c) => c.id === (widget!.backgroundColor as ThemeColor).id)!.defaults;
    expect(bg.dark).toBe('editor.wordHighlightBackground');
  });

  it('repaint only the widget decorations, scanning only the widget lines', () => {
    const uri = Uri.file('/w/a.ts');
    let lineReads = 0;
    const lines = Array.from({ length: 5000 }, (_, i) => (i === 10 ? 'const foo = foo + 1;' : `line ${i} foo`));
    const document = { uri, lineCount: lines.length, lineAt: (i: number) => (lineReads++, { text: lines[i]!, range: { end: { line: i, character: lines[i]!.length } } }) };
    const painted: { ranges: unknown[] }[] = [];
    const editor = { document, setDecorations: (_t: unknown, ranges: unknown[]) => painted.push({ ranges }) };
    (window as { visibleTextEditors: unknown[] }).visibleTextEditors = [editor];
    const d = new Decorations();
    try {
      d.setWidget({ uri: uri as never, range: { start: 10, end: 12 }, identifiers: ['foo'] });
      expect(painted).toHaveLength(2); // the widget's range and its identifiers: nothing else
      expect(lineReads).toBe(3);
      const ids = painted[1]!.ranges as { start: { line: number; character: number } }[];
      expect(ids.map((r) => [r.start.line, r.start.character])).toEqual([[9, 7], [10, 6], [10, 12], [11, 8]]);
    } finally {
      d.dispose();
      (window as { visibleTextEditors: unknown[] }).visibleTextEditors = [];
    }
  });
});

describe('the click highlight', () => {
  const editor = () => {
    const calls: unknown[][] = [];
    return { calls, setDecorations: (_t: unknown, ranges: unknown[]) => calls.push(ranges) };
  };
  const range = new Range(3, 0, 5, 0) as never;

  it('fades after sidestory.clickHighlightSeconds, and stays with 0 until the next click, which clears it in the other editor', () => {
    vi.useFakeTimers();
    const d = new Decorations();
    try {
      const a = editor();
      d.flash(a as never, range);
      vi.advanceTimersByTime(1499);
      expect(a.calls.at(-1)).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(a.calls.at(-1)).toEqual([]);

      config['sidestory.clickHighlightSeconds'] = 0;
      d.flash(a as never, range);
      vi.advanceTimersByTime(24 * 3600_000);
      expect(a.calls.at(-1)).toHaveLength(1);
      const b = editor();
      d.flash(b as never, range);
      expect(a.calls.at(-1)).toEqual([]);
      expect(b.calls.at(-1)).toHaveLength(1);
    } finally {
      delete config['sidestory.clickHighlightSeconds'];
      d.dispose();
      vi.useRealTimers();
    }
  });

  it('restarts its timer on the next click, clears the other editor then, and falls back to 1.5 s for a value that is no number', () => {
    vi.useFakeTimers();
    const d = new Decorations();
    try {
      const a = editor();
      const b = editor();
      d.flash(a as never, range);
      vi.advanceTimersByTime(1000);
      d.flash(a as never, range);
      vi.advanceTimersByTime(1000); // past the first deadline
      expect(a.calls.at(-1)).toHaveLength(1);
      d.flash(b as never, range);
      expect(a.calls.at(-1)).toEqual([]);
      vi.advanceTimersByTime(1500);
      expect(b.calls.at(-1)).toEqual([]);

      config['sidestory.clickHighlightSeconds'] = 'abc';
      d.flash(a as never, range);
      vi.advanceTimersByTime(1500);
      expect(a.calls.at(-1)).toEqual([]);

      config['sidestory.clickHighlightSeconds'] = 0;
      d.flash(a as never, range);
      d.clearFlash(); // the panel shows another sidestory
      expect(a.calls.at(-1)).toEqual([]);
    } finally {
      delete config['sidestory.clickHighlightSeconds'];
      d.dispose();
      vi.useRealTimers();
    }
  });
});

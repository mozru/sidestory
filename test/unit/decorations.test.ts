// Editor decorations (src/extension/decorations.ts): colors come from the theme, and every highlight stays
// visible in high contrast themes, which leave highlight backgrounds transparent.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { decorationTypes, ThemeColor } from './vscode-stub.ts';

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
});

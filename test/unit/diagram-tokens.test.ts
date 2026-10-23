// The diagram tokens (docs/AUTHORING-PLAN.md §6): one file for the content frame and widget frames, resolving from
// the theme in all four test themes.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type ThemeName, THEMES } from '../webview/themes.ts';

describe('diagram tokens (src/shared/diagram-tokens.css)', () => {
  const css = readFileSync(join(__dirname, '../../src/shared/diagram-tokens.css'), 'utf8');
  /** The declarations of the first rule whose selector starts with `selector`. */
  const block = (selector: string) => {
    const at = css.indexOf(selector);
    const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
    return new Map([...body.matchAll(/(--cx-[\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
  };
  const defaults = block(':where(:root)');
  const hc = block(':where(:root.hc');
  const SYSTEM = /\b(Canvas|CanvasText|GrayText|LinkText|Highlight)\b/;

  /** Substitutes var() as the browser would, with a theme's --vscode-* values; null if a var has no value. */
  function resolve(value: string, vars: Map<string, string>, depth = 0): string | null {
    if (depth > 20) return null;
    const i = value.indexOf('var(');
    if (i < 0) return value;
    let level = 0;
    let j = i + 4;
    let comma = -1;
    for (; j < value.length; j++) {
      const c = value[j];
      if (c === '(') level++;
      else if (c === ')' && level-- === 0) break;
      else if (c === ',' && level === 0 && comma < 0) comma = j;
    }
    const name = value.slice(i + 4, comma < 0 ? j : comma).trim();
    const own = vars.get(name);
    const replacement = own !== undefined ? resolve(own, vars, depth + 1) : comma < 0 ? null : resolve(value.slice(comma + 1, j).trim(), vars, depth + 1);
    if (replacement === null) return null;
    return resolve(value.slice(0, i) + replacement + value.slice(j + 1), vars, depth + 1);
  }

  const themeVars = (name: ThemeName) => {
    const vars = new Map(Object.entries(THEMES[name].vars).map(([k, v]) => [`--vscode-${k}`, v]));
    for (const [k, v] of defaults) vars.set(k, v);
    if (name.startsWith('hc')) for (const [k, v] of hc) vars.set(k, v);
    return vars;
  };

  it('defines the tokens the guide documents', () => {
    for (const t of ['--cx-box-fill', '--cx-box-fill-strong', '--cx-box-stroke', '--cx-box-text', '--cx-label', '--cx-wire-data', '--cx-wire-addr', '--cx-wire-ctrl', '--cx-wire-status', '--cx-wire-irq', '--cx-wire-clock', '--cx-wire-reset', '--cx-wire-muted', '--cx-domain-1', '--cx-domain-4', '--cx-arrow', '--cx-grid', '--cx-dash-ctrl', '--cx-dash-status', '--cx-dash-irq', '--cx-dash-reset', '--cx-dim-opacity', '--cx-link-hover', '--cx-link-ring', '--cx-here']) {
      expect(defaults.has(t), t).toBe(true);
    }
    expect(css).toMatch(/--cx-on: var\(--cx-step-accent/);
    expect(hc.get('--cx-dim-opacity')).toBe('1');
  });

  it.each(['dark', 'light', 'hc', 'hc-light'] as const)('every token resolves from the theme, not a system-color fallback (%s)', (name) => {
    const vars = themeVars(name);
    for (const [token] of defaults) {
      const v = resolve(`var(${token})`, vars);
      expect(v, `${token} in ${name}`).not.toBeNull();
      expect(v, `${token} in ${name}`).not.toMatch(SYSTEM);
    }
  });

  it('wires read at 3:1 against boxes and the editor in the default themes, except the known misses', () => {
    const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const lum = (c: number[]) => {
      const [r, g, b] = c.map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const ratio = (a: string, b: string) => {
      const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((p, q) => q - p);
      return (x! + 0.05) / (y! + 0.05);
    };
    const misses: string[] = [];
    for (const name of ['dark', 'light'] as const) {
      const vars = themeVars(name);
      for (const wire of ['data', 'addr', 'ctrl', 'status', 'irq', 'clock', 'reset']) {
        const color = resolve(`var(--cx-wire-${wire})`, vars)!;
        for (const bg of ['--cx-box-fill', '--vscode-editor-background']) {
          const r = ratio(color, resolve(`var(${bg})`, vars)!);
          if (r < 3) misses.push(`${name} ${wire} on ${bg} ${r.toFixed(2)}`);
        }
      }
    }
    // The theme's own chart colors; listed so a change is deliberate.
    expect(misses).toEqual(['light ctrl on --cx-box-fill 2.77', 'light ctrl on --vscode-editor-background 2.94', 'light reset on --cx-box-fill 2.93']);
  });
});

import { describe, expect, it } from 'vitest';
import { rewriteCss } from '../../src/webview/sanitize.ts';

const BASE = 'https://res.example/ws/.explain/demo/';

describe('rewriteCss', () => {
  it('points relative url() at the explainer folder and drops others', () => {
    expect(rewriteCss('.a{background:url(img/a.png)}', BASE)).toBe(`.a{background:url("${BASE}img/a.png")}`);
    expect(rewriteCss('.a{background:url("https://evil.example/x.png")}', BASE)).toBe('.a{background:none}');
    expect(rewriteCss('.a{background:url(../../secret.png)}', BASE)).toBe('.a{background:none}');
  });

  it.each([
    ['hex escape', '.a{background:\\75 rl(https://evil.example/x.png)}'],
    ['letter escapes', '.a{background:\\u\\r\\l(https://evil.example/x.png)}'],
    ['escaped @import', '@\\i\\m\\p\\o\\r\\t "https://evil.example/a.css";'],
    ['image-set', '.a{background:image-set("https://evil.example/z.png" 1x)}'],
  ])('neutralizes %s', (_, css) => {
    expect(rewriteCss(css, BASE)).not.toMatch(/evil\.example\/[a-z]\.(png|css)"?\)|@import/i);
  });

  it.each(['url(', 'url("', "url('", 'url( ', 'url(\\'])('stays linear on hostile input: %s repeated', (unit) => {
    const css = unit.repeat(Math.floor(490_000 / unit.length));
    const t0 = performance.now();
    rewriteCss(css, BASE);
    expect(performance.now() - t0).toBeLessThan(150);
  });
});

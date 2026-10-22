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

describe('rewriteCss: round 3 audit', () => {
  it.each([
    ['url( + spaces', 'url(' + ' '.repeat(490_000)],
    ['url( + spaces + quote', 'url(' + ' '.repeat(489_000) + '"'],
    ['many escapes', '\\75 '.repeat(120_000)],
    ['many strings', '"a"'.repeat(160_000)],
  ])('is linear on %s', (_, css) => {
    const t0 = performance.now();
    rewriteCss(css, BASE);
    expect(performance.now() - t0).toBeLessThan(150);
  });

  it.each([
    ['escaped hyphen in image-set', 'a{b:image\\-set("https://evil.example/q.png" 1x)}'],
    ['hex hyphen in image-set', 'a{b:image\\2d set("https://evil.example/q.png" 1x)}'],
    ['escape inside a bare url', 'a{b:url(http\\://evil.example/q.png)}'],
    ['chained escapes', 'a{b:\\5c 75rl(https://evil.example/q.png)}'],
  ])('neutralizes %s', (_, css) => {
    const out = rewriteCss(css, BASE);
    expect(out).not.toMatch(/(image-set|url)\(\s*["']?https?:\/\/evil/i);
    expect(out).not.toContain('\\');
  });

  it('keeps ordinary CSS intact', () => {
    expect(rewriteCss('a::before{content:"\\2192  next"} b{color:var(--x)}', BASE)).toBe('a::before{content:"\\2192  next"} b{color:var(--x)}');
  });
});

describe('rewriteCss: comments and newlines (navigation audit)', () => {
  const BASE = 'https://x.vscode-cdn.net/ws/.explain/a/';
  const remote = (css: string) => /url\("?https:\/\/(evil|file)/.test(rewriteCss(css, BASE));
  it.each([
    "/* ' */ a{background-image:url(https://evil.example/a.png)} /* ' */",
    '/* " */ a{background:u\\72l(https://evil.example/a.png)} /* " */',
    "a{content:'x\f;background-image:url(https://evil.example/b.png)} b{content:'}",
    "a{content:'x\r;background-image:url(https://evil.example/b.png)} b{content:'}",
    "a{content:'x\r\n;background-image:url(https://evil.example/b.png)} b{content:'}",
    "/* ' */ a{background:url(https://file+.vscode-resource.vscode-cdn.net/etc/p.png)} /* ' */",
  ])('leaves no remote url() in %j', (css) => {
    expect(remote(css)).toBe(false);
  });

  it('keeps local urls and ordinary comments working', () => {
    expect(rewriteCss('/* a comment */ a{background:url(img/x.png)}', BASE)).toContain(`url("${BASE}img/x.png")`);
  });
});

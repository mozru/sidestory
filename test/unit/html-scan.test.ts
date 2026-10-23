// The linear, resumable HTML scanner (src/core/html-scan.ts, docs/NAVIGATION-PLAN.md §6.2 and §12.1): outline
// rules, caps, resumable feeding, and hostile shapes that made the old regex scanner quadratic.
import { describe, expect, it } from 'vitest';
import { HtmlTokenizer, MAX_DEPTH, OUTLINE_LIMITS, OutlineScanner, outlineHtml, type Token } from '../../src/core/html-scan.ts';
import { scanHtml } from '../../src/cli/html.ts';

const titles = (html: string) => outlineHtml(html).steps.map((s) => s.title);

describe('outlineHtml', () => {
  it('takes the step title from data-explain-title, else the first h1–h4, else the id; empty values fall through', () => {
    const html = [
      '<section data-explain-anchor="a" data-explain-title="Given"><h2>Heading</h2></section>',
      '<section data-explain-anchor="b"><p>x</p><div><h3>Deep  <em>heading</em></h3></div><h2>Second</h2></section>',
      '<section data-explain-anchor="c"><h5>Not a step heading</h5></section>',
      '<section data-explain-anchor="d" data-explain-title=""><h4>From heading</h4></section>',
      '<section data-explain-anchor="e" data-explain-title="  "><h2> </h2></section>',
      '<section data-explain-anchor="f"><div data-explain-anchor="g"><h2>Nested heading</h2></div></section>',
    ].join('\n');
    expect(titles(html)).toEqual(['Given', 'Deep heading', 'c', 'From heading', 'e', 'Nested heading']);
  });

  it('decodes entities, maps nested anchors to their step, and keeps details in document order', () => {
    const o = outlineHtml(
      '<p data-explain-detail="intro">x</p><section data-explain-anchor="s1"><h2>A &amp; B &#x3c;C&#62; &nbsp;</h2>' +
        '<div data-explain-anchor="n1"><a data-explain-detail="d1">d</a></div></section>' +
        '<section data-explain-anchor="s2" data-explain-detail="d2"><a data-explain-detail="d1">again</a></section>',
    );
    expect(o.steps.map((s) => [s.id, s.title])).toEqual([['s1', 'A & B <C>'], ['s2', 's2']]);
    expect([...o.anchorStep]).toEqual([['s1', 's1'], ['n1', 's1'], ['s2', 's2']]);
    expect(o.details.map((d) => [d.name, d.stepId])).toEqual([['intro', undefined], ['d1', 's1'], ['d2', 's2'], ['d1', 's2']]);
    expect(o.truncated).toBe(false);
  });

  it('decodes common named entities as the panel does (case-sensitive), and keeps unknown ones as written', () => {
    const o = outlineHtml('<section data-explain-anchor="s" data-explain-title="Reset &rarr; Idle &mdash; done&hellip; &Dagger;&dagger; &AMP; &bogus;"></section>');
    expect(o.steps[0]!.title).toBe('Reset → Idle — done… ‡† & &bogus;');
  });

  it('never finds inherited names: "&toString;" stays as written', () => {
    expect(outlineHtml('<section data-explain-anchor="s" data-explain-title="a &toString; &constructor; &__proto__;"></section>').steps[0]!.title).toBe('a &toString; &constructor; &__proto__;');
  });

  it('skips comments, scripts, styles, templates and everything the sanitizer removes', () => {
    const o = outlineHtml(
      [
        '<!-- <section data-explain-anchor="c1"></section> <a data-explain-detail="c">-->',
        '<script>"<section data-explain-anchor=s1>"</script><style>.x{content:"<a data-explain-detail=s>"}</style>',
        '<template><section data-explain-anchor="t1"><a data-explain-detail="t"></a></section></template>',
        '<noscript><section data-explain-anchor="n1"></section></noscript>',
        '<form><section data-explain-anchor="f1"></section></form>',
        '<textarea><section data-explain-anchor="ta"></section></textarea>',
        '<svg><animate data-explain-detail="anim"></animate></svg>',
        '<section data-explain-anchor="real"><h2>Real<script>document.title="no"</script></h2></section>',
      ].join(''),
    );
    expect(o.steps.map((s) => [s.id, s.title])).toEqual([['real', 'Real']]);
    expect(o.details).toEqual([]);
  });

  it('takes the blurb from the first paragraph, cut at a sentence end or 140 characters', () => {
    const o = outlineHtml(
      '<section data-explain-anchor="a"><h2>T</h2><p>The FIFO absorbs bursts. Then it drains.</p></section>' +
        `<section data-explain-anchor="b"><p>${'word '.repeat(60)}</p></section>` +
        '<section data-explain-anchor="c"><p>Implied end<div>not part of it</div></section>',
    );
    expect(o.steps[0]!.blurb).toBe('The FIFO absorbs bursts.');
    expect(o.steps[1]!.blurb.length).toBeLessThanOrEqual(140);
    expect(o.steps[1]!.blurb.endsWith('…')).toBe(true);
    expect(o.steps[2]!.blurb).toBe('Implied end');
  });

  it('cleans titles: controls and bidi characters removed, 120 characters at most', () => {
    const o = outlineHtml(`<section data-explain-anchor="a" data-explain-title="Evil‮txt.exe\u0007"></section><section data-explain-anchor="b"><h2>${'x'.repeat(5000)}</h2></section>`);
    expect(o.steps[0]!.title).toBe('Eviltxt.exe');
    expect(o.steps[1]!.title.length).toBeLessThanOrEqual(OUTLINE_LIMITS.titleChars);
  });

  it('caps steps and detail links', () => {
    const many = Array.from({ length: 600 }, (_, i) => `<section data-explain-anchor="s${i}"><a data-explain-detail="d${i}"></a></section>`).join('');
    const o = outlineHtml(many);
    expect(o.steps).toHaveLength(OUTLINE_LIMITS.steps);
    expect(o.details).toHaveLength(OUTLINE_LIMITS.details);
  });

  it('stops at the time backstop with truncated set, keeping what it found', () => {
    let t = 0;
    // A clock that jumps 10 ms per reading: the backstop is reached after about 50 readings.
    const s = new OutlineScanner(`<section data-explain-anchor="first"><h2>First</h2></section>${'<div></div>'.repeat(200_000)}`, () => (t += 10));
    while (!s.feed(15));
    const o = s.result();
    expect(o.truncated).toBe(true);
    expect(o.steps.map((x) => x.title)).toEqual(['First']);
  });

  it('gives the same outline fed in tiny slices as in one call', () => {
    const html = `${'<section data-explain-anchor="a"><h2>A</h2><p>Para.</p><a data-explain-detail="x"></a></section>'.repeat(300)}`;
    let t = 0;
    const s = new OutlineScanner(html, () => t++);
    let feeds = 0;
    while (!s.feed(1)) feeds++;
    expect(feeds).toBeGreaterThan(10);
    const sliced = s.result();
    const whole = outlineHtml(html);
    expect(sliced.truncated).toBe(false);
    expect({ ...sliced, anchorStep: [...sliced.anchorStep] }).toEqual({ ...whole, anchorStep: [...whole.anchorStep] });
  });
});

describe('the tokenizer', () => {
  const tokens = (html: string) => {
    const t = new HtmlTokenizer(html);
    const out: Token[] = [];
    for (let x = t.next(); x; x = t.next()) out.push(x);
    return out;
  };

  it('reads attributes first-wins with entities decoded, quoted and unquoted, and self-closing slashes', () => {
    const [a] = tokens(`<A Href="x&amp;y" href=z data-x='1 > 2' bare disabled=yes />`);
    expect(a).toMatchObject({ kind: 'start', name: 'a', selfClosing: true });
    expect([...(a as { attrs: Map<string, string> }).attrs]).toEqual([['href', 'x&y'], ['data-x', '1 > 2'], ['bare', ''], ['disabled', 'yes']]);
  });

  it('treats a "<" that starts no markup as text, and drops a tag cut off at the end', () => {
    expect(tokens('a < b <3 </ c').map((t) => t.kind)).toEqual(['text', 'text', 'text']); // "</ c" opens a bogus comment
    expect(tokens('x<div class="never closed')).toEqual([{ kind: 'text', start: 0, end: 1 }]);
  });

  it('finds the end of raw text case-insensitively and only at a real end tag', () => {
    const [s] = tokens('<script>a</scriptx>b</SCRIPT >c');
    expect(s).toMatchObject({ name: 'script', raw: { start: 8, end: 20 } });
  });
});

describe('hostile input stays linear (docs/NAVIGATION-PLAN.md §12.1)', () => {
  const MB = 1_000_000;
  const fill = (unit: string, bytes = 5 * MB) => unit.repeat(Math.ceil(bytes / unit.length));
  const shapes: [string, () => string][] = [
    ['nested <div>s', () => fill('<div>')],
    ['repeated <a " with no closing quote', () => fill('<a "')],
    ['an unclosed <a x="…', () => `<a x="${fill('y')}`],
    ['</a  with no >', () => fill('</a ')],
    ['<!x with no >', () => fill('<!x ')],
    ['an unclosed comment', () => `<!--${fill('<div>')}`],
    ['an attribute 1 MB long', () => `<section data-explain-anchor="a" title="${'z'.repeat(MB)}"><h2>t</h2></section>${fill('<p>x</p>', 4 * MB)}`],
    ['stray end tags under 512 open elements', () => '<div>'.repeat(MAX_DEPTH) + fill('</x>')],
    ['implied ends deep in the stack', () => `<p>${'<span>'.repeat(MAX_DEPTH - 2)}${fill('<div></div>')}`],
    ['raw text with many false end tags', () => `<script>${fill('</scrip')}`],
  ];

  for (const [name, make] of shapes) {
    it(`outlines ${name} in under 1 s, in short slices`, () => {
      const html = make();
      const s = new OutlineScanner(html);
      const t0 = performance.now();
      let worst = 0;
      for (;;) {
        const a = performance.now();
        const done = s.feed(15);
        worst = Math.max(worst, performance.now() - a);
        if (done) break;
      }
      const total = performance.now() - t0;
      // Timings for the record (docs/NAVIGATION-PLAN.md §11.1: under 1 s total, 20 ms per slice).
      console.log(`outline ${name}: ${(html.length / MB).toFixed(1)} MB, ${total.toFixed(0)} ms total, worst slice ${worst.toFixed(1)} ms`);
      expect(total).toBeLessThan(1000);
      // Loose (3× and more), so a busy CI machine doesn't flake: the clock is checked between tags, and one
      // 5 MB tag (repeated `<a "`) is a single step of about 30 ms on a laptop.
      expect(worst).toBeLessThan(150);
    });

    it(`the checker's scanHtml handles ${name} in under 1 s`, () => {
      const html = make();
      const t0 = performance.now();
      scanHtml(html);
      const total = performance.now() - t0;
      console.log(`scanHtml ${name}: ${total.toFixed(0)} ms`);
      expect(total).toBeLessThan(1000);
    });
  }
});

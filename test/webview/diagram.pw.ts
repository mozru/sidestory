// Diagrams that follow the steps (data-explain-on), the built-in look of linked elements, data-explain-code in the
// panel, cursor rings (cx-here) and the sanitizer's drops (docs/AUTHORING-PLAN.md §2, §3, §8.1, §8.2, §9.4).
import { expect, type Page, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { AnchorView, FromWebview, ToWebview } from '../../src/shared/protocol.ts';
import { type ThemeName, THEMES, themeCss } from './themes.ts';

const FIXTURE = 'fixtures/sample-workspace/.sidestory/bit-reader';
const MANIFEST = JSON.parse(readFileSync(`${FIXTURE}/manifest.json`, 'utf8')) as {
  title: string;
  anchors: Record<string, { file: string; range: [number, number]; color?: string }>;
};
const ANCHORS: AnchorView[] = Object.entries(MANIFEST.anchors).map(([id, a]) => ({
  id,
  file: a.file,
  range: { start: a.range[0], end: a.range[1] },
  state: 'exact',
  colorVar: a.color ? `--vscode-${a.color.replace('.', '-')}` : undefined,
}));
const DIR = 'file:///ws/.sidestory/bit-reader';

const DIAGRAM = `<style>
  svg { width: 300px; height: 100px; display: block; }
  .cx-on .wire { stroke: var(--cx-on); }
</style>
<section data-explain-anchor="interface"><h2>Interface</h2>
  <figure data-explain-diagram="step dim-rest" id="dia">
    <svg viewBox="0 0 300 100" role="group" aria-label="A test diagram">
      <defs><marker id="arr" markerWidth="4" markerHeight="4"><path id="mk" d="M0 0 L4 2 L0 4z"/></marker></defs>
      <g id="g-state" data-explain-on="state"><rect class="wire" id="r-state" x="0" y="0" width="20" height="20" stroke="red"/></g>
      <g id="g-consume" data-explain-on="consume refill"><rect id="r-consume" x="30" width="20" height="20"/>
        <g id="g-inner" data-explain-on="refill"><rect x="60" width="20" height="20"/></g>
      </g>
      <g id="g-outer" data-explain-on="consume"><rect id="r-outer-own" x="90" width="20" height="20"/>
        <g id="g-hs" data-explain-on="handshakes"><rect x="120" width="20" height="20"/></g>
      </g>
      <g id="g-never" data-explain-on=""><rect x="150" width="20" height="20"/></g>
      <g id="bg"><rect id="r-bg" x="180" width="20" height="20"/><g><rect id="r-bg2" x="210" width="20" height="20"/></g></g>
      <g id="legend" data-explain-keep><rect id="r-legend" x="240" width="20" height="20"/><g id="g-kept" data-explain-on="state"><rect x="270" width="20" height="20"/></g></g>
      <path id="p-wire" d="M0 50 L300 50" stroke="blue" marker-end="url(#arr)"/>
    </svg>
    <figcaption id="cap">caption</figcaption>
  </figure>
  <table><tr id="row" data-explain-on="state"><td>a row about state</td></tr></table>
</section>
<section data-explain-anchor="state"><h2>State</h2><p>State.</p>
  <div data-explain-anchor="handshakes"><p>Handshakes, nested.</p></div>
</section>
<section data-explain-anchor="consume"><h2>Consume</h2>
  <div data-explain-diagram="section" id="sec-dia"><svg viewBox="0 0 100 20"><g id="s-consume" data-explain-on="consume"><rect class="wire" id="s-consume-r" width="20" height="20" stroke="red"/></g><g id="s-state" data-explain-on="state"><rect x="30" width="20" height="20"/></g></svg></div>
</section>
<section data-explain-anchor="refill"><h2>Refill</h2><p>Refill.</p></section>`;

const LINKS = `<section data-explain-anchor="interface"><h2>Interface</h2>
  <figure data-explain-code-file="rtl/bit_reader.sv">
    <svg viewBox="0 0 200 60" role="group" aria-label="Links" style="width: 400px; height: 120px">
      <g id="svg-ref" data-explain-ref="refill" style="color: rgb(1, 2, 3)"><rect id="svg-rect" x="10" y="10" width="40" height="30" fill="var(--cx-box-fill)" stroke="currentColor"/><text id="svg-text" x="10" y="55" fill="currentColor">FIFO</text></g>
      <g id="svg-plain" data-explain-ref="state" data-explain-plain><rect x="70" y="10" width="40" height="30" fill="var(--cx-box-fill)" stroke="currentColor"/></g>
      <g id="svg-code" data-explain-code="#driver(count_q)"><rect x="130" y="10" width="40" height="30" fill="var(--cx-box-fill)" stroke="currentColor"/></g>
    </svg>
  </figure>
  <p><a id="text-ref" data-explain-ref="consume">consume</a> and <span id="text-code" data-explain-code="rtl/bit_reader.sv#L3-L5">lines 3 to 5</span>.</p>
  <div id="box-ref" data-explain-ref="refill" style="width: 120px">a box</div>
  <button id="btn" type="button" data-explain-code="rtl/bit_reader.sv">a button</button>
  <div id="wrap" data-explain-code="rtl/bit_reader.sv#L1"><input type="checkbox" id="chk"></div><label for="chk" id="lbl">toggle</label>
  <span id="bad" data-explain-code="../secret.sv">bad</span>
  <span id="both" data-explain-ref="state" data-explain-code="rtl/bit_reader.sv">both</span>
  <p id="san" accesskey="k" autofocus data-cx-hl="1" data-cx-state="lost" data-cx-whatever="1">sanitized</p>
  <div data-explain-anchor="state"><p>nested</p></div>
</section>
<section data-explain-anchor="refill"><h2>Refill</h2><p>Refill.</p></section>`;

async function open(page: Page, html: string, opts: { theme?: ThemeName; active?: string; bodyClass?: string } = {}): Promise<void> {
  const theme = opts.theme ?? 'dark';
  await page.goto('/test/webview/harness.html');
  await page.evaluate(([css, cls]) => {
    document.documentElement.setAttribute('style', css);
    document.body.className = cls;
  }, [themeCss(theme), `${THEMES[theme].bodyClass} ${opts.bodyClass ?? ''}`.trim()] as const);
  await expect.poll(() => posted(page)).toContainEqual({ type: 'ready' });
  const base = await page.evaluate(() => `${location.origin}/fixtures/sample-workspace/.sidestory/bit-reader/`);
  await send(page, { type: 'init', title: MANIFEST.title, html, anchors: ANCHORS, active: opts.active, dir: DIR, base, trail: [{ name: 'bit-reader', title: MANIFEST.title }] });
  await expect(page.locator('.cx-title')).toHaveText(MANIFEST.title);
}

const send = (page: Page, m: ToWebview) => page.evaluate((msg) => (window as unknown as { __send(m: unknown): void }).__send(msg), m);
const posted = (page: Page) => page.evaluate(() => (window as unknown as { __posted: FromWebview[] }).__posted);
const clearPosted = (page: Page) => page.evaluate(() => ((window as unknown as { __posted: FromWebview[] }).__posted = []));
const frame = (page: Page) => page.frameLocator('iframe.cx-content-frame');
const el = (page: Page, id: string) => frame(page).locator(`#${id}`);
/** The diagram classes of each element, by id. */
const classes = (page: Page, ids: string[]) =>
  frame(page)
    .locator('body')
    .evaluate((b, list) => Object.fromEntries(list.map((id) => [id, ['cx-on', 'cx-dim', 'cx-dimming'].filter((c) => b.querySelector(`#${id}`)!.classList.contains(c)).join(' ')])), ids);
const ALL = ['dia', 'g-state', 'g-consume', 'g-inner', 'g-outer', 'r-outer-own', 'g-hs', 'g-never', 'bg', 'r-bg', 'legend', 'g-kept', 'p-wire', 'mk', 'cap', 'row', 'sec-dia', 's-consume', 's-state'];
/** Transitions running in the content (not the "updated" glow, which an edit is meant to start). */
const transitions = (page: Page) => frame(page).locator('body').evaluate((b) => b.ownerDocument.getAnimations().filter((a) => a.constructor.name !== 'CSSAnimation' || (a as CSSAnimation).animationName !== 'cx-updated').map((a) => `${a.constructor.name} ${(a as CSSTransition).transitionProperty ?? (a as CSSAnimation).animationName} ${((a.effect as KeyframeEffect).target as Element)?.id}`));
const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;

test.describe('data-explain-on', () => {
  test('nothing changes while no tagged element is lit; a section-mode diagram shows its own section', async ({ page }) => {
    await open(page, DIAGRAM, { active: 'interface' });
    const c = await classes(page, ALL);
    expect(Object.entries(c).filter(([id, v]) => v && !id.startsWith('s')).map(([id]) => id)).toEqual([]);
    // In section "consume", whatever the step.
    expect(c['sec-dia']).toBe('cx-dimming');
    expect(c['s-consume']).toBe('cx-on');
    expect(c['s-state']).toBe('cx-dim');
  });

  test('a step lights its parts and fades exactly the rest: untagged subtrees under dim-rest, never defs, markers or kept content', async ({ page }) => {
    await open(page, DIAGRAM, { active: 'interface' });
    await send(page, { type: 'syncTo', anchorId: 'state' });
    await expect(el(page, 'g-state')).toHaveClass(/cx-on/);
    expect(await classes(page, ALL)).toEqual({
      dia: 'cx-dimming',
      'g-state': 'cx-on',
      'g-consume': 'cx-dim',
      'g-inner': '', // inside a faded group: not faded again (no 0.28²)
      'g-outer': 'cx-dim',
      'r-outer-own': '',
      'g-hs': '',
      'g-never': 'cx-dim',
      bg: 'cx-dim', // one class on the outermost untagged subtree
      'r-bg': '',
      legend: '',
      'g-kept': 'cx-on', // kept content lights up, but never fades
      'p-wire': 'cx-dim',
      mk: '',
      cap: 'cx-dim',
      row: 'cx-on', // outside any diagram: lit, nothing fades around it
      'sec-dia': 'cx-dimming',
      's-consume': 'cx-on',
      's-state': 'cx-dim',
    });
    await expect(el(page, 'g-consume')).toHaveCSS('opacity', '0.28');
    await expect(el(page, 'g-state')).toHaveCSS('opacity', '1');
  });

  test('a lit group keeps its tagged children; a group that only holds something lit fades its other tagged parts, not its own drawing', async ({ page }) => {
    await open(page, DIAGRAM, { active: 'consume' });
    let c = await classes(page, ALL);
    expect([c['g-consume'], c['g-inner'], c['g-outer'], c['g-hs'], c['g-state']]).toEqual(['cx-on', '', 'cx-on', '', 'cx-dim']);
    // Nested anchor "handshakes" is in step "state": both ids are lit.
    await send(page, { type: 'syncTo', anchorId: 'handshakes' });
    await expect(el(page, 'g-hs')).toHaveClass(/cx-on/);
    c = await classes(page, ALL);
    expect([c['g-state'], c['g-hs'], c['g-outer'], c['r-outer-own'], c['g-consume'], c.row]).toEqual(['cx-on', 'cx-on', '', '', 'cx-dim', 'cx-on']);
    // refill lights both groups that name it.
    await send(page, { type: 'syncTo', anchorId: 'refill' });
    await expect(el(page, 'g-inner')).toHaveClass(/cx-on/);
    c = await classes(page, ALL);
    expect([c['g-consume'], c['g-inner'], c['g-outer'], c['g-state']]).toEqual(['cx-on', 'cx-on', 'cx-dim', 'cx-dim']);
  });

  test('lit parts take the active step’s color; a section-mode diagram its own section’s', async ({ page }) => {
    await open(page, DIAGRAM, { active: 'state' });
    const dark = THEMES.dark.vars;
    await expect(el(page, 'r-state')).toHaveCSS('stroke', rgb(dark['charts-green']!));
    await expect(el(page, 's-consume-r')).toHaveCSS('stroke', rgb(dark['charts-orange']!));
  });

  test('a step change marks no section updated; a live edit keeps the state without restarting a fade', async ({ page }) => {
    const slow = DIAGRAM.replace('<style>', '<style>\n  #dia * { transition: opacity 5s linear; }');
    await open(page, slow, { active: 'interface' });
    await page.locator('.cx-step', { hasText: 'State' }).click();
    await expect(el(page, 'g-consume')).toHaveClass(/cx-dim/);
    await expect(frame(page).locator('.cx-updated')).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(await page.locator('[aria-live]').textContent()).not.toMatch(/updated/);
    // Let the step's fades finish, then edit another section.
    await frame(page).locator('body').evaluate((b) => b.ownerDocument.getAnimations().forEach((a) => a.finish()));
    await send(page, { type: 'content', title: MANIFEST.title, html: slow.replace('<p>Refill.</p>', '<p>Refill, edited.</p>') });
    await expect(frame(page).getByText('Refill, edited.')).toBeVisible();
    expect(await transitions(page)).toEqual([]);
    await expect(el(page, 'g-consume')).toHaveCSS('opacity', '0.28');
    await expect(section(page, 'refill')).toHaveClass(/cx-updated/);
    await expect(section(page, 'interface')).not.toHaveClass(/cx-updated/);
  });

  test('reduced motion: no fade transition', async ({ page }) => {
    await open(page, DIAGRAM, { active: 'state', bodyClass: 'vscode-reduce-motion' });
    await expect(el(page, 'g-consume')).toHaveCSS('transition-duration', '0s');
  });

  for (const theme of ['hc', 'hc-light'] as const) {
    test(`high contrast (${theme}): nothing fades, lit parts get a dashed outline`, async ({ page }) => {
      await open(page, DIAGRAM, { theme, active: 'state' });
      await expect(el(page, 'g-consume')).toHaveClass(/cx-dim/);
      await expect(el(page, 'g-consume')).toHaveCSS('opacity', '1');
      // A halo around lit SVG parts, a dashed outline on lit HTML elements.
      await expect(el(page, 'g-state')).toHaveCSS('filter', /drop-shadow/);
      await expect(el(page, 'row')).toHaveCSS('outline-style', 'dashed');
      await expect(el(page, 'row')).toHaveCSS('outline-color', rgb(THEMES[theme].vars.contrastActiveBorder!));
      await expect(el(page, 'r-state')).toHaveCSS('stroke', rgb(THEMES[theme].vars.contrastActiveBorder!));
    });
  }

  test('stepping through 2,000 tagged parts stays fast', async ({ page }) => {
    const parts = Array.from({ length: 2000 }, (_, i) => `<rect data-explain-on="${['state', 'consume', 'refill', ''][i % 4]}" x="${i % 100}" y="${Math.floor(i / 100)}" width="1" height="1"/>`).join('');
    await open(page, `<section data-explain-anchor="interface"><h2>I</h2><figure data-explain-diagram="dim-rest"><svg viewBox="0 0 100 20">${parts}</svg></figure></section>
<section data-explain-anchor="state"><h2>S</h2></section><section data-explain-anchor="consume"><h2>C</h2></section><section data-explain-anchor="refill"><h2>R</h2></section>`, { active: 'interface' });
    const times: number[] = [];
    for (const id of ['state', 'consume', 'refill', 'state']) {
      times.push(
        await page.evaluate(async (anchorId) => {
          const t0 = performance.now();
          (window as unknown as { __send(m: unknown): void }).__send({ type: 'syncTo', anchorId });
          await new Promise((r) => requestAnimationFrame(() => setTimeout(r)));
          return performance.now() - t0;
        }, id),
      );
    }
    await expect(frame(page).locator('.cx-dim')).toHaveCount(1500);
    expect(Math.max(...times)).toBeLessThan(100);
  });
});

const section = (page: Page, id: string) => frame(page).locator(`[data-explain-anchor="${id}"]`).first();

test.describe('linked elements', () => {
  test('SVG links keep their colors and text; a glow on hover, an outline on focus; data-explain-plain opts out', async ({ page }) => {
    await open(page, LINKS);
    await expect(el(page, 'svg-ref')).toHaveCSS('color', 'rgb(1, 2, 3)');
    await expect(el(page, 'svg-rect')).toHaveCSS('stroke', 'rgb(1, 2, 3)');
    await expect(el(page, 'svg-text')).toHaveCSS('text-decoration-line', 'none');
    await expect(el(page, 'svg-ref')).toHaveCSS('cursor', 'pointer');
    await expect(el(page, 'svg-ref')).toHaveCSS('filter', 'none');
    await el(page, 'svg-ref').hover();
    await expect(el(page, 'svg-ref')).toHaveCSS('filter', /drop-shadow/);
    await el(page, 'svg-plain').hover();
    await expect(el(page, 'svg-plain')).toHaveCSS('filter', 'none');
    await expect(el(page, 'svg-plain')).toHaveCSS('cursor', 'pointer');
    // Keyboard focus: an outline, which Chromium paints around an SVG group.
    await page.mouse.move(0, 0);
    const box = (await el(page, 'svg-ref').boundingBox())!;
    // Around the element: the outline is drawn outside it.
    const clip = { x: box.x - 8, y: box.y - 8, width: box.width + 16, height: box.height + 16 };
    const before = await page.screenshot({ clip, animations: 'disabled' });
    await el(page, 'svg-ref').focus();
    await page.keyboard.press('Shift'); // a key press: focus is keyboard focus
    await expect(el(page, 'svg-ref')).toHaveCSS('outline-style', 'solid');
    await expect(el(page, 'svg-ref')).toHaveCSS('outline-color', rgb(THEMES.dark.vars.focusBorder!));
    const after = await page.screenshot({ clip, animations: 'disabled' });
    expect(after.equals(before)).toBe(false);
    await el(page, 'svg-plain').focus();
    // Not the built-in ring: the browser's own focus ring, which an author's rule may restyle.
    await expect(el(page, 'svg-plain')).toHaveCSS('outline-style', 'auto');
  });

  test('text links look as before; boxes get an outline, not a color', async ({ page }) => {
    await open(page, LINKS);
    const dark = THEMES.dark.vars;
    await expect(el(page, 'text-ref')).toHaveCSS('color', rgb(dark['textLink-foreground']!));
    await expect(el(page, 'text-ref')).toHaveCSS('text-decoration-style', 'dotted');
    await expect(el(page, 'text-code')).toHaveCSS('text-decoration-style', 'dotted');
    await expect(el(page, 'box-ref')).toHaveCSS('color', rgb(dark['editor-foreground']!));
    await expect(el(page, 'box-ref')).toHaveCSS('text-decoration-line', 'none');
    await el(page, 'box-ref').hover();
    await expect(el(page, 'box-ref')).toHaveCSS('outline-style', 'solid');
    await expect(el(page, 'box-ref')).toHaveCSS('outline-width', '1px');
  });

  test('clicks and Enter open refs and code links; data-explain-code-file gives the path; a ref wins over code', async ({ page }) => {
    await open(page, LINKS);
    await clearPosted(page);
    await el(page, 'svg-code').click();
    await el(page, 'text-code').click();
    await el(page, 'svg-ref').focus();
    await page.keyboard.press('Enter');
    await el(page, 'both').click();
    const opened = (await posted(page)).filter((m) => m.type === 'openCode' || m.type === 'openRef');
    expect(opened).toEqual([
      { type: 'openCode', path: 'rtl/bit_reader.sv', target: 'driver(count_q)' },
      { type: 'openCode', path: 'rtl/bit_reader.sv', target: 'L3-L5' },
      { type: 'openRef', anchorId: 'refill' },
      { type: 'openRef', anchorId: 'state' },
    ]);
    await expect(el(page, 'svg-code')).toHaveAttribute('role', 'link');
    await expect(el(page, 'svg-code')).toHaveAttribute('tabindex', '0');
  });

  test('no link fires without the reader aiming at it: synthetic events, form controls, labels, invalid links', async ({ page }) => {
    await open(page, LINKS);
    await clearPosted(page);
    await frame(page).locator('body').evaluate((b) => {
      (b.querySelector('#svg-code') as unknown as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
      (b.querySelector('#text-code') as HTMLElement).click();
      b.querySelector('#svg-ref')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await el(page, 'btn').click();
    await el(page, 'lbl').click(); // forwards a trusted click to the checkbox inside a linked div
    await expect(el(page, 'chk')).toBeChecked();
    await el(page, 'bad').click();
    await page.waitForTimeout(200);
    expect((await posted(page)).filter((m) => m.type === 'openCode' || m.type === 'openRef')).toEqual([]);
    for (const id of ['btn', 'bad']) await expect(el(page, id)).not.toHaveAttribute('data-cx-ref', /.*/);
  });

  test('the sanitizer drops accesskey, autofocus and every author data-cx-* attribute', async ({ page }) => {
    await open(page, LINKS);
    const attrs = await el(page, 'san').evaluate((p) => p.getAttributeNames());
    expect(attrs).toEqual(['id']);
  });

  test('an invalid code link is reported to Output once', async ({ page }) => {
    await open(page, LINKS);
    const logs = (await posted(page)).filter((m) => m.type === 'widgetLog').map((m) => (m as { message: string }).message);
    expect(logs.filter((l) => l.includes('../secret.sv'))).toHaveLength(1);
  });

  test('the page tells the extension what it links to, once per change', async ({ page }) => {
    await open(page, LINKS);
    const targets = (await posted(page)).filter((m) => m.type === 'codeTargets');
    expect(targets).toEqual([{ type: 'codeTargets', sections: ['interface', 'state', 'refill'], refs: ['refill', 'state', 'consume'], links: ['rtl/bit_reader.sv#driver(count_q)', 'rtl/bit_reader.sv#L3-L5', 'rtl/bit_reader.sv#L1'] }]);
    await clearPosted(page);
    await send(page, { type: 'content', title: MANIFEST.title, html: LINKS.replace('<p>Refill.</p>', '<p>Refill!</p>') });
    await expect(frame(page).getByText('Refill!')).toBeVisible();
    await send(page, { type: 'content', title: MANIFEST.title, html: LINKS.replace('#L3-L5', '#L4-L5') });
    await expect(el(page, 'text-code')).toHaveAttribute('data-explain-code', /L4-L5/);
    expect((await posted(page)).filter((m) => m.type === 'codeTargets').map((m) => (m as { links: string[] }).links[1])).toEqual(['rtl/bit_reader.sv#L4-L5']);
  });

  test('here rings the elements linked to the cursor’s code, and the ring survives a live edit', async ({ page }) => {
    await open(page, LINKS);
    await send(page, { type: 'here', ref: 'refill' });
    await expect(el(page, 'svg-ref')).toHaveClass(/cx-here/);
    await expect(el(page, 'box-ref')).toHaveClass(/cx-here/);
    await expect(frame(page).locator('.cx-here')).toHaveCount(2);
    await expect(el(page, 'box-ref')).toHaveCSS('outline-style', 'solid');
    await send(page, { type: 'here', link: 'rtl/bit_reader.sv#driver(count_q)' });
    await expect(frame(page).locator('.cx-here')).toHaveCount(1);
    await expect(el(page, 'svg-code')).toHaveClass(/cx-here/);
    await frame(page).locator('body').evaluate((b) => b.ownerDocument.getAnimations().forEach((a) => a.finish()));
    await send(page, { type: 'content', title: MANIFEST.title, html: LINKS.replace('<p>Refill.</p>', '<p>Refill, edited.</p>') });
    await expect(frame(page).getByText('Refill, edited.')).toBeVisible();
    await expect(el(page, 'svg-code')).toHaveClass(/cx-here/);
    expect(await transitions(page)).toEqual([]);
    await send(page, { type: 'here' });
    await expect(frame(page).locator('.cx-here')).toHaveCount(0);
  });
});

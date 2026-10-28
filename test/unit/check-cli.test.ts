// The standalone widget checker (src/cli/check-widgets.ts → dist/check.cjs), run in-process on temporary
// explainers with the real widget compiler (its worker from source, widget data generated once).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { anchorUses, checkExplainer, formatReport, main, type CheckOptions, type CheckReport } from '../../src/cli/check-widgets.ts';
import { matches, parseCss, parseSelector, placementProblems } from '../../src/cli/css.ts';
import { commandPath, type BaseText } from '../../src/cli/coverage.ts';
import { scanHtml } from '../../src/cli/html.ts';
import { pinQuote } from '../../src/core/pin.ts';
import { splitLines } from '../../src/core/text.ts';
import type { WidgetCompilerOptions } from '../../src/extension/widgets/compile.ts';
import { WidgetCompiler } from '../../src/extension/widgets/compile.ts';

const repo = fileURLToPath(new URL('../../', import.meta.url));
let base = '';
let compilerOpts: WidgetCompilerOptions;
let n = 0;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'cx-check-'));
  const dataDir = join(base, 'widget-data');
  execFileSync(process.execPath, [join(repo, 'scripts/widget-data.ts'), dataDir], { cwd: repo });
  compilerOpts = { workerFile: join(repo, 'src/extension/widgets/compile-worker.ts'), dataDir };
}, 60_000);

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

/** A repository holding `.sidestory/demo` with `files` (paths relative to the repository). Returns the explainer folder. */
function repoWith(files: Record<string, string>): string {
  const root = join(base, `repo${n++}`);
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), content);
  }
  return join(root, '.sidestory/demo');
}

const CODE = 'line 1\nfunction refill() {\n  a = b;\n}\nline 5\nconst x = 1;\n';
const manifest = (anchors: Record<string, unknown>) => JSON.stringify({ version: 1, title: 'Demo', anchors }, null, 2);
const ANCHORS = { refill: { file: 'src/a.ts', range: [2, 4] }, other: { file: 'src/a.ts', range: [6, 6] } };

const page = (body: string, head = '') => `<!doctype html>\n<html><head>${head}</head><body>\n${body}\n</body></html>\n`;
const section = (id: string, inner: string) => `<section data-explain-anchor="${id}">\n<h2>${id}</h2>\n${inner}\n</section>`;
const widgetEl = (src: string, extra = '') => `<explain-widget src="${src}" title="Demo widget"${extra}>\n<p>Fallback text.</p>\n</explain-widget>`;

const GOOD_WIDGET = [
  "import { useAnchorCode, useStepValue, useWidgetState, highlight } from 'explainer';",
  "import { Button } from '@/components/ui/button';",
  'export default function W({ depth = 8 }: { depth?: number }) {',
  "  const [n, setN] = useWidgetState('n', 0);",
  "  const angle = useStepValue({ refill: 90, other: 180 }, 0);",
  "  const code = useAnchorCode('refill');",
  "  if (!code) return <p>Loading…</p>;",
  "  if (code.status === 'unavailable') return <p>Code not available.</p>;",
  '  return <Button onClick={() => { setN(n + 1); highlight([1, 2]); }}>{depth}{angle}{code.text}</Button>;',
  '}',
  '',
].join('\n');

async function check(dir: string, opts: Omit<CheckOptions, 'compiler'> = {}): Promise<CheckReport> {
  return checkExplainer(dir, { cwd: join(dir, '../..'), ...opts, compiler: compilerOpts });
}
const codes = (r: CheckReport, severity?: string) => r.findings.filter((f) => !severity || f.severity === severity).map((f) => f.code);

describe('scanHtml', () => {
  it('finds widgets with their props child, fallback, anchor and line', () => {
    const html = [
      '<!doctype html>',
      '<section data-explain-anchor="refill">',
      '  <p>Intro',
      '  <explain-widget src="w.tsx" title="T" height="300">',
      '    <script type="application/json">{"depth": 8}</script>',
      '    <img src="a.svg" alt="x">',
      '  </explain-widget>',
      '  <div data-explain-anchor="inner"><explain-widget src="v.tsx"></explain-widget></div>',
      '</section>',
      '<section data-explain-anchor="drain"><explain-widget src="u.tsx"/><p>after</p></section>',
    ].join('\n');
    const s = scanHtml(html);
    expect(s.steps).toEqual(['refill', 'drain']);
    expect(s.anchors).toEqual(['refill', 'inner', 'drain']);
    const [a, b, c] = s.widgets;
    expect(a!.line).toBe(4);
    expect(a!.attrs.get('height')).toBe('300');
    expect(a!.anchor).toBe('refill');
    expect(a!.jsonChildren).toEqual([{ text: '{"depth": 8}', line: 5 }]);
    expect(a!.hasFallback).toBe(true);
    // The <p> was closed by nothing; the widget is still inside the section, not inside an implied element it isn't in.
    expect(a!.ancestors.map((e) => e.name)).toEqual(['section', 'p']);
    expect(b!.anchor).toBe('inner');
    expect(b!.hasFallback).toBe(false);
    expect(c!.selfClosing).toBe(true);
    expect(c!.anchor).toBe('drain');
  });

  it('closes <p> at a block element and list items at the next item', () => {
    const s = scanHtml('<p>one<div class="x"><explain-widget src="w.tsx">f</explain-widget></div><ul><li>a<li><explain-widget src="v.tsx">f</explain-widget></ul>');
    expect(s.widgets[0]!.ancestors.map((e) => e.name)).toEqual(['div']);
    expect(s.widgets[1]!.ancestors.map((e) => e.name)).toEqual(['ul', 'li']);
  });

  it('ignores markup inside comments, scripts and styles, and marks nested widgets', () => {
    const s = scanHtml('<!-- <explain-widget src="no.tsx"> --><style>.a::before{content:"<explain-widget>"}</style><explain-widget src="a.tsx"><explain-widget src="b.tsx">x</explain-widget></explain-widget>');
    expect(s.widgets.map((w) => [w.attrs.get('src'), w.nested])).toEqual([['a.tsx', false], ['b.tsx', true]]);
    expect(s.styles).toHaveLength(1);
  });
});

describe('placement (CSS)', () => {
  const el = (name: string, attrs: Record<string, string> = {}, line = 1) => ({ name, attrs: new Map(Object.entries(attrs)), line });

  it('matches descendant and child selectors against the ancestor chain', () => {
    const chain = [el('html'), el('body'), el('div', { class: 'card big' }), el('p', { id: 'x' })];
    const yes = (s: string, i = 3) => matches(parseSelector(s)!, chain, i);
    expect(yes('.card p')).toBe(true);
    expect(yes('div.card > #x')).toBe(true);
    expect(yes('body > p')).toBe(false);
    expect(yes(':root .big', 2)).toBe(true);
    expect(yes('[class~="big"]', 2)).toBe(true);
    expect(parseSelector('.a:hover')).toBeUndefined();
    expect(parseSelector('.a + .b')).toBeUndefined();
  });

  it('reports unsupported ancestors, scrollers, conditional rules and geometry animations', () => {
    const css = parseCss(
      [
        '.t { transform: rotate(1deg) }',
        '.n { transform: none }',
        '.h:hover { transform: scale(1.1) }',
        '@media (min-width: 1px) { .m { filter: blur(1px) } }',
        '.s { overflow: auto }',
        '@keyframes slide { from { translate: 0 } to { translate: 10px } }',
        '.a { animation: slide 1s }',
        '.tr { transition: transform .2s }',
      ].join('\n'),
      10,
    );
    const w = el('explain-widget');
    const problems = (cls: string, style?: string) =>
      placementProblems([el('div', { class: cls, ...(style ? { style } : {}) }, 5)], w, css).map((p) => `${p.severity}:${p.property}${p.source.kind === 'rule' ? `@${p.source.line}` : ''}`);
    expect(problems('t')).toEqual(['error:transform@10']);
    expect(problems('n')).toEqual([]);
    expect(problems('h')).toEqual([]);
    expect(problems('m')).toEqual(['warning:filter@13']);
    expect(problems('s')).toEqual(['warning:overflow@14']);
    expect(problems('a')).toEqual(['error:animation@16']);
    expect(problems('tr')).toEqual(['warning:transition@17']);
    expect(problems('x', 'position: sticky; top: 0')).toEqual(['error:position']);
    expect(problems('x', 'overflow: hidden; content-visibility: auto')).toEqual(['error:content-visibility']);
  });

  it('matches descendant selectors over deep chains without backtracking (it used to take ~35 s)', () => {
    const chain = [...Array.from({ length: 60 }, () => el('div')), el('explain-widget')];
    const t0 = performance.now();
    // No p ancestor, so every way of placing the divs fails: C(60, 7) tries without the memo.
    expect(matches(parseSelector(`p ${'div '.repeat(7)}explain-widget`)!, chain, 60)).toBe(false);
    expect(matches(parseSelector(`div ${'div '.repeat(20)}> explain-widget`)!, chain, 60)).toBe(true);
    expect(placementProblems(chain.slice(0, -1), chain[60]!, parseCss(`p ${'div '.repeat(7)}{ transform: rotate(1deg) }`))).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it('numbers rules in a large stylesheet in linear time, with line breaks counted as in the HTML', () => {
    const big = Array.from({ length: 20_000 }, (_, i) => `.c${i} span {\n  transform: none;\n}\n`).join('');
    const t0 = performance.now();
    const css = parseCss(big, 3);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(css.rules.at(-1)!.line).toBe(3 + 3 * 19_999);
    expect(parseCss('/* a\r\nb */ .x { color: red }\r\n.y { color: red }\r.z { color: red }/*\r*/\n.w { color: red }', 7).rules.map((r) => r.line)).toEqual([8, 9, 10, 12]);
  });

  it('classifies a stylesheet once for all widgets and ancestors', () => {
    const css = parseCss(Array.from({ length: 10_000 }, (_, i) => `.c${i} span { color: red; margin: 0 }\n${i % 20 === 0 ? `.t${i} { transform: rotate(1deg) }\n` : ''}`).join(''));
    const chain = Array.from({ length: 20 }, (_, i) => el('div', { class: i === 10 ? 't40' : 'a' }));
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) expect(placementProblems(chain, el('explain-widget'), css).map((p) => p.property)).toEqual(['transform']);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

describe('anchorUses', () => {
  it('finds anchor ids in compiled widget code, through renamed and namespace imports', async () => {
    const dir = repoWith({
      '.sidestory/demo/w.tsx': [
        "import { reveal as rv, Ref, useAnchorCode, highlight, goToStep, useStepValue, useIsActive } from 'explainer';",
        "import * as ex from 'explainer';",
        'export default function W({ id }: { id: string }) {',
        "  useAnchorCode('a'); useAnchorCode(id);",
        "  highlight([1, 2]); highlight(3, { anchor: 'b' });",
        "  useStepValue({ c: 1, 'd': 2 }, 0); useIsActive('e');",
        "  return <Ref anchor=\"f\" onClick={() => { rv('g'); ex.goToStep('h'); goToStep(`i`); }}>x</Ref>;",
        '}',
      ].join('\n'),
    });
    const compiler = new WidgetCompiler(compilerOpts);
    try {
      const r = await compiler.compile(dir, 'w.tsx');
      expect(r.errors).toEqual([]);
      const uses = anchorUses('w.tsx', r.modules['w.tsx']!)!;
      const shown = uses.map((u) => `${u.kind}:${u.id ?? (u.implicit ? '(enclosing)' : '(dynamic)')}@${u.line}`).sort();
      expect(shown).toEqual(
        ['useAnchorCode:a@4', 'useAnchorCode:(dynamic)@4', 'highlight:(enclosing)@5', 'highlight:b@5', 'useStepValue:c@6', 'useStepValue:d@6', 'useIsActive:e@6', 'Ref:f@7', 'reveal:g@7', 'goToStep:h@7', 'goToStep:i@7'].sort(),
      );
    } finally {
      compiler.dispose();
    }
  });
});

describe('checkExplainer', () => {
  it('passes a clean explainer (an unpinned useAnchorCode anchor is a warning)', async () => {
    const dir = repoWith({
      'src/a.ts': CODE,
      '.sidestory/demo/manifest.json': manifest(ANCHORS),
      '.sidestory/demo/sidestory.html': page(section('refill', widgetEl('widgets/w.tsx', ' height="240"')) + section('other', '<p>x</p>')),
      '.sidestory/demo/widgets/w.tsx': GOOD_WIDGET,
    });
    const r = await check(dir);
    expect(r.errors).toBe(0);
    expect(codes(r)).toEqual(['not-pinned']);
    expect(r.widgets).toEqual([{ src: 'widgets/w.tsx', line: 5, anchor: 'refill', ok: true }]);
    const out: string[] = [];
    expect(await main([dir], { out: (s) => out.push(s), err: (s) => out.push(s) }, compilerOpts)).toBe(0);
    expect(out.join('\n')).toMatch(/w\.tsx:6: warning not-pinned: useAnchorCode\('refill'\)/);
    expect(out.join('\n')).toMatch(/1 widget checked: 0 error\(s\), 1 warning\(s\)\.$/);
  });

  it('reads a CRLF checkout (Windows) the same way: same findings, same lines', async () => {
    const files = (eol: string) => ({
      'src/a.ts': CODE.replace(/\n/g, eol),
      '.sidestory/demo/manifest.json': manifest(ANCHORS).replace(/\n/g, eol),
      '.sidestory/demo/sidestory.html': page(section('refill', ['<div style="transform: scale(2)">', '<explain-widget src="widgets/w.tsx" title="W">', '<script type="application/json">{', '  "depth": 8,', '}</script>', 'fallback', '</explain-widget></div>'].join('\n'))).replace(/\n/g, eol),
      '.sidestory/demo/widgets/w.tsx': ["import { goToStep } from 'explainer';", 'export default function W() {', "  return <button onClick={() => goToStep('nope')}>x</button>;", '}'].join(eol),
    });
    const lines = async (eol: string) => {
      const dir = repoWith(files(eol));
      return (await check(dir)).findings.map((f) => `${f.file.slice(dir.length + 1).replaceAll('\\', '/')}:${f.line}:${f.code}`).sort();
    };
    expect(await lines('\r\n')).toEqual(await lines('\n'));
  });

  it('reports compile errors in the widget file, bad props, unknown anchors and placement, and exits 1', async () => {
    const dir = repoWith({
      'src/a.ts': CODE,
      '.sidestory/demo/manifest.json': manifest(ANCHORS),
      '.sidestory/demo/sidestory.html': page(
        section('refill', [
          '<div style="transform: scale(2)">',
          '<explain-widget src="widgets/w.tsx" title="W">',
          '<script type="application/json">{',
          '  "depth": 8,',
          '}</script>',
          'fallback',
          '</explain-widget></div>',
        ].join('\n')),
      ),
      '.sidestory/demo/widgets/w.tsx': [
        "import { reveal, goToStep } from 'explainer';",
        "import { Buton } from '@/components/ui/button';",
        'export default function W() {',
        "  return <Buton onClick={() => { reveal('nope'); goToStep('refill'); }}>x</Buton>;",
        '}',
      ].join('\n'),
    });
    const r = await check(dir);
    const errors = r.findings.filter((f) => f.severity === 'error').map((f) => `${f.file.slice(dir.length + 1).replaceAll('\\', '/')}:${f.line}:${f.code}`);
    expect(errors).toContain('sidestory.html:9:props-json'); // the line JSON.parse stopped at
    expect(errors).toContain('sidestory.html:6:placement');
    expect(errors).toContain('widgets/w.tsx:2:unknown-export');
    expect(errors).toContain('widgets/w.tsx:4:unknown-anchor');
    expect(r.findings.find((f) => f.code === 'unknown-export')!.message).toMatch(/Did you mean 'Button'/i);
    expect(r.findings.find((f) => f.code === 'placement')!.message).toMatch(/ancestor div \(line 5\) has transform: scale\(2\) in its style attribute/);
    const out: string[] = [];
    expect(await main([dir, '--json'], { out: (s) => out.push(s), err: () => {} }, compilerOpts)).toBe(1);
    expect(JSON.parse(out.join('')).errors).toBeGreaterThanOrEqual(4);
  });

  it('warns about highlight() outside an anchor, steps that are not steps, and missing fallback or title', async () => {
    const dir = repoWith({
      'src/a.ts': CODE,
      '.sidestory/demo/manifest.json': manifest({ ...ANCHORS, nested: { file: 'src/a.ts', range: [3, 3] } }),
      '.sidestory/demo/sidestory.html': page(`<explain-widget src="w.tsx"></explain-widget>\n${section('refill', '<p data-explain-anchor="nested">n</p>')}`),
      '.sidestory/demo/w.tsx': [
        "import { highlight, goToStep } from 'explainer';",
        "export default function W() { return <button onClick={() => { highlight(1); goToStep('nested'); }}>x</button>; }",
      ].join('\n'),
    });
    const r = await check(dir);
    expect(r.errors).toBe(0);
    // `other` is in the manifest but nothing uses it
    expect(codes(r).sort()).toEqual(['highlight-no-anchor', 'no-fallback', 'no-title', 'not-a-step', 'unused-anchor']);
  });

  it('reports useAnchorCode on secret-looking files and on code that changed since it was pinned', async () => {
    const dir = repoWith({
      'src/a.ts': CODE.replace('a = b;', 'a = c + d;'),
      'config/.env': 'TOKEN=1\n',
      '.sidestory/demo/manifest.json': JSON.stringify({
        version: 2, title: 'Demo',
        anchors: {
          refill: { file: 'src/a.ts', range: [2, 4], quote: { exact: 'function refill() {\n  a = b;\n}', prefix: 'line 1', suffix: 'line 5', norm: 'ws' } },
          env: { file: 'config/.env', range: [1, 1] },
          ci: { file: 'src/a.ts', range: [6, 6], quote: { exact: 'const x = 1;', prefix: '', suffix: '', norm: 'ws-ci' } },
        },
      }),
      '.sidestory/demo/sidestory.html': page(section('refill', widgetEl('w.tsx'))),
      '.sidestory/demo/w.tsx': "import { useAnchorCode } from 'explainer';\nexport default function W() { useAnchorCode('refill'); useAnchorCode('env'); useAnchorCode('ci'); return null; }\n",
    });
    const r = await check(dir);
    expect(codes(r).sort()).toEqual(['anchor-stale', 'not-pinned', 'secret-file']);
    expect(r.findings.find((f) => f.code === 'secret-file')!.severity).toBe('error');
  });

  it('doesn’t take ordinary code named like tokens for a secret file (file names only; source files never)', async () => {
    const dir = repoWith({
      'src/tokens/tokenBucket.ts': CODE,
      '.sidestory/demo/manifest.json': JSON.stringify({ version: 2, title: 'Demo', anchors: { refill: { file: 'src/tokens/tokenBucket.ts', range: [2, 4] } } }),
      '.sidestory/demo/sidestory.html': page(section('refill', widgetEl('tokens-chart.tsx'))),
      '.sidestory/demo/tokens-chart.tsx': "import { useAnchorCode } from 'explainer';\nexport default function W() { useAnchorCode('refill'); return null; }\n",
    });
    const r = await check(dir);
    expect(codes(r)).not.toContain('secret-file');
    expect(codes(r)).toContain('not-pinned');
  });

  it('--types writes the widget types and tsconfig into .sidestory, and says how to typecheck from a terminal', async () => {
    const dir = repoWith({
      'src/a.ts': CODE,
      '.sidestory/demo/manifest.json': manifest(ANCHORS),
      '.sidestory/demo/sidestory.html': page(section('refill', widgetEl('widgets/w.tsx'))),
      '.sidestory/demo/widgets/w.tsx': GOOD_WIDGET,
    });
    const out: string[] = [];
    const err: string[] = [];
    expect(await main([dir, '--types'], { out: (x) => out.push(x), err: (x) => err.push(x) }, compilerOpts, join(repo, 'src/widget-types'))).toBe(0);
    const explain = dirname(dir);
    expect(JSON.parse(readFileSync(join(explain, 'tsconfig.json'), 'utf8')).include[0]).toBe('.types/*.d.ts');
    expect(readFileSync(join(explain, '.types/explainer.d.ts'), 'utf8')).toBe(readFileSync(join(repo, 'src/widget-types/explainer.d.ts'), 'utf8'));
    expect(err.join('\n')).toContain('npx -y -p typescript tsc -p .sidestory');
    expect(out.join('\n')).toMatch(/1 widget checked/);
  });

  it('reports a missing sidestory.html', async () => {
    const r = await check(join(base, 'nowhere/.sidestory/demo'));
    expect(codes(r, 'error')).toEqual(['not-found']);
  });
});

describe('anchor drift (lost, out-of-date and changed code, as VS Code shows it)', () => {
  const fn = (k = '1', name = 'refill') => [`function ${name}(items, limit) {`, '  const out = [];', '  for (const item of items) {', '    if (out.length >= limit) break;', `    out.push(item * ${k});`, '  }', '  return out;', '}'];
  const ORIG = ['// header', 'import x from "y";', '', ...fn(), '', 'const tail = 1;', 'export { refill };', ''].join('\n');
  const STALE = ORIG.replace('  const out = [];\n  for (const item of items) {\n    if (out.length >= limit) break;', '  const out = items.slice(0, limit);\n  // rewritten\n  for (let i = 0; i < out.length; i++) {\n    out[i] = transform(out[i]);');
  const CHANGED = ORIG.replace('item * 1', 'item * 2 + offset').replace('const out = [];', 'const out = new Array();');
  const RANGE = { start: 4, end: 11 };
  const REANCHOR = 're-anchor it: set the anchor\'s "file" and "range" to the code, delete its "quote" and run --pin (or Re-anchor Section to Selection in VS Code)';
  const pinned = (extra: Record<string, unknown> = {}) => ({ file: 'src/a.ts', range: [RANGE.start, RANGE.end], quote: pinQuote(splitLines(ORIG), RANGE)!, ...extra });
  const drift = (r: CheckReport) => r.findings.filter((f) => f.code.startsWith('anchor-'));
  const sidestory = (code: string | undefined, anchors: Record<string, unknown> = { refill: pinned() }, html = page(Object.keys(anchors).map((id) => section(id, '<p>x</p>')).join('\n')), more: Record<string, string> = {}, top: Record<string, unknown> = {}) =>
    repoWith({
      ...(code === undefined ? {} : { 'src/a.ts': code }),
      '.sidestory/demo/manifest.json': JSON.stringify({ version: 3, title: 'Demo', ...top, anchors }, null, 2),
      '.sidestory/demo/sidestory.html': html,
      ...more,
    });
  const READS = "import { useAnchorCode } from 'explainer';\nexport default function W() { useAnchorCode('refill'); return null; }\n";
  const withWidget = (code: string | undefined, anchors?: Record<string, unknown>, top?: Record<string, unknown>) =>
    sidestory(code, anchors, page(section('refill', widgetEl('w.tsx'))), { '.sidestory/demo/w.tsx': READS }, top);

  it('code that is there or moved is fine; a small change is anchor-changed, an info, as VS Code says "Code changed"', async () => {
    const moved = ['// header', ...Array.from({ length: 30 }, (_, i) => `// pad ${i}`), 'import x from "y";', '', ...fn(), ''].join('\n');
    for (const code of [ORIG, moved]) expect((await check(sidestory(code))).findings).toEqual([]);
    const r = await check(sidestory(ORIG.replace('item * 1', 'item * 2')));
    expect(r.findings).toEqual([{ severity: 'info', file: expect.any(String), line: 5, code: 'anchor-changed', message: 'Step "refill" (anchor "refill"): the code in src/a.ts changed a little since it was pinned at lines 4–11 ("Code changed" in VS Code). If the prose still fits, run check.cjs .sidestory/demo --pin.' }]);
  });

  it('lost code is anchor-lost: which step, the file, the last pinned range and how to fix it', async () => {
    const dir = sidestory(['// header', 'import x from "y";', '', 'const tail = 1;', ''].join('\n'));
    const r = await check(dir);
    expect(drift(r)).toEqual([{
      severity: 'warning', file: join(dir, 'manifest.json'), line: 5, code: 'anchor-lost',
      message: `Step "refill" (anchor "refill"): its code isn't in src/a.ts any more (last pinned at lines 4–11). If it moved or was rewritten, ${REANCHOR}; if it was removed on purpose, remove the step.`,
    }]);
    expect(r.errors).toBe(0);
  });

  it('a missing file and a range past the end are lost; a link out of the repository or a folder is unchecked, as the sidebar counts it; a secret file is never read', async () => {
    const dir = sidestory(ORIG, { gone: pinned({ file: 'src/gone.ts' }), past: { file: 'src/a.ts', range: [50, 60] }, env: { file: 'src/.env', range: [50, 60] }, out: pinned({ file: 'src/out.ts' }), folder: pinned({ file: 'src' }) });
    const outside = join(base, `outside${n++}.ts`);
    writeFileSync(outside, ORIG);
    symlinkSync(outside, join(dir, '../../src/out.ts'));
    const by = Object.fromEntries(drift(await check(dir)).map((f) => [f.message.split(':')[0], f]));
    expect(Object.keys(by).sort()).toEqual(['Step "folder" (anchor "folder")', 'Step "gone" (anchor "gone")', 'Step "out" (anchor "out")', 'Step "past" (anchor "past")']);
    expect(by['Step "gone" (anchor "gone")']).toMatchObject({ code: 'anchor-lost', message: expect.stringContaining("src/gone.ts doesn't exist (last pinned at lines 4–11). If it moved") });
    expect(by['Step "past" (anchor "past")']).toMatchObject({ code: 'anchor-lost', message: expect.stringContaining('its range (lines 50–60) is past the end of src/a.ts (15 lines).') });
    expect(by['Step "out" (anchor "out")']).toMatchObject({ severity: 'info', code: 'anchor-unchecked', message: "Step \"out\" (anchor \"out\"): src/out.ts: file missing or outside the repository, so its code wasn't checked." });
    expect(by['Step "folder" (anchor "folder")']).toMatchObject({ severity: 'info', code: 'anchor-unchecked', message: expect.stringContaining('src: not a file, so') });
  });

  it('out-of-date code is anchor-stale: where it is now and the --accept command, which then re-pins it', async () => {
    const dir = sidestory(STALE, { refill: pinned(), other: pinned({ file: 'src/b.ts' }) }, undefined, { 'src/b.ts': CHANGED });
    const r = await check(dir);
    const [a, b] = drift(r);
    expect(a).toMatchObject({ severity: 'warning', code: 'anchor-stale' });
    expect(a!.message).toBe(`Step "refill" (anchor "refill"): the code in src/a.ts changed a lot since it was pinned at lines 4–11 ("Out of date" in VS Code); it is now at lines 4–12. Check the prose still fits, then run check.cjs .sidestory/demo --accept refill; if that isn't the code the step is about, ${REANCHOR}.`);
    // Changed past what --pin re-pins by itself, in place: no "now at".
    expect(b!.message).toBe(`Step "other" (anchor "other"): the code in src/b.ts changed since it was pinned at lines 4–11 ("Code changed" in VS Code, too much for --pin to re-pin by itself). Check the prose still fits, then run check.cjs .sidestory/demo --accept other; if that isn't the code the step is about, ${REANCHOR}.`);
    // --pin leaves them, without repeating them as pin-skipped; --accept re-pins them.
    const pinning = await check(dir, { pin: true });
    expect(pinning.pin!.skipped.map((s) => s.anchor)).toEqual(['refill', 'other']);
    expect(codes(pinning)).toEqual(['anchor-stale', 'anchor-stale']);
    expect((await check(dir, { accept: ['refill', 'other'] })).findings).toEqual([]);
  });

  it('pin-skipped stays for a reason anchor drift doesn\'t report, so --accept never fails silently', async () => {
    const dir = sidestory(ORIG, { blank: { file: 'src/a.ts', range: [3, 3] } });
    const r = await check(dir, { accept: ['blank'] });
    expect(r.findings.map((f) => [f.code, f.message])).toEqual([['pin-skipped', 'Not pinned: blank (lines blank or too long to quote).']]);
  });

  it('two equal copies: fine when unchanged, as VS Code shows it; when changed, out of date, and --accept can\'t pick one', async () => {
    const copies = (k: string) => ['// other', ...fn(k), '// middle', '// m', ...fn(k), '// end', ''].join('\n');
    expect((await check(sidestory(copies('1')))).findings).toEqual([]);
    const [f] = drift(await check(sidestory(copies('3'))));
    expect(f!.code).toBe('anchor-stale');
    expect(f!.message).toContain(`It matches more than one place about equally well, so --accept can't pick one: ${REANCHOR}.`);
  });

  it('an anchor that isn\'t a step is named as an anchor', async () => {
    const [f] = drift(await check(sidestory('', { refill: pinned() }, page('<p><a data-explain-ref="refill">x</a></p>'))));
    expect(f!.message).toMatch(/^Anchor "refill": its code isn't in src\/a\.ts any more .*; if it was removed on purpose, remove the anchor and what refers to it\.$/);
  });

  describe('base-side anchors', () => {
    const anchors = { refill: pinned({ side: 'base' }) };
    const branch = (t: BaseText) => ({ held: new Map(), baseText: async (f: string): Promise<BaseText> => (f === 'src/a.ts' ? t : { missing: true }) });
    const at = (dir: string, t: BaseText) => check(dir, { branch: branch(t) });

    it('are resolved against the merge-base when the check has it, else skipped; never against the working tree', async () => {
      const dir = sidestory(undefined, anchors, undefined, {}, { base: 'main' });
      expect(drift(await check(dir))).toEqual([]);
      expect(drift(await at(dir, { text: ORIG }))).toEqual([]);
      const lost = drift(await at(dir, { text: '// nothing here\n' }));
      expect(lost.map((f) => f.code)).toEqual(['anchor-lost']);
      expect(lost[0]!.message).toBe('Step "refill" (anchor "refill"): its code isn\'t in src/a.ts at the merge-base any more (last pinned at lines 4–11). If it moved or was rewritten, re-anchor it: set the anchor\'s "file" and "range" to the code as it is at the merge-base, delete its "quote" and run --pin; if it was removed on purpose, remove the step.');
      expect(drift(await at(dir, { missing: true }))[0]!.message).toContain("src/a.ts isn't a file at the merge-base (last pinned at lines 4–11)");
    });

    it('a merge-base blob too large to read is unchecked, not lost', async () => {
      const dir = sidestory(undefined, anchors, undefined, {}, { base: 'main' });
      expect(drift(await at(dir, { unchecked: 'too large to read' }))).toEqual([{ severity: 'info', file: join(dir, 'manifest.json'), line: 6, code: 'anchor-unchecked', message: 'Step "refill" (anchor "refill"): src/a.ts at the merge-base is too large to read, so its code wasn\'t checked.' }]);
    });

    it('one a widget reads keeps the widget\'s finding: widgets read the working tree', async () => {
      const dir = withWidget('// nothing here\n', anchors, { base: 'main' });
      const r = await at(dir, { text: ORIG });
      expect(codes(r).filter((c) => c !== 'missing-id')).toEqual(['lost']);
    });
  });

  describe('anchors a widget reads with useAnchorCode', () => {
    it('lost: one finding, the anchor\'s, which says widgets read it', async () => {
      const r = await check(withWidget('// nothing here\n'));
      expect(codes(r)).toEqual(['anchor-lost']);
      expect(r.findings[0]!.message).toMatch(/^Step "refill" \(anchor "refill"\): its code isn't in src\/a\.ts any more .* Widgets may read it \(useAnchorCode\)\.$/);
    });

    it('a missing file stays an error, as the widget\'s finding was: the check fails', async () => {
      const dir = withWidget(undefined);
      expect((await check(dir)).findings.map((f) => [f.severity, f.code])).toEqual([['error', 'anchor-lost']]);
      expect(await main([dir], { out: () => {}, err: () => {} }, compilerOpts)).toBe(1);
    });

    it('out of date: the --accept command carries --yes-widgets-may-read and asks for the user\'s go-ahead, and it works', async () => {
      const dir = withWidget(STALE);
      const r = await check(dir);
      expect(codes(r)).toEqual(['anchor-stale']);
      expect(r.findings[0]!.message).toContain("then run check.cjs .sidestory/demo --accept refill --yes-widgets-may-read, but only with the user's go-ahead (widgets can then read its code); if that isn't");
      const out: string[] = [];
      const io = { out: (s: string) => out.push(s), err: (s: string) => out.push(s) };
      expect(await main([dir, '--accept', 'refill'], io, compilerOpts)).toBe(0);
      expect(out.join('\n')).toContain('warning pin-needs-consent');
      out.length = 0;
      expect(await main([dir, '--accept', 'refill', '--yes-widgets-may-read'], io, compilerOpts)).toBe(0);
      expect(out.join('\n')).toContain('Pinned 1 anchor(s): refill');
      expect(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).anchors.refill.range).toEqual([4, 12]);
    });

    it('changed a little: the widget\'s changed finding, not also anchor-changed', async () => {
      const r = await check(withWidget(ORIG.replace('item * 1', 'item * 2')));
      expect(codes(r)).toEqual(['changed']);
    });

    it('changed a little but read only through a computed id: anchor-changed suggests --accept for that anchor, not a blanket --pin', async () => {
      const computed = "import { useAnchorCode } from 'explainer';\nexport default function W({ id }: { id: string }) { useAnchorCode(id); return null; }\n";
      const dir = sidestory(ORIG.replace('item * 1', 'item * 2'), undefined, page(section('refill', widgetEl('w.tsx'))), { '.sidestory/demo/w.tsx': computed });
      const f = (await check(dir)).findings.find((x) => x.code === 'anchor-changed')!;
      expect(f.message).toContain("If the prose still fits, run check.cjs .sidestory/demo --accept refill --yes-widgets-may-read, but only with the user's go-ahead");
    });
  });

  it('commands name the folder from the working directory, quoted when the shell needs it', async () => {
    const dir = repoWith({ 'pkg/src/a.ts': STALE, 'pkg/.sidestory/demo/manifest.json': JSON.stringify({ version: 2, title: 'Demo', anchors: { refill: pinned() } }), 'pkg/.sidestory/demo/sidestory.html': page(section('refill', '<p>x</p>')) });
    const root = join(dir, '../..');
    const nested = join(root, 'pkg/.sidestory/demo');
    const message = async (cwd: string) => (await check(nested, { cwd })).findings.find((f) => f.code === 'anchor-stale')!.message;
    expect(await message(root)).toContain('then run check.cjs pkg/.sidestory/demo --accept refill;');
    expect(await message(join(root, 'pkg'))).toContain('then run check.cjs .sidestory/demo --accept refill;');
    expect(await message(nested)).toContain('then run check.cjs . --accept refill;');
    expect(commandPath('/r', "/r/my pkg/.sidestory/it's")).toBe("'my pkg/.sidestory/it'\\''s'");
  });

  it('--json lists them like every other finding', async () => {
    const dir = sidestory('// nothing here\n');
    const out: string[] = [];
    expect(await main([dir, '--json'], { out: (s) => out.push(s), err: (s) => out.push(s) }, compilerOpts)).toBe(0);
    const r = JSON.parse(out.join('\n')) as CheckReport;
    expect(r.warnings).toBe(1);
    expect(r.findings).toEqual([{ severity: 'warning', file: join(dir, 'manifest.json'), line: 5, code: 'anchor-lost', message: expect.stringMatching(/^Step "refill" \(anchor "refill"\): its code isn't in src\/a\.ts any more/) }]);
  });
});

describe('outline, groups and detail links (docs/NAVIGATION-PLAN.md §5.3)', () => {
  it('reports the outline in --json: title, group, steps and details', async () => {
    const dir = repoWith({
      'src/a.ts': CODE,
      '.sidestory/demo/manifest.json': JSON.stringify({ version: 1, title: 'Demo', group: '  Storage ', anchors: ANCHORS }),
      '.sidestory/demo/sidestory.html': page(section('refill', '<p>Refills the buffer. More text.</p><a data-explain-detail="sib">x</a>') + '<section data-explain-anchor="other" data-explain-title="Other one"><p>y</p></section>'),
      '.sidestory/sib/manifest.json': manifest({}),
    });
    const r = await check(dir);
    expect(codes(r)).toEqual([]);
    const out: string[] = [];
    expect(await main([dir, '--json'], { out: (s) => out.push(s), err: () => {} }, compilerOpts)).toBe(0);
    const json = JSON.parse(out.join(''));
    expect(json).toMatchObject({ title: 'Demo', group: 'Storage', steps: [{ id: 'refill', title: 'refill' }, { id: 'other', title: 'Other one' }], details: ['sib'] });
    expect(json.sidestory).toBe(dir);
  });

  it('warns about a bad highlight value or anchor dim, on its line; a good one is quiet', async () => {
    const files = (highlight: unknown, dim: unknown) => ({
      'src/a.ts': CODE,
      '.sidestory/demo/manifest.json': JSON.stringify({ version: 1, title: 'Demo', highlight, anchors: { ...ANCHORS, refill: { ...ANCHORS.refill, dim } } }, null, 2),
      '.sidestory/demo/sidestory.html': page(section('refill', '<p>x</p>') + section('other', '<p>y</p>')),
    });
    const good = await check(repoWith(files({ dim: false, clickSeconds: 3, clickFrame: true, hoverPreview: 'both' }, true)));
    expect(good.findings.filter((f) => f.code === 'highlight')).toEqual([]);
    const r = await check(repoWith(files({ dim: 'no', clickSeconds: 1e6, glow: true }, 'yes')));
    const found = r.findings.filter((f) => f.code === 'highlight');
    expect(found.map((f) => [f.severity, f.message])).toEqual([
      ['warning', 'highlight: dim must be true or false; ignored.'],
      ['warning', 'highlight: clickSeconds is more than 3600; 3600 is used.'],
      ['warning', 'highlight: unknown key "glow" (known: dim, clickSeconds, clickFrame, hoverPreview); ignored.'],
      ['warning', 'Anchor "refill": dim: must be true or false; ignored.'],
    ]);
    expect(found[0]!.line).toBe(4);
    expect(found[3]!.line).toBeGreaterThan(4);
    expect(codes(r, 'error')).toEqual([]);
  });

  it('reports an invalid group as an error, and the manifest still loads', async () => {
    const dir = repoWith({
      'src/a.ts': CODE,
      '.sidestory/demo/manifest.json': JSON.stringify({ version: 1, title: 'Demo', group: 42, anchors: ANCHORS }),
      '.sidestory/demo/sidestory.html': page(section('refill', '<p>x</p>')),
    });
    const r = await check(dir);
    expect(codes(r, 'error')).toEqual(['group']);
    expect(r.title).toBe('Demo');
    expect(r.group).toBeUndefined();
    const long = repoWith({
      '.sidestory/demo/manifest.json': JSON.stringify({ version: 1, title: 'Demo', group: 'x'.repeat(61), anchors: {} }),
      '.sidestory/demo/sidestory.html': page('<p>x</p>'),
    });
    expect(codes(await check(long), 'error')).toEqual(['group']);
  });

  it('warns about detail links to missing or invalid siblings, and to itself, with their lines', async () => {
    const dir = repoWith({
      'src/a.ts': CODE,
      '.sidestory/demo/manifest.json': manifest(ANCHORS),
      '.sidestory/demo/sidestory.html': page(section('refill', '<a data-explain-detail="nope">a</a>\n<a data-explain-detail="../x">b</a>\n<a data-explain-detail="demo">c</a>\n<!-- <a data-explain-detail="hidden"> -->\n<a data-explain-detail="there">d</a>')),
      '.sidestory/there/manifest.json': manifest({}),
      // A folder without a manifest isn't a sidestory.
      '.sidestory/nope/readme.txt': 'x',
    });
    const r = await check(dir);
    const found = r.findings.filter((f) => f.code === 'unknown-detail' || f.code === 'detail-self').map((f) => `${f.line}:${f.code}`);
    expect(found).toEqual(['5:unknown-detail', '6:unknown-detail', '7:detail-self']);
    expect(r.details).toEqual(['nope', '../x', 'demo', 'there']);
  });
});

describe('links in the page (docs/AUTHORING-PLAN.md §2.3, §3.3, §8.1)', () => {
  const RTL = [
    'module ctrl (input logic clk, input logic go, output logic busy);',
    '  logic state_q;',
    '  // the flop',
    '  always_ff @(posedge clk) begin',
    '    state_q <= go;',
    '  end',
    '  assign busy = state_q;',
    'endmodule',
    '',
  ].join('\n');
  const find = (r: CheckReport, code: string) => r.findings.filter((f) => f.code === code);

  it('every page id is in the manifest and every manifest anchor is used, even without widgets', async () => {
    const dir = repoWith({
      'src/a.ts': CODE,
      '.sidestory/demo/manifest.json': manifest({ ...ANCHORS, spare: { file: 'src/a.ts', range: [1, 1] } }),
      '.sidestory/demo/sidestory.html': page([
        section('refill', '<a data-explain-ref="other">x</a> <a data-explain-ref="ghost">y</a>'),
        section('missing', '<p>no anchor for this section</p>'),
        '<svg data-explain-diagram role="group" aria-label="d"><g data-explain-on="other phantom"><text>a</text></g></svg>',
      ].join('\n')),
    });
    const r = await check(dir);
    const unknown = find(r, 'unknown-anchor').map((f) => f.message);
    expect(unknown).toHaveLength(3);
    expect(unknown.join('\n')).toMatch(/data-explain-ref="ghost"/);
    expect(unknown.join('\n')).toMatch(/data-explain-anchor="missing"/);
    expect(unknown.join('\n')).toMatch(/data-explain-on: no anchor "phantom"/);
    expect(find(r, 'never-on')).toMatchObject([{ severity: 'warning', message: expect.stringMatching(/"other" never becomes the current step/) }]);
    expect(find(r, 'unused-anchor')).toMatchObject([{ severity: 'warning', file: join(dir, 'manifest.json'), line: expect.any(Number), message: expect.stringMatching(/"spare"/) }]);
    expect(formatReport(r)).toMatch(/Checked: 0 error\(s\), \d+ warning\(s\); no widgets\.$/);
  });

  it('anchors a widget reads count as used; a computed id means unused anchors can\'t be told', async () => {
    const w = (body: string) => `import { reveal, useAnchorCode } from 'explainer';\nexport default function W() { ${body} return <p>x</p>; }\n`;
    const files = (code: string) => ({
      'src/a.ts': CODE,
      '.sidestory/demo/manifest.json': manifest(ANCHORS),
      '.sidestory/demo/sidestory.html': page(section('refill', widgetEl('w.tsx'))),
      '.sidestory/demo/w.tsx': code,
    });
    expect(find(await check(repoWith(files(w("useAnchorCode('other');")))), 'unused-anchor')).toHaveLength(0);
    expect(find(await check(repoWith(files(w('const id = String(Math.random()); reveal(id);')))), 'unused-anchor')).toHaveLength(0);
    expect(find(await check(repoWith(files(w('')))), 'unused-anchor').map((f) => f.message)).toEqual([expect.stringMatching(/"other"/)]);
  });

  it('links inside role="img" (once per image), unnamed links, links on controls and in widget fallbacks, ref and code together, empty diagrams', async () => {
    const dir = repoWith({
      'src/a.ts': CODE,
      '.sidestory/demo/manifest.json': manifest(ANCHORS),
      '.sidestory/demo/sidestory.html': page(section('refill', [
        '<svg role="img" aria-label="x"><g data-explain-ref="other"><text>a</text></g><g data-explain-ref="refill"><text>b</text></g></svg>',
        '<svg role="group" aria-label="y"><rect data-explain-ref="other"/><g data-explain-ref="other"><title>Named</title></g></svg>',
        '<button data-explain-ref="other">b</button>',
        '<span data-explain-ref="other" data-explain-code="src/a.ts">both</span>',
        '<figure data-explain-diagram><svg role="group" aria-label="z"><g data-explain-ref="other"><text>c</text></g></svg></figure>', // a code map: not empty
        '<figure data-explain-diagram><svg role="group" aria-label="w"><rect/></svg></figure>',
        '<p data-explain-on="other">alone</p>',
        widgetEl('w.tsx').replace('<p>Fallback text.</p>', '<p><a data-explain-ref="other">in fallback</a></p>'),
      ].join('\n'))),
      '.sidestory/demo/w.tsx': 'export default function W() { return <p>x</p>; }\n',
    });
    const r = await check(dir);
    expect(find(r, 'links-in-img')).toMatchObject([{ severity: 'warning', message: expect.stringMatching(/holds 2 links/) }]);
    expect(find(r, 'ref-no-name')).toMatchObject([{ severity: 'info', message: expect.stringMatching(/data-explain-ref="other" has no text/) }]);
    expect(find(r, 'link-on-control')).toHaveLength(1);
    expect(find(r, 'ref-and-code')).toMatchObject([{ severity: 'error' }]);
    expect(find(r, 'empty-diagram')).toHaveLength(1);
    expect(find(r, 'on-no-scope')).toMatchObject([{ severity: 'info' }]);
    expect(find(r, 'link-in-widget')).toMatchObject([{ severity: 'info', message: expect.stringMatching(/holds 1 link/) }]);
  });

  it('a net driven through an instance, or an instance path, names the child module\'s file', async () => {
    const dir = repoWith({
      'rtl/ctrl.sv': RTL,
      'rtl/top.sv': 'module top (input logic clk);\n  logic b;\n  ctrl u_c (\n    .clk,\n    .go(1\'b1),\n    .busy(b)\n  );\nendmodule\n',
      '.sidestory/demo/manifest.json': manifest({}),
      '.sidestory/demo/sidestory.html': page('<a data-explain-code="rtl/top.sv#driver(b)">b</a> <a data-explain-code="rtl/top.sv#u_c.state_q">q</a>'),
    });
    const r = await check(dir);
    const msgs = find(r, 'code-link-symbol').map((f) => f.message).join('\n');
    expect(msgs).toMatch(/it's driven in rtl\/ctrl.sv through u_c's .busy: link rtl\/ctrl.sv#driver\(busy\)/);
    expect(msgs).toMatch(/ctrl is in rtl\/ctrl.sv: link rtl\/ctrl.sv#state_q/);
  });

  it('data-explain-code: syntax, files, SV symbols and line ranges, with the inherited file', async () => {
    const dir = repoWith({
      'src/a.ts': CODE,
      'rtl/ctrl.sv': RTL,
      'config/secrets.json': '{}',
      '.sidestory/demo/manifest.json': manifest({ refill: ANCHORS.refill }),
      '.sidestory/demo/sidestory.html': page(section('refill', [
        '<figure data-explain-code-file="rtl/ctrl.sv">',
        '<a data-explain-code="#driver(state_q)">ok</a>',
        '<a data-explain-code="#state_q">ok</a>',
        '<a data-explain-code="#driver(nothing)">missing</a>',
        '<a data-explain-code="#driver(go)">an input</a>',
        '<a data-explain-code="#L4-L6">lines</a>',
        '<a data-explain-code="#L80">past the end</a>',
        '<a data-explain-code="#L0">bad</a>',
        '</figure>',
        '<a data-explain-code="#u_x">no file</a>',
        '<a data-explain-code="../outside.sv">outside</a>',
        '<a data-explain-code="rtl/nope.sv">missing file</a>',
        '<a data-explain-code="src/a.ts#refill">ts symbol</a>',
        '<a data-explain-code="config/secrets.json">secret</a>',
      ].join('\n'))),
    });
    const r = await check(dir);
    const msgs = (code: string) => find(r, code).map((f) => f.message);
    expect(msgs('code-link-syntax')).toHaveLength(3);
    expect(msgs('code-link-syntax').join('\n')).toMatch(/"#u_x" names no file/);
    expect(msgs('code-link-file')).toEqual([expect.stringMatching(/rtl\/nope.sv.*isn't a file inside the repository/)]);
    expect(msgs('code-link-symbol')).toHaveLength(2);
    expect(msgs('code-link-symbol').join('\n')).toMatch(/go is an input port: link `#go`/);
    expect(msgs('code-link-range')).toEqual([expect.stringMatching(/has 9 lines/)]);
    expect(msgs('code-link-lines')).toEqual([expect.stringMatching(/#driver\(state_q\) follows the code/)]);
    expect(msgs('symbol-unchecked')).toHaveLength(1);
    expect(msgs('code-link-secret')).toHaveLength(1);
    expect(r.errors).toBe(4);
  });
});


describe('--pin', () => {
  const files = (widget: string, anchors: Record<string, unknown> = { ...ANCHORS, env: { file: 'src/.env', range: [1, 1] } }) => ({
    'src/a.ts': CODE,
    'src/.env': 'TOKEN=1\n',
    '.sidestory/demo/manifest.json': manifest(anchors),
    '.sidestory/demo/sidestory.html': page(section('refill', widgetEl('w.tsx'))),
    '.sidestory/demo/w.tsx': widget,
  });
  const reads = (id: string) => `import { useAnchorCode } from 'explainer';\nexport default function W({ id }: { id: string }) { useAnchorCode(${id}); return null; }\n`;
  const pinned = (dir: string) => JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).anchors as Record<string, { quote?: { exact: string }; range: number[] }>;

  it('pins anchors widgets don\'t read, never secret files, and asks before pinning what widgets read', async () => {
    const dir = repoWith(files(reads("'refill'")));
    const r = await check(dir, { pin: true });
    expect(r.pin!.pinned.map((p) => p.anchor)).toEqual(['other']);
    expect(r.pin!.needsConsent).toEqual([{ anchor: 'refill', file: 'src/a.ts', range: { start: 2, end: 4 }, lines: 3 }]);
    expect(r.pin!.skipped.map((s) => s.anchor)).toEqual(['env']);
    const m = pinned(dir);
    expect(m.other!.quote!.exact).toBe('const x = 1;');
    expect(m.refill!.quote).toBeUndefined();
    expect(m.env!.quote).toBeUndefined();
    const msg = r.findings.find((f) => f.code === 'pin-needs-consent')!.message;
    expect(msg).toContain('src/a.ts lines 2–4 (3 lines, anchor refill)');
    expect(msg).toContain('--yes-widgets-may-read only if they agree');
    expect(codes(r)).toContain('not-pinned');

    const again = await check(dir, { pin: true, yesWidgetsMayRead: true });
    expect(again.pin!.pinned.map((p) => p.anchor)).toEqual(['refill']);
    expect(again.pin!.unchanged).toEqual(['other']);
    expect(again.pin!.widgetsMayRead).toEqual([{ anchor: 'refill', file: 'src/a.ts', range: { start: 2, end: 4 }, lines: 3 }]);
    expect(pinned(dir).refill!.quote!.exact).toBe('function refill() {\n  a = b;\n}');
    expect(codes(again)).toContain('unconfirmed');
    expect(codes(again)).not.toContain('not-pinned');
    expect(formatReport(again, dir)).toContain('Widgets in this sidestory may now read');
    // Pinning again changes nothing and needs no go-ahead.
    const third = await check(dir, { pin: true });
    expect(third.pin!.pinned).toEqual([]);
    expect(third.pin!.needsConsent).toEqual([]);
  });

  it('treats every anchor as read by widgets when an id is computed', async () => {
    const dir = repoWith(files(reads('id')));
    const r = await check(dir, { pin: true });
    expect(r.pin!.pinned).toEqual([]);
    expect(r.pin!.needsConsent.map((e) => e.anchor).sort()).toEqual(['other', 'refill']);
    expect(r.findings.find((f) => f.code === 'pin-needs-consent')!.message).toMatch(/may read any anchor/);
  });

  it('leaves anchors whose pinned code changed a lot, and keeps the manifest\'s formatting', async () => {
    const anchors = {
      refill: { file: 'src/a.ts', range: [2, 4], quote: { exact: 'function drain() {\n  q = r * s / t;\n}', prefix: '', suffix: '', norm: 'ws' } },
      other: { file: 'src/a.ts', range: [6, 6] },
    };
    const dir = repoWith(files("export default function W() { return null; }\n", anchors));
    const before = readFileSync(join(dir, 'manifest.json'), 'utf8');
    const r = await check(dir, { pin: true });
    expect(r.pin!.pinned.map((p) => p.anchor)).toEqual(['other']);
    expect(r.pin!.skipped.map((s) => s.anchor)).toEqual(['refill']);
    const after = readFileSync(join(dir, 'manifest.json'), 'utf8');
    expect(after.split('\n').slice(0, 4)).toEqual(before.replace('"version": 1', '"version": 2').split('\n').slice(0, 4));
  });
});

describe('main', () => {
  it('rejects bad arguments with exit code 2', async () => {
    const err: string[] = [];
    const io = { out: () => {}, err: (s: string) => err.push(s) };
    expect(await main([], io)).toBe(2);
    expect(await main(['a', 'b'], io)).toBe(2);
    expect(await main(['a', '--frobnicate'], io)).toBe(2);
    expect(await main(['a', '--yes-widgets-may-read'], io)).toBe(2);
    expect(err.join('\n')).toMatch(/only goes with --pin/);
  });
});

describe('the text report', () => {
  it('prints each finding on one line, without control characters from repository text', () => {
    const report: CheckReport = {
      sidestory: '/r/.sidestory/x',
      widgets: [],
      findings: [{ severity: 'error', file: '/r/.sidestory/x/manifest.json', line: 3, code: 'bad', message: 'name “a\u001b[31mred\u001b[0m”\nnext\u009bline\u0007' }],
      errors: 1,
      warnings: 0,
    };
    const first = formatReport(report, '/r').split('\n')[0]!;
    expect(first).toBe(join('.sidestory', 'x', 'manifest.json') + ':3: error bad: name “a[31mred[0m” nextline');
    expect(first).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });

  it('drops bidirectional overrides and isolates and line separators, from messages and file names', () => {
    const report: CheckReport = {
      sidestory: '/r/.sidestory/x',
      widgets: [],
      findings: [{ severity: 'warning', file: '/r/.sidestory/x/a\u202egnp.js\u2028b.ts', code: 'odd', message: 'name \u2066evil\u2069 \u202bx\u202c\u2029y' }],
      errors: 0,
      warnings: 1,
    };
    const first = formatReport(report, '/r').split('\n')[0]!;
    expect(first).toBe(join('.sidestory', 'x', 'agnp.js b.ts') + ': warning odd: name evil x y');
    expect(first).not.toMatch(/[\u202a-\u202e\u2066-\u2069\u2028\u2029]/);
  });
});

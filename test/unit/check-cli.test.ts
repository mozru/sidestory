// The standalone widget checker (src/cli/check-widgets.ts → dist/check.cjs), run in-process on temporary
// explainers with the real widget compiler (its worker from source, widget data generated once).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { anchorUses, checkExplainer, formatReport, main, type CheckReport } from '../../src/cli/check-widgets.ts';
import { matches, parseCss, parseSelector, placementProblems } from '../../src/cli/css.ts';
import { scanHtml } from '../../src/cli/html.ts';
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

async function check(dir: string, opts: { pin?: boolean; yesWidgetsMayRead?: boolean } = {}): Promise<CheckReport> {
  return checkExplainer(dir, { ...opts, compiler: compilerOpts });
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
    expect(codes(r).sort()).toEqual(['highlight-no-anchor', 'no-fallback', 'no-title', 'not-a-step']);
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
    expect(codes(r).sort()).toEqual(['changed', 'not-pinned', 'secret-file']);
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

// docs/WIDGETS.md and the widget type files (src/widget-types/): every ```tsx block in the guide is a complete
// widget that compiles with the real compiler and typechecks against the shipped types; the minimal example
// passes the standalone checker; the guide and the types name exactly what the runtime provides.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkExplainer } from '../../src/cli/check-widgets.ts';
import { WidgetCompiler } from '../../src/extension/widgets/compile.ts';
import { EXPLAINER_SDK_EXPORTS, UI_COMPONENT_EXPORTS, UI_COMPONENTS, UNAVAILABLE_IMPORTS, D3_MODULES } from '../../src/shared/widget-imports.ts';
import { WIDGET_TYPE_FILES, widgetTsconfig } from '../../src/widget-types/index.ts';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const guide = readFileSync(join(repo, 'docs/WIDGETS.md'), 'utf8');
const blocks = (lang: string) => [...guide.matchAll(new RegExp(`^\`\`\`${lang}\\n([\\s\\S]*?)^\`\`\`$`, 'gm'))].map((m) => m[1]!);
const tsx = blocks('tsx');
const typesDir = join(repo, 'src/widget-types');

let base = '';
let dataDir = '';
let compiler: WidgetCompiler;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'cx-guide-'));
  dataDir = join(base, 'widget-data');
  execFileSync(process.execPath, [join(repo, 'scripts/widget-data.ts'), dataDir], { cwd: repo });
  compiler = new WidgetCompiler({ workerFile: join(repo, 'src/extension/widgets/compile-worker.ts'), dataDir });
}, 60_000);

afterAll(() => {
  compiler?.dispose();
  rmSync(base, { recursive: true, force: true });
});

describe('docs/WIDGETS.md examples', () => {
  it('has the minimal example, three patterns and a gallery of five', () => {
    expect(tsx.length).toBe(9);
  });

  it('every tsx block compiles with no errors or warnings', async () => {
    const dir = join(base, 'compile');
    mkdirSync(dir, { recursive: true });
    for (const [i, code] of tsx.entries()) {
      writeFileSync(join(dir, `w${i}.tsx`), code);
      const r = await compiler.compile(dir, `w${i}.tsx`);
      expect({ block: i, errors: r.errors, warnings: r.warnings }).toEqual({ block: i, errors: [], warnings: [] });
      expect(r.modules[`w${i}.tsx`]).toBeTruthy();
    }
  });

  it('every tsx block typechecks against the widget types (Add Widget Types), and a typo does not', () => {
    const explain = join(base, 'types/.explain');
    mkdirSync(join(explain, '.types'), { recursive: true });
    mkdirSync(join(explain, 'demo/widgets'), { recursive: true });
    for (const f of WIDGET_TYPE_FILES) copyFileSync(join(typesDir, f), join(explain, '.types', f));
    writeFileSync(join(explain, 'tsconfig.json'), widgetTsconfig('.types'));
    const tsc = join(repo, 'node_modules/.bin/tsc');
    const run = () => {
      try {
        execFileSync(tsc, ['-p', explain, '--skipLibCheck', 'false'], { encoding: 'utf8' });
        return '';
      } catch (e) {
        return String((e as { stdout?: string }).stdout ?? e);
      }
    };
    tsx.forEach((code, i) => writeFileSync(join(explain, 'demo/widgets', `w${i}.tsx`), code));
    writeFileSync(join(explain, 'demo/widgets/imports.tsx'), [
      "import React, { useState } from 'react';",
      "import { scaleLinear } from 'd3-scale';",
      "import { AnimatePresence, motion } from 'framer-motion';",
      "import _ from 'lodash';",
      "import { Activity, ActivityIcon, LucideActivity, type LucideIcon } from 'lucide-react';",
      "import { useAnchors, useTheme, useVisible, asset, next, prev, goToStep, reveal } from 'explainer';",
      "import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';",
      "import url from './pic.png';",
      'export default function W() {',
      '  const [n] = useState(0); const icon: LucideIcon = Activity; const a = useAnchors(); const t = useTheme();',
      '  const s = scaleLinear().domain([0, 1]); const v: boolean = useVisible(); const p: Promise<boolean> = reveal("x");',
      '  return <Tabs defaultValue="a"><TabsList><TabsTrigger value="a">A</TabsTrigger></TabsList><TabsContent value="a">',
      '    <AnimatePresence><motion.div>{n}{_.sum([1])}{a[0]?.range?.start}{t.color("--chart-1")}{String(s(0))}{String(v)}</motion.div></AnimatePresence>',
      '    <img src={url || asset("pic.png")} alt="" /><ActivityIcon /><LucideActivity />{React.Children.count(null)}{String(Boolean(icon))}',
      '    <button onClick={() => { void next(); void prev(); void goToStep("y"); void p; }}>x</button></TabsContent></Tabs>;',
      '}',
    ].join('\n'));
    expect(run()).toBe('');
    writeFileSync(join(explain, 'demo/widgets/typo.tsx'), "import { Buton } from '@/components/ui/button';\nimport { Activty } from 'lucide-react';\nimport { useAnchorCod } from 'explainer';\nexport default function T() { useAnchorCod('x'); return <><Buton /><Activty /></>; }\n");
    const out = run();
    expect(out).toMatch(/typo\.tsx\(1,.*Buton/);
    expect(out).toMatch(/typo\.tsx\(2,.*Activty/);
    expect(out).toMatch(/typo\.tsx\(3,.*useAnchorCod/);
  }, 60_000);

  it("the README's example compiles", async () => {
    const readme = readFileSync(join(repo, 'README.md'), 'utf8');
    const code = /^```tsx\n([\s\S]*?)^```$/m.exec(readme)?.[1];
    expect(code).toBeTruthy();
    const dir = join(base, 'readme');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'w.tsx'), code!);
    const r = await compiler.compile(dir, 'w.tsx');
    expect([...r.errors, ...r.warnings]).toEqual([]);
  });

  it('the minimal example passes the checker', async () => {
    const root = join(base, 'minimal');
    const ex = join(root, '.explain/bit-reader');
    mkdirSync(join(ex, 'widgets'), { recursive: true });
    mkdirSync(join(root, 'rtl'), { recursive: true });
    const sample = join(repo, 'fixtures/sample-workspace');
    copyFileSync(join(sample, 'rtl/bit_reader.sv'), join(root, 'rtl/bit_reader.sv'));
    copyFileSync(join(sample, '.explain/bit-reader/manifest.json'), join(ex, 'manifest.json'));
    const section = blocks('html')[0]!;
    expect(section).toContain('<explain-widget src="widgets/refill.tsx"');
    writeFileSync(join(ex, 'explainer.html'), `<!doctype html>\n<section data-explain-anchor="state"><h2>State</h2></section>\n${section}`);
    writeFileSync(join(ex, 'widgets/refill.tsx'), tsx[0]!);
    const r = await checkExplainer(ex, { compiler: { workerFile: join(repo, 'src/extension/widgets/compile-worker.ts'), dataDir } });
    expect(r.findings.filter((f) => f.severity !== 'info')).toEqual([]);
    expect(r.widgets).toHaveLength(1);
  });

  it('names every SDK export, component, d3 module and unavailable import', () => {
    for (const name of EXPLAINER_SDK_EXPORTS) expect(guide, name).toMatch(new RegExp(`\`<?${name}\\b`));
    for (const c of UI_COMPONENTS) expect(guide, c).toMatch(new RegExp(`[\`/ ]${c}[\`,]`));
    for (const names of Object.values(UI_COMPONENT_EXPORTS)) for (const n of names) expect(guide, n).toContain(`\`${n}\``);
    for (const m of D3_MODULES) expect(guide, m).toContain(`\`${m}\``);
    for (const spec of Object.keys(UNAVAILABLE_IMPORTS)) expect(guide, spec).toContain(`\`${spec}\``);
    expect(guide).toContain('ls ~/.vscode*/extensions/*code-explainer*/dist/check.cjs');
    expect(guide).toContain('--yes-widgets-may-read');
  });
});

describe('widget types (src/widget-types)', () => {
  const read = (f: string) => readFileSync(join(typesDir, f), 'utf8');

  it('declare exactly the SDK and component exports the compiler allows', () => {
    const sdk = read('explainer.d.ts');
    const declared = [...sdk.matchAll(/^ {2}export (?:function|const) (\w+)/gm)].map((m) => m[1]!);
    expect([...new Set(declared)].sort()).toEqual([...EXPLAINER_SDK_EXPORTS].sort());
    const ui = read('ui.d.ts');
    for (const [component, names] of Object.entries(UI_COMPONENT_EXPORTS)) {
      const body = new RegExp(`declare module '@/components/ui/${component}' \\{([\\s\\S]*?)\\n\\}`).exec(ui)?.[1] ?? '';
      const found = [...body.matchAll(/(?:export const |, )(\w+):/g)].map((m) => m[1]!);
      expect(found.sort(), component).toEqual([...names].sort());
    }
  });

  it('declare only names React really exports', () => {
    const exports = JSON.parse(readFileSync(join(dataDir, 'exports.json'), 'utf8')) as Record<string, string[]>;
    const ns = /declare namespace __CxReact \{([\s\S]*?)\n\}/.exec(read('react.d.ts'))![1]!;
    const values = [...ns.matchAll(/^ {2}(?:function|const|class) (\w+)/gm)].map((m) => m[1]!);
    for (const v of values) expect(exports.react, v).toContain(v);
  });

  it('libraries.d.ts and lucide-react.d.ts are up to date, and all of it stays small', () => {
    execFileSync(process.execPath, [join(repo, 'scripts/widget-types.ts'), '--check'], { cwd: repo });
    const total = WIDGET_TYPE_FILES.reduce((n, f) => n + statSync(join(typesDir, f)).size, 0);
    expect(total).toBeLessThan(150_000);
  }, 60_000);
});

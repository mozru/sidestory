import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { relativize, WidgetCompiler, type CompileResult } from '../../src/extension/widgets/compile.ts';
import { orderLibraries, WidgetCompilerCore } from '../../src/extension/widgets/compile-core.ts';
import { SizeLru } from '../../src/extension/widgets/lru.ts';
import { isSecretFileName, isSecretPath } from '../../src/extension/widgets/secret-files.ts';
import { normalizeEntry, resolveRelative } from '../../src/extension/widgets/specifiers.ts';
import { suggest } from '../../src/extension/widgets/suggest.ts';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const workerFile = join(repo, 'src/extension/widgets/compile-worker.ts');

let base = '';
let dataDir = '';
let compiler: WidgetCompiler;
let n = 0;

/** A fresh explainer folder holding `files` (paths relative to it). */
function explainer(files: Record<string, string | Buffer>): string {
  const dir = join(base, `ex${n++}`);
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), content);
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

const WIDGET = 'export default function W() { return <div>hi</div>; }\n';

async function compileFiles(files: Record<string, string | Buffer>, src = 'w.tsx'): Promise<CompileResult> {
  return compiler.compile(explainer(files), src);
}

const codes = (r: CompileResult) => r.errors.map((e) => e.code);

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'cx-widgets-'));
  dataDir = join(base, 'widget-data');
  // A child process: the generator imports ~2,000 lucide icon modules, faster outside vitest's module runner.
  execFileSync(process.execPath, [join(repo, 'scripts/widget-data.ts'), dataDir], { cwd: repo });
  compiler = new WidgetCompiler({ workerFile, dataDir });
}, 60_000);

afterAll(() => {
  compiler?.dispose();
  rmSync(base, { recursive: true, force: true });
});

describe('compileWidget: a typical widget', () => {
  let r: CompileResult;
  beforeAll(async () => {
    r = await compileFiles(
      {
        'widgets/ring.tsx': [
          "import { motion } from 'framer-motion';",
          "import { scaleLinear } from 'd3-scale';",
          "import * as d3 from 'd3';",
          "import { Card, CardContent } from '@/components/ui/card';",
          "import { cn } from '@/lib/utils';",
          "import { Activity, XIcon, Edit } from 'lucide-react';",
          "import { LineChart, Line } from 'recharts';",
          "import { useWidgetState } from 'explainer';",
          "import data from './data.json';",
          "import pic from './pic.png';",
          "import { helper, type Opts } from './lib';",
          'export default function Ring({ depth = 8 }: { depth?: number }) {',
          "  const [wr] = useWidgetState('wr', 0);",
          '  const o: Opts = { k: 1 };',
          '  const x = scaleLinear().domain([0, depth])(wr) + d3.max([1, 2])!;',
          '  return (',
          '    <Card className={cn("p-2")}><CardContent>',
          '      <motion.div animate={{ x }} /><Activity /><XIcon /><Edit />',
          '      <LineChart data={data.points}><Line dataKey="y" /></LineChart>',
          '      <img src={pic} alt="" />{helper(o.k)}',
          '    </CardContent></Card>',
          '  );',
          '}',
        ].join('\n'),
        'widgets/data.json': '﻿{"points": [{"y": 1}], "__proto__": {"polluted": true}}',
        'widgets/pic.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        'widgets/lib/index.ts': "export interface Opts { k: number }\nexport { helper } from './helper';\n",
        'widgets/lib/helper.ts': 'export const helper = (k: number): number => k * 2;\n',
      },
      'widgets/ring.tsx',
    );
  });

  it('compiles without errors and lists the files it read', () => {
    expect(r.errors).toEqual([]);
    expect(r.entry).toBe('widgets/ring.tsx');
    expect(r.files).toEqual(['widgets/data.json', 'widgets/lib/helper.ts', 'widgets/lib/index.ts', 'widgets/pic.png', 'widgets/ring.tsx']);
    expect(Object.keys(r.modules).sort()).toEqual(r.files);
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rewrites aliases and relative imports to what the runtime registers', () => {
    const code = r.modules['widgets/ring.tsx']!;
    expect(code).toContain("require('motion/react')");
    expect(code).toContain("require('d3')");
    expect(code).not.toContain('framer-motion');
    expect(code).not.toContain('d3-scale');
    expect(code).toMatch(/require\(['"]widgets\/data\.json['"]\)/);
    expect(code).toMatch(/require\(['"]widgets\/lib\/index\.ts['"]\)/);
    expect(r.modules['widgets/lib/index.ts']).toMatch(/require\(['"]widgets\/lib\/helper\.ts['"]\)/);
    expect(code).toContain("require('react/jsx-runtime')");
  });

  it('keeps line numbers', () => {
    const lines = r.modules['widgets/ring.tsx']!.split('\n');
    expect(lines.findIndex((l) => l.includes('useWidgetState.call'))).toBe(12);
    expect(lines.findIndex((l) => l.includes('dataKey'))).toBe(18);
  });

  it('lists libraries in load order, ending with tailwind and runtime', () => {
    expect(r.libraries).toEqual(['react', 'clsx', 'ui', 'recharts', 'd3', 'motion', 'lucide', 'tailwind', 'runtime']);
  });

  it('sends only the lucide icons used, under the names imported', () => {
    expect(Object.keys(r.icons).sort()).toEqual(['Activity', 'Edit', 'XIcon']);
    expect(r.icons.Activity).toMatchObject({ name: 'activity', node: expect.any(Array) });
    expect(r.icons.Edit).toMatchObject({ name: 'square-pen' });
  });

  it('inlines JSON (parsed at run time, so __proto__ stays an own key) and images as data URLs', () => {
    const run = (code: string) => {
      const module = { exports: {} as unknown };
      new Function('module', 'exports', code)(module, module.exports);
      return module.exports;
    };
    const data = run(r.modules['widgets/data.json']!) as Record<string, unknown>;
    expect(data.points).toEqual([{ y: 1 }]);
    expect(Object.hasOwn(data, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(run(r.modules['widgets/pic.png']!)).toBe('data:image/png;base64,iVBORw==');
  });

  it('runs: the module graph links up through require', () => {
    const libs: Record<string, unknown> = {
      'react/jsx-runtime': { jsx: (t: unknown, p: unknown) => ({ t, p }), jsxs: (t: unknown, p: unknown) => ({ t, p }) },
    };
    const cache = new Map<string, unknown>();
    const req = (k: string): unknown => {
      if (k in libs) return libs[k];
      if (!cache.has(k)) {
        const module = { exports: {} as Record<string, unknown> };
        cache.set(k, module.exports);
        new Function('require', 'module', 'exports', r.modules[k]!)(req, module, module.exports);
        cache.set(k, module.exports);
      }
      return cache.get(k);
    };
    expect((req('widgets/lib/index.ts') as { helper: (k: number) => number }).helper(21)).toBe(42);
  });
});

describe('compileWidget: rejections', () => {
  it.each([
    ['/etc/w.tsx', 'bad-specifier'],
    ['file:///w.tsx', 'bad-specifier'],
    ['https://example.com/w.tsx', 'bad-specifier'],
    ['../w.tsx', 'outside-folder'],
    ['a/../../w.tsx', 'outside-folder'],
    ['w.tsx?x=1', 'bad-specifier'],
    ['w.tsx#x', 'bad-specifier'],
    ['a\\w.tsx', 'bad-specifier'],
    ['w\0.tsx', 'bad-specifier'],
    ['w.css', 'bad-extension'],
    ['w.json', 'bad-extension'],
    ['.git/w.tsx', 'bad-specifier'],
    ['missing.tsx', 'not-found'],
  ])('src %j → %s', async (src, code) => {
    const r = await compileFiles({ 'w.tsx': WIDGET, 'w.css': '', 'w.json': '{}' }, src);
    expect(codes(r)).toEqual([code]);
    expect(r.errors[0]!.file).toBe('sidestory.html');
    expect(r.modules).toEqual({});
  });

  it.each([
    ["'/etc/passwd'", 'bad-specifier'],
    ["'file:./x.ts'", 'bad-specifier'],
    ["'https://esm.sh/react'", 'bad-specifier'],
    ["'../../outside.ts'", 'outside-folder'],
    ["'./x.ts?raw'", 'bad-specifier'],
    ["'./x.ts#a'", 'bad-specifier'],
    ["'.\\\\x.ts'", 'bad-specifier'],
    ["'./x\\0.ts'", 'bad-specifier'],
    ["'./styles.css'", 'bad-extension'],
    ["'./data.csv'", 'bad-extension'],
    ["'./nope'", 'not-found'],
    ["'./secret-values.json'", 'secret-file'],
    ["'./api-token.json'", 'secret-file'],
    ["'./.env.json'", 'secret-file'],
    ["'node:fs'", 'bad-specifier'],
  ])('import %s → %s', async (spec, code) => {
    const r = await compileFiles({
      'w.tsx': `import x from ${spec};\nexport default function W() { return <div>{String(x)}</div>; }\n`,
      'x.ts': 'export default 1;',
      'styles.css': '',
      'data.csv': '',
      'secret-values.json': '{}',
      'api-token.json': '{}',
      '.env.json': '{}',
    });
    expect(codes(r)).toEqual([code]);
    expect(r.errors[0]).toMatchObject({ file: 'w.tsx', line: 1 });
  });

  it.skipIf(process.platform === 'win32')('refuses a FIFO (or anything but a regular file) without blocking on it', async () => {
    const dir = explainer({ 'w.tsx': "import x from './pipe.json';\nexport default function W() { return <div>{String(x)}</div>; }\n" });
    execFileSync('mkfifo', [join(dir, 'pipe.json')]);
    const r = await compiler.compile(dir, 'w.tsx');
    expect(r.errors.map((e) => e.code)).not.toContain('timeout');
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('refuses symlinks that lead outside the folder', async () => {
    const outside = join(base, 'outside.ts');
    writeFileSync(outside, 'export default 1;');
    const dir = explainer({ 'w.tsx': "import x from './link';\nexport default () => x;\n" });
    symlinkSync(outside, join(dir, 'link.ts'));
    const r = await compiler.compile(dir, 'w.tsx');
    expect(codes(r)).toEqual(['outside-folder']);
    expect(JSON.stringify(r)).not.toContain(base);
  });

  it('refuses an entry that is a symlink leading outside', async () => {
    writeFileSync(join(base, 'outside.tsx'), WIDGET);
    const dir = explainer({});
    symlinkSync(join(base, 'outside.tsx'), join(dir, 'w.tsx'));
    expect(codes(await compiler.compile(dir, 'w.tsx'))).toEqual(['outside-folder']);
  });

  it('refuses links to secret-looking files, judged by the real name', async () => {
    const dir = explainer({ 'w.tsx': "import x from './ok.json';\nexport default () => x;\n", 'credentials.json': '{}' });
    symlinkSync(join(dir, 'credentials.json'), join(dir, 'ok.json'));
    expect(codes(await compiler.compile(dir, 'w.tsx'))).toEqual(['secret-file']);
  });

  it('follows symlinks that stay inside', async () => {
    const dir = explainer({ 'w.tsx': "import x from './alias';\nexport default () => x;\n", 'real.ts': 'export default 1;' });
    symlinkSync(join(dir, 'real.ts'), join(dir, 'alias.ts'));
    expect((await compiler.compile(dir, 'w.tsx')).errors).toEqual([]);
  });

  it('caps the total size of code and data at 1 MB', async () => {
    const r = await compileFiles({ 'w.tsx': "import d from './big.json';\nexport default () => d;\n", 'big.json': JSON.stringify('x'.repeat(1_000_100)) });
    expect(codes(r)).toEqual(['too-large']);
  });

  it('caps images at 1 MB each', async () => {
    const r = await compileFiles({ 'w.tsx': "import p from './big.png';\nexport default () => p;\n", 'big.png': Buffer.alloc(1_000_001) });
    expect(codes(r)).toEqual(['too-large']);
    const ok = await compileFiles({ 'w.tsx': "import p from './ok.png';\nexport default () => p;\n", 'ok.png': Buffer.alloc(999_999) });
    expect(ok.errors).toEqual([]);
  });

  it('caps the number of files at 50', async () => {
    const files: Record<string, string> = { 'w.tsx': "import './m0';\nexport default () => null;\n" };
    for (let i = 0; i < 60; i++) files[`m${i}.ts`] = `import './m${i + 1}';\nexport {};\n`;
    files['m60.ts'] = 'export {};';
    expect(codes(await compileFiles(files))).toEqual(['too-many-files']);
  });
});

describe('compileWidget: imports and exports', () => {
  const one = (code: string, extra: Record<string, string> = {}) => compileFiles({ 'w.tsx': `${code}\nexport default function W() { return null; }\n`, ...extra });

  it('explains unavailable imports', async () => {
    for (const spec of ['three', 'd3-sankey', 'mathjs', '@radix-ui/react-slider', 'three/examples/jsm/controls/OrbitControls']) {
      const r = await one(`import * as x from '${spec}'; console.log(x);`);
      expect(codes(r), spec).toEqual(['unavailable-import']);
    }
  });

  it('suggests a close specifier for unknown imports', async () => {
    const r = await one("import { useState } from 'reacts'; console.log(useState);");
    expect(r.errors[0]).toMatchObject({ code: 'unknown-import', line: 1 });
    expect(r.errors[0]!.message).toContain("Did you mean 'react'");
    const ui = await one("import { Dialog } from '@/components/ui/dialog'; console.log(Dialog);");
    expect(ui.errors[0]!.code).toBe('unknown-import');
    const cards = await one("import { Card } from '@/components/ui/cards'; console.log(Card);");
    expect(cards.errors[0]!.message).toContain("Did you mean 'card'");
  });

  it('checks named imports against each library', async () => {
    const r = await one(
      [
        "import { LineChat } from 'recharts';",
        "import { useStat } from 'react';",
        "import d3 from 'd3';",
        "import { useWidgetStat } from 'explainer';",
        "import { CardBody } from '@/components/ui/card';",
        "import { twMerge, nope } from 'tailwind-merge';",
        'console.log(LineChat, useStat, d3, useWidgetStat, CardBody, twMerge, nope);',
      ].join('\n'),
    );
    expect(r.errors.map((e) => [e.code, e.line])).toEqual([
      ['unknown-export', 1],
      ['unknown-export', 2],
      ['unknown-export', 3],
      ['unknown-export', 4],
      ['unknown-export', 5],
      ['unknown-export', 6],
    ]);
    expect(r.errors[0]!.message).toContain("'LineChart'");
    expect(r.errors[1]!.message).toContain("'useState'");
    expect(r.errors[2]!.message).toContain('no default export');
    expect(r.errors[3]!.message).toContain("'useWidgetState'");
    expect(r.errors[0]!.column).toBe(10);
  });

  it('allows default imports where the library has one, and type-only names', async () => {
    const r = await one("import React, { type ReactNode } from 'react';\nimport _ from 'lodash';\nimport clsx from 'clsx';\nconst n: ReactNode = null;\nconsole.log(React, _, clsx, n);");
    expect(r.errors).toEqual([]);
  });

  it('rejects made-up lucide icons with suggestions, and namespace imports', async () => {
    const r = await one("import { Activty, TotallyMadeUpIcon } from 'lucide-react';\nconsole.log(Activty, TotallyMadeUpIcon);");
    expect(codes(r)).toEqual(['unknown-export', 'unknown-export']);
    expect(r.errors[0]!.message).toContain("'Activity'");
    expect(r.errors[1]!.message).toContain("no icon named 'TotallyMadeUpIcon'");
    const ns = await one("import * as Icons from 'lucide-react';\nconsole.log(Icons);");
    expect(codes(ns)).toEqual(['lucide-namespace']);
  });

  it('checks named imports between the widget\'s own files', async () => {
    const r = await one("import { helpr } from './util';\nconsole.log(helpr);", { 'util.ts': 'export function helper() {}\n' });
    expect(r.errors[0]).toMatchObject({ code: 'unknown-export', line: 1 });
    expect(r.errors[0]!.message).toContain("'helper'");
  });

  it('requires a default export from the widget file', async () => {
    const r = await compileFiles({ 'w.tsx': 'export function W() { return null; }\n' });
    expect(codes(r)).toEqual(['no-default-export']);
  });

  it('reports top-level await and dynamic import clearly', async () => {
    const r = await compileFiles({ 'w.tsx': "const x = 1;\nconst d = await Promise.resolve(1);\nexport default function W() { import('./x'); return d; }\n" });
    expect(r.errors.map((e) => [e.code, e.line])).toEqual([
      ['top-level-await', 2],
      ['dynamic-import', 3],
    ]);
    expect(r.errors[0]!.message).toMatch(/Top-level await/);
  });

  it('reports syntax errors with line and column', async () => {
    const r = await compileFiles({ 'w.tsx': 'export default function W() {\n  return <div>;\n}\n' });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ file: 'w.tsx', code: 'syntax', line: expect.any(Number), column: expect.any(Number) });
  });

  it('places errors Sucrase’s JSX transform raises without a position at the token it stopped on, not at 1:1', async () => {
    // "Unexpected token when processing JSX children" comes from Sucrase's transformer, which gives no position.
    const src = 'export default function A({x}:{x:number}){\n  retu-->rn (\n    <div className="p-2">\n      <ul>{[1,2].map((i)=><li key={i}>{i}</li>){}</ul>\n    </div>\n  );\n}\n';
    const r = await compileFiles({ 'w.tsx': src });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.message).toBe('Syntax error: Unexpected token when processing JSX children.');
    expect(r.errors[0]).toMatchObject({ line: 6, column: 4 });
  });
});

describe('compileWidget: artifact habits', () => {
  it('warns about each habit with its line', async () => {
    const src = [
      "import { ResponsiveContainer, LineChart } from 'recharts';",
      "import { reveal, goToStep, useStep } from 'explainer';",
      "import { useEffect } from 'react';",
      'export default function W() {',
      '  const step = useStep();',
      "  useEffect(() => { reveal('a'); }, []);",
      "  setTimeout(() => step.next(), 10);",
      "  const go = async () => { await 1; goToStep('b'); };",
      "  const ok = () => reveal('c');",
      '  const h = window.innerHeight;',
      "  localStorage.setItem('k', 'v');",
      "  fetch('/x');",
      "  const u = 'https://example.com/a.png';",
      "  const c = 'hsl(var(--primary))';",
      '  return <div className="min-h-screen bg-opacity-50">',
      '    <input autoFocus />',
      '    <ResponsiveContainer width="100%" height="100%"><LineChart /></ResponsiveContainer>',
      '    <svg xmlns="http://www.w3.org/2000/svg" />',
      '  </div>;',
      '}',
    ].join('\n');
    const r = await compileFiles({ 'w.tsx': src });
    expect(r.errors).toEqual([]);
    expect(r.warnings.map((w) => [w.code, w.line]).sort((a, b) => (a[1] as number) - (b[1] as number))).toEqual([
      ['needs-click', 6],
      ['needs-click', 7],
      ['needs-click', 8],
      ['inner-height', 10],
      ['storage', 11],
      ['network', 12],
      ['remote-url', 13],
      ['hsl-var', 14],
      ['full-height', 15],
      ['tw3-opacity', 15],
      ['autofocus', 16],
      ['responsive-height', 17],
    ]);
    expect(r.modules['w.tsx']).not.toMatch(/autoFocus/);
    expect(r.modules['w.tsx']).toContain('"data-cx-autofocus": true');
  });
});

describe('compileWidget: hashing, worker limits and caching', () => {
  it('hash covers the whole import closure', async () => {
    const dir = explainer({ 'w.tsx': "import { a } from './a';\nexport default () => a;\n", 'a.ts': "export { b as a } from './b';\n", 'b.ts': 'export const b = 1;\n' });
    const first = await compiler.compile(dir, 'w.tsx');
    expect(first.errors).toEqual([]);
    expect((await compiler.compile(dir, 'w.tsx')).hash).toBe(first.hash);
    writeFileSync(join(dir, 'b.ts'), 'export const b = 2;\n');
    const second = await compiler.compile(dir, 'w.tsx');
    expect(second.hash).not.toBe(first.hash);
    expect(second.modules['b.ts']).toContain('2');
  });

  it('times out on pathological input, replaces the worker, and keeps working', async () => {
    const c = new WidgetCompiler({ workerFile, dataDir });
    try {
      // ~900 KB of nested expressions: legal, but far too slow for the limit used here.
      const big = `export default () => [${'[1,2,(3+4)*5,{a:[6]}],'.repeat(40_000)}];\n`;
      const dir = explainer({ 'w.tsx': big, 'ok.tsx': WIDGET });
      const t = await c.compile(dir, 'w.tsx', { timeoutMs: 30 });
      expect(codes(t)).toEqual(['timeout']);
      expect(t.errors[0]!.file).toBe('w.tsx');
      const ok = await c.compile(dir, 'ok.tsx');
      expect(ok.errors).toEqual([]);
      expect(c.workersStarted).toBe(2);
    } finally {
      c.dispose();
    }
  });

  it('survives deeply nested input', async () => {
    const deep = `export default () => ${'['.repeat(100_000)}${']'.repeat(100_000)};\n`;
    const dir = explainer({ 'w.tsx': deep, 'ok.tsx': WIDGET });
    const r = await compiler.compile(dir, 'w.tsx');
    expect(r.errors).toHaveLength(1);
    expect(['too-complex', 'syntax', 'timeout', 'crashed']).toContain(r.errors[0]!.code);
    expect((await compiler.compile(dir, 'ok.tsx')).errors).toEqual([]);
  });

  it('queues concurrent compiles', async () => {
    const dir = explainer({ 'a.tsx': WIDGET, 'b.tsx': WIDGET.replace('hi', 'yo') });
    const [a, b] = await Promise.all([compiler.compile(dir, 'a.tsx'), compiler.compile(dir, 'b.tsx')]);
    expect(a.entry).toBe('a.tsx');
    expect(b.modules['b.tsx']).toContain('yo');
  });

  it('caches transformed modules, bounded by size', async () => {
    const core = new WidgetCompilerCore({ dataDir, cacheBytes: 40_000 });
    const dir = explainer({ 'w.tsx': WIDGET, 'v.tsx': `${WIDGET}// ${'x'.repeat(30_000)}\n` });
    const first = await core.compile(dir, 'w.tsx');
    const count = core.cache.count;
    expect(count).toBeGreaterThan(0);
    const again = await core.compile(dir, 'w.tsx');
    expect(again).toEqual(first);
    expect(core.cache.count).toBe(count);
    await core.compile(dir, 'v.tsx');
    expect(core.cache.size).toBeLessThanOrEqual(40_000);
  });
});

describe('widget compiler helpers', () => {
  it('worker failure messages carry no absolute paths', () => {
    const dir = join(tmpdir(), 'repo', '.sidestory', 'x');
    expect(relativize(`Cannot read ${join(dir, 'w', 'a.tsx')} at ${join(tmpdir(), 'node_modules', 'sucrase', 'dist', 'index.js')}:1:2`, dir)).toBe(`Cannot read w${process.platform === 'win32' ? '\\' : '/'}a.tsx at …/index.js:1:2`);
  });

  it('SizeLru evicts least recently used entries past its bound', () => {
    const lru = new SizeLru<string>(10);
    lru.set('a', 'a', 4);
    lru.set('b', 'b', 4);
    lru.get('a');
    lru.set('c', 'c', 4);
    expect(lru.get('b')).toBeUndefined();
    expect(lru.get('a')).toBe('a');
    expect(lru.size).toBe(8);
    lru.set('huge', 'h', 11);
    expect(lru.get('huge')).toBeUndefined();
  });

  it('orders libraries with dependencies first', () => {
    expect(orderLibraries([])).toEqual(['react', 'motion', 'tailwind', 'runtime']);
    expect(orderLibraries(['lodash', 'ui'])).toEqual(['react', 'clsx', 'ui', 'lodash', 'motion', 'tailwind', 'runtime']);
  });

  it('matches secret-looking names case-insensitively', () => {
    for (const n of [
      '.env', '.env.local', '.envrc', 'tokens.json', 'Credentials.json', 'credentials', 'db-password.txt', 'API_KEY.yaml', 'apikey.env', 'client_secret.xml',
      'a.pem', 'b.KEY', 'x.p12', 'settings.local.json', 'appsettings.Production.json', 'kubeconfig', 'my-kubeconfig.yaml', '.npmrc', 'id_rsa', 'id_ed25519.pub', '.git-credentials',
    ]) {
      expect(isSecretFileName(n), n).toBe(true);
    }
    // Source files are never secret by name, nor are id_ names that aren't SSH keys.
    for (const n of ['ring.tsx', 'data.json', 'keyboard.ts', 'environment.ts', 'monkey.png', 'tokenBucket.ts', 'tokens-chart.tsx', 'tokenizer.py', 'secretary.ts', 'password_reset.go', 'id_utils.ts', 'id_rsa.png', 'credentials.sv', 'design-tokens.ts']) {
      expect(isSecretFileName(n), n).toBe(false);
    }
  });

  it('judges a path by its file name only: folders named like secrets hold ordinary code', () => {
    expect(isSecretPath('src/tokens/lexer.ts')).toBe(false);
    expect(isSecretPath('secrets/README.md')).toBe(false);
    expect(isSecretPath('config/secrets.yaml')).toBe(true);
    expect(isSecretPath('deploy/.env.production')).toBe(true);
  });

  it('compiles widgets and imports named like tokens or under a tokens/ folder (ordinary code)', async () => {
    const r = await compileFiles({
      'tokens-chart.tsx': "import { take } from './tokens/tokenBucket';\nexport default function W() { return <div>{take()}</div>; }\n",
      'tokens/tokenBucket.ts': 'export const take = () => 1;\n',
    }, 'tokens-chart.tsx');
    expect(r.errors).toEqual([]);
  });

  it('normalizes and resolves paths lexically', () => {
    expect(normalizeEntry('./widgets/./ring.tsx')).toEqual({ ok: true, key: 'widgets/ring.tsx' });
    expect(resolveRelative('widgets/ring.tsx', '../data/x.json')).toEqual({ ok: true, key: 'data/x.json' });
    expect(resolveRelative('widgets/ring.tsx', '../../x.json')).toMatchObject({ ok: false, code: 'outside-folder' });
    expect(resolveRelative('w.tsx', './lib/')).toEqual({ ok: true, key: 'lib/' });
  });

  it('suggests close names', () => {
    expect(suggest('LineChat', ['LineChart', 'BarChart', 'Line'])[0]).toBe('LineChart');
    expect(suggest('usestate', ['useState', 'useEffect'])[0]).toBe('useState');
    expect(suggest('zzzzzz', ['useState'])).toEqual([]);
  });
});

describe('compileWidget: artifact habits that break in a panel (user testing)', () => {
  it('warns about a page background on the root, palette text, wide fixed widths, hex colors, icon-only buttons and bad highlight/reveal arguments', async () => {
    const src = [
      "import { Line, LineChart } from 'recharts';",
      "import { Play, Pause } from 'lucide-react';",
      "import { Button } from '@/components/ui/button';",
      "import { highlight, reveal } from 'explainer';",
      'export default function W() {',
      '  return <div className="min-h-0 bg-white dark:bg-slate-950 p-4">',
      '    <h2 className="text-gray-900">Title</h2>',
      '    <div className="w-[480px]">card</div>',
      '    <LineChart><Line stroke="#ef4444" dataKey="y" /></LineChart>',
      '    <Button onClick={() => highlight(0)}><Play /></Button>',
      "    <button onClick={() => reveal('a', { highlight: true })}><Pause /></button>",
      "    <button onClick={() => reveal('a', { lines: [1.5, 2] })}>x</button>",
      '  </div>;',
      '}',
    ].join('\n');
    const r = await compileFiles({ 'w.tsx': src });
    expect(r.errors).toEqual([]);
    expect(r.warnings.map((w) => [w.code, w.line]).sort((a, b) => (a[1] as number) - (b[1] as number) || String(a[0]).localeCompare(String(b[0])))).toEqual([
      ['page-background', 6],
      ['palette-text', 7],
      ['fixed-width', 8],
      ['hex-color', 9],
      ['highlight-lines', 10],
      ['icon-button-label', 10],
      ['icon-button-label', 11],
      ['reveal-highlight', 11],
      ['reveal-lines', 12],
    ]);
  });

  it('says nothing about the same habits done right', async () => {
    const src = [
      "import { Line, LineChart, ResponsiveContainer } from 'recharts';",
      "import { Play } from 'lucide-react';",
      "import { Button } from '@/components/ui/button';",
      "import { highlight, reveal } from 'explainer';",
      'function Inner() { return <div className="bg-white text-black">swatch</div>; }',
      'export default function W() {',
      '  return <div className="flex flex-col gap-2">',
      '    <h2 className="text-gray-900 dark:text-gray-100">Title</h2>',
      '    <div className="w-full max-w-[480px]">card</div>',
      '    <div className="overflow-x-auto"><div className="min-w-[560px] w-[300px]">wave</div></div>',
      '    <div className="h-64"><ResponsiveContainer width="100%" height="100%"><LineChart><Line stroke="var(--chart-1)" dataKey="y" /></LineChart></ResponsiveContainer></div>',
      '    <Button aria-label="Play" onClick={() => highlight([2, 3])}><Play /></Button>',
      "    <button onClick={() => reveal('a', { lines: 4, highlight: ['wr'] })}>show <Play /></button>",
      '    <Inner />',
      '  </div>;',
      '}',
    ].join('\n');
    const r = await compileFiles({ 'w.tsx': src });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });
});

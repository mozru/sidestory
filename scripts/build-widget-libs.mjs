// Builds the widget libraries (dist/widget-libs/<id>.js): one minified production IIFE per library id in
// src/shared/widget-imports.ts, each registering its modules on globalThis.__cxLibs. Imports a library gets
// from one of its `deps` (React, above all: React 19 has no UMD build) are mapped to the registry instead
// of being bundled again. Fails if any output contains eval or new Function (the frame's CSP forbids
// them, and widgets must not get a way around that). docs/WIDGETS-PLAN.md §3 "Libraries".
// Usage: node scripts/build-widget-libs.mjs [--quiet]
import * as esbuild from 'esbuild';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { WIDGET_LIBRARIES } from '../src/shared/widget-imports.ts';

const OUT = 'dist/widget-libs';
const ENTRIES = {
  react: 'src/widget-runtime/libs/react.cjs',
  clsx: 'src/widget-runtime/libs/clsx.js',
  ui: 'src/widget-runtime/ui/index.ts',
  recharts: 'src/widget-runtime/libs/recharts.ts',
  d3: 'src/widget-runtime/libs/d3.js',
  motion: 'src/widget-runtime/libs/motion.js',
  lucide: 'src/widget-runtime/libs/lucide.js',
  lodash: 'src/widget-runtime/libs/lodash.js',
  tailwind: 'src/widget-runtime/libs/tailwind.js',
  runtime: 'src/widget-runtime/runtime/index.ts',
};

const byId = new Map(WIDGET_LIBRARIES.map((l) => [l.id, l]));

/** Maps imports provided by a library's deps to `globalThis.__cxLibs[specifier]`. */
function registryPlugin(lib) {
  const provided = new Map();
  for (const dep of lib.deps) for (const s of byId.get(dep).specifiers) provided.set(s, dep);
  const roots = new Set([...provided.keys()].map((s) => s.split('/')[0]));
  return {
    name: 'cx-registry',
    setup(build) {
      build.onResolve({ filter: /^[^./]/ }, (args) => {
        const spec = args.path;
        if (provided.has(spec)) return { path: spec, namespace: 'cx-registry' };
        // A subpath of a provided package that isn't itself provided (e.g. react/jsx-dev-runtime) would
        // silently bundle a second copy of React: refuse.
        if (roots.has(spec.split('/')[0]) && !spec.startsWith('lucide-react/')) {
          return { errors: [{ text: `${lib.id}: '${spec}' isn't provided by its deps (${lib.deps.join(', ')})` }] };
        }
        return undefined;
      });
      build.onLoad({ filter: /.*/, namespace: 'cx-registry' }, (args) => ({
        contents: `var m = globalThis.__cxLibs && globalThis.__cxLibs[${JSON.stringify(args.path)}];
if (!m) throw new Error(${JSON.stringify(`widget library '${lib.id}' needs '${args.path}' (library '${provided.get(args.path)}') loaded first`)});
module.exports = m;`,
        loader: 'js',
      }));
    },
  };
}

/**
 * Rewrites the few eval-like spots in the libraries: global-object fallbacks (`Function('return this')()`,
 * never reached in a browser, but they'd fail the check) and d3-dsv's row converter (`new Function`, which
 * the CSP would block, breaking d3.csvParse).
 */
const noEvalPlugin = {
  name: 'cx-no-eval',
  setup(build) {
    build.onLoad({ filter: /[\\/]node_modules[\\/].*\.(m?js|cjs)$/ }, (args) => {
      let text = readFileSync(args.path, 'utf8');
      const before = text;
      text = text.replace(/\bFunction\(\s*(['"])return this\1\s*\)\(\)/g, 'globalThis');
      if (/[\\/]d3-dsv[\\/]src[\\/]dsv\.js$/.test(args.path)) {
        text = text.replace(/function objectConverter\(columns\) \{[\s\S]*?\n\}\n/, `function objectConverter(columns) {
  return function(d) {
    var o = {};
    for (var i = 0; i < columns.length; ++i) Object.defineProperty(o, columns[i], { value: d[i] || "", writable: true, enumerable: true, configurable: true });
    return o;
  };
}
`);
        if (text.includes('new Function')) throw new Error('d3-dsv: objectConverter changed upstream; update the rewrite in build-widget-libs.mjs');
      }
      return text === before ? undefined : { contents: text, loader: 'js' };
    });
  },
};

const FORBIDDEN = [/\beval\s*\(/, /\bnew\s+Function\s*\(/, /\bFunction\s*\(\s*["'`]/];

export async function buildWidgetLibs({ quiet = false } = {}) {
  mkdirSync(OUT, { recursive: true });
  const ids = WIDGET_LIBRARIES.map((l) => l.id);
  const missing = ids.filter((id) => !ENTRIES[id]);
  if (missing.length) throw new Error(`no entry for widget libraries: ${missing.join(', ')}`);
  await Promise.all(WIDGET_LIBRARIES.map((lib) => esbuild.build({
    entryPoints: [ENTRIES[lib.id]],
    outfile: `${OUT}/${lib.id}.js`,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.css': 'text' },
    inject: ['src/widget-runtime/prelude.ts'],
    plugins: [registryPlugin(lib), noEvalPlugin],
    logLevel: 'warning',
  })));

  const sizes = {};
  const problems = [];
  for (const id of ids) {
    const file = `${OUT}/${id}.js`;
    const text = readFileSync(file, 'utf8');
    for (const re of FORBIDDEN) {
      const m = re.exec(text);
      if (m) problems.push(`${file}: contains ${JSON.stringify(text.slice(Math.max(0, m.index - 40), m.index + 40))}`);
    }
    sizes[id] = { bytes: statSync(file).size, gzip: gzipSync(text).length };
  }
  if (problems.length) throw new Error(`widget libraries must not use eval/new Function:\n${problems.join('\n')}`);
  if (!quiet) {
    const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
    let total = 0;
    for (const [id, s] of Object.entries(sizes)) { total += s.bytes; console.log(`  widget-libs/${id}.js  ${kb(s.bytes)} (gzip ${kb(s.gzip)})`); }
    console.log(`  widget-libs total  ${kb(total)}`);
  }
  return sizes;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildWidgetLibs({ quiet: process.argv.includes('--quiet') });
}

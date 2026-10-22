// Bundles the extension host code and the webview script, and copies codicons.
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { buildWidgetLibs } from './build-widget-libs.mjs';
import { generateWidgetData } from './widget-data.ts';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const common = { bundle: true, sourcemap: !production, minify: production, logLevel: 'info', target: 'es2022' };

const builds = [
  { ...common, entryPoints: ['src/extension/extension.ts'], outfile: 'dist/extension.cjs', platform: 'node', format: 'cjs', external: ['vscode'],
    // ESM first: jsonc-parser's UMD build loads its parts with a require() esbuild can't follow.
    mainFields: ['module', 'main'] },
  // content.css is bundled into the script as text: the sandboxed content frame isn't served by the
  // webview's resource loader, so it can't fetch stylesheets itself.
  { ...common, entryPoints: ['src/webview/main.ts'], outfile: 'dist/webview/main.js', platform: 'browser', format: 'esm', loader: { '.css': 'text' } },
  { ...common, entryPoints: ['src/webview/main.css'], outfile: 'dist/webview/main.css' },
  // The widget compiler's worker (Sucrase, acorn); widget code is compiled there, never in the host thread.
  { ...common, entryPoints: ['src/extension/widgets/compile-worker.ts'], outfile: 'dist/compile-worker.cjs', platform: 'node', format: 'cjs' },
];

if (production) rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/webview/codicons', { recursive: true });
for (const f of ['codicon.css', 'codicon.ttf']) {
  cpSync(`node_modules/@vscode/codicons/dist/${f}`, `dist/webview/codicons/${f}`);
}

if (watch) {
  for (const b of builds) await (await esbuild.context(b)).watch();
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}

// Export lists and lucide icon data the widget compiler checks imports against (dist/widget-data/).
await generateWidgetData('dist/widget-data');

// Widget libraries (dist/widget-libs/): rebuilt only by a full build, not on watch changes.
await buildWidgetLibs();

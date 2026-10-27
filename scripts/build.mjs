// Bundles the extension host code and the webview script, and copies codicons.
import * as esbuild from 'esbuild';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { WIDGET_BOOTSTRAP } from '../src/shared/widget-bootstrap.ts';
import { WIDGET_TYPE_FILES } from '../src/widget-types/index.ts';
import { buildWidgetLibs } from './build-widget-libs.mjs';
import { generateWidgetData } from './widget-data.ts';
import { mcpServerBuild } from './mcp-build.mjs';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const common = { bundle: true, sourcemap: !production, minify: production, logLevel: 'info', target: 'es2022' };

const builds = [
  // The bootstrap (docs/NAVIGATION-PLAN.md §8.1): what runs in every workspace; it requires full.cjs on demand.
  { ...common, entryPoints: ['src/extension/bootstrap.ts'], outfile: 'dist/extension.cjs', platform: 'node', format: 'cjs', external: ['vscode', './full.cjs'] },
  { ...common, entryPoints: ['src/extension/extension.ts'], outfile: 'dist/full.cjs', platform: 'node', format: 'cjs', external: ['vscode'],
    // ESM first: jsonc-parser's UMD build loads its parts with a require() esbuild can't follow.
    mainFields: ['module', 'main'] },
  // content.css is bundled into the script as text: the sandboxed content frame isn't served by the
  // webview's resource loader, so it can't fetch stylesheets itself.
  // The widget frame's CSP names the bootstrap by hash; computed here so the srcdoc is a constant.
  // metafile: checked below for classic zod, which must stay out of the panel (zod/mini only).
  { ...common, entryPoints: ['src/webview/main.ts'], outfile: 'dist/webview/main.js', platform: 'browser', format: 'esm', loader: { '.css': 'text' }, metafile: true,
    define: { __CX_BOOTSTRAP_HASH__: JSON.stringify(`sha256-${createHash('sha256').update(WIDGET_BOOTSTRAP, 'utf8').digest('base64')}`) } },
  { ...common, entryPoints: ['src/webview/main.css'], outfile: 'dist/webview/main.css' },
  // The widget compiler's worker (Sucrase, acorn); widget code is compiled there, never in the host thread.
  { ...common, entryPoints: ['src/extension/widgets/compile-worker.ts'], outfile: 'dist/compile-worker.cjs', platform: 'node', format: 'cjs' },
  // The code block highlighter's worker (vscode-textmate, vscode-oniguruma's JS); grammars come from the installed
  // extensions and onig.wasm from VS Code itself (docs/HIGHLIGHT-PLAN.md §10), so neither is in dist/.
  { ...common, entryPoints: ['src/extension/highlight/worker.ts'], outfile: 'dist/highlight-worker.cjs', platform: 'node', format: 'cjs', mainFields: ['module', 'main'] },
  // The standalone widget checker (node dist/check.cjs <sidestory-dir>); uses the worker and widget-data beside it.
  { ...common, entryPoints: ['src/cli/check-widgets.ts'], outfile: 'dist/check.cjs', platform: 'node', format: 'cjs', mainFields: ['module', 'main'] },
  // The comments MCP server for other agents (docs/COMMENTS-PLAN.md §10.2); the same bundle as the plugin's.
  mcpServerBuild('dist/mcp.cjs', common),
];

if (production) rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/webview/codicons', { recursive: true });
for (const f of ['codicon.css', 'codicon.ttf']) {
  cpSync(`node_modules/@vscode/codicons/dist/${f}`, `dist/webview/codicons/${f}`);
}
// The declaration files "Add Widget Types" and `check.cjs --types` write for widget authors.
mkdirSync('dist/widget-types', { recursive: true });
for (const f of WIDGET_TYPE_FILES) cpSync(`src/widget-types/${f}`, `dist/widget-types/${f}`);

if (watch) {
  for (const b of builds) await (await esbuild.context(b)).watch();
} else {
  const results = await Promise.all(builds.map((b) => esbuild.build(b)));
  const panel = results[builds.findIndex((b) => b.outfile === 'dist/webview/main.js')];
  const panelInputs = Object.entries(panel.metafile.outputs['dist/webview/main.js'].inputs).filter(([, i]) => i.bytesInOutput > 0);
  const classic = panelInputs.map(([p]) => p).find((p) => p.includes('node_modules/zod/') && !/node_modules\/zod\/v4\/(core|mini)\//.test(p));
  if (classic) throw new Error(`dist/webview/main.js bundles ${classic}: import zod/mini, or move the constant into a zod-free module`);
}

// VS Code's default themes, for when the reader's color theme can't be read (docs/HIGHLIGHT-PLAN.md §3).
cpSync('src/extension/highlight/fallback-themes', 'dist/highlight/themes', { recursive: true });

// Export lists and lucide icon data the widget compiler checks imports against (dist/widget-data/).
await generateWidgetData('dist/widget-data');

// Widget libraries (dist/widget-libs/): rebuilt only by a full build, not on watch changes.
await buildWidgetLibs();

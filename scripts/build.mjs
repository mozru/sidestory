// Bundles the extension host code and the webview script, and copies codicons.
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const common = { bundle: true, sourcemap: !production, minify: production, logLevel: 'info', target: 'es2022' };

const builds = [
  { ...common, entryPoints: ['src/extension/extension.ts'], outfile: 'dist/extension.cjs', platform: 'node', format: 'cjs', external: ['vscode'] },
  // content.css is bundled into the script as text: the sandboxed content frame isn't served by the
  // webview's resource loader, so it can't fetch stylesheets itself.
  { ...common, entryPoints: ['src/webview/main.ts'], outfile: 'dist/webview/main.js', platform: 'browser', format: 'esm', loader: { '.css': 'text' } },
  { ...common, entryPoints: ['src/webview/main.css'], outfile: 'dist/webview/main.css' },
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

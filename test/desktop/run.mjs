// Runs the extension in real desktop VS Code (Electron) on this OS, against a copy of the sample workspace:
// once with LF line endings and once with CRLF (as a Windows checkout gives), in a folder whose path has a
// space and non-ASCII characters. VS Code itself is downloaded to .vscode-test/ (cached).
// Usage: node test/desktop/run.mjs [--version 1.95.0|stable] [--only lf|crlf]
import { runTests } from '@vscode/test-electron';
import { build } from 'esbuild';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const version = opt('--version') ?? process.env.CX_VSCODE_VERSION ?? 'stable';
const only = opt('--only');

// The suite runs inside VS Code's extension host: bundle it (mocha and node built-ins stay external).
await build({
  entryPoints: [join(root, 'test/desktop/suite/index.ts')],
  outfile: join(root, 'dist-test/desktop/index.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode', 'mocha'],
  logLevel: 'warning',
});

const TEXT = /\.(ts|tsx|js|sv|json|html|css|md)$/;
/** Sets every text file's line endings: the checkout may be either (a Windows checkout is CRLF). */
function setEol(dir, eol) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) setEol(p, eol);
    else if (TEXT.test(name)) writeFileSync(p, readFileSync(p, 'utf8').replace(/\r?\n/g, eol === 'crlf' ? '\r\n' : '\n'));
  }
}

let failed = false;
for (const eol of ['lf', 'crlf']) {
  if (only && only !== eol) continue;
  // A path with a space and non-ASCII characters catches quoting and URI-encoding bugs.
  const base = mkdtempSync(join(tmpdir(), 'cx desktop ü-'));
  const workspace = join(base, 'Sample Workspace');
  cpSync(join(root, 'fixtures/sample-workspace'), workspace, { recursive: true });
  setEol(workspace, eol);
  const userData = join(base, 'user-data');
  // Small screens (CI's virtual display, a VM at 800×600) leave the editor beside the panel a few lines tall.
  mkdirSync(join(userData, 'User'), { recursive: true });
  writeFileSync(join(userData, 'User', 'settings.json'), JSON.stringify({ 'window.zoomLevel': -2, 'workbench.startupEditor': 'none' }));
  console.log(`\n== desktop VS Code ${version}, ${process.platform}, ${eol.toUpperCase()} ==`);
  try {
    await runTests({
      version,
      extensionDevelopmentPath: root,
      extensionTestsPath: join(root, 'dist-test/desktop/index.cjs'),
      launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', `--user-data-dir=${userData}`],
      extensionTestsEnv: { CX_WORKSPACE: workspace, CX_EOL: eol },
    });
  } catch (e) {
    console.error(`desktop tests failed (${eol}): ${e}`);
    failed = true;
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}
process.exit(failed ? 1 : 0);

// Builds the extension package and a browser-VS-Code container with it installed, then starts it.
// The extension runs in the container (Linux, like a remote host); the panel runs in the browser.
import { execSync } from 'node:child_process';

export const PORT = 3100;
export const CONTAINER = process.env.CX_E2E_CONTAINER ?? 'cx-e2e';
export const WORKSPACE = '/home/workspace/sample';
const run = (cmd: string) => execSync(cmd, { stdio: ['ignore', 'pipe', 'inherit'], cwd: new URL('../..', import.meta.url).pathname });

export default async function setup(): Promise<() => void> {
  run('npm run package');
  run('docker build -q -f test/e2e/Dockerfile -t code-explainer-e2e .');
  run(`docker rm -f ${CONTAINER} || true`);
  run(`docker run -d --name ${CONTAINER} -p 127.0.0.1:${PORT}:3000 code-explainer-e2e`);
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try {
      up = (await fetch(`http://127.0.0.1:${PORT}/`)).ok;
    } catch {
      // not up yet
    }
    if (!up) await new Promise((r) => setTimeout(r, 500));
  }
  if (!up) throw new Error(`VS Code server in container ${CONTAINER} did not start on port ${PORT}`);
  return () => run(`docker rm -f ${CONTAINER}`);
}

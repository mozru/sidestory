// Builds the extension package and a browser-VS-Code container with it installed, then starts it.
// The extension runs in the container (Linux, like a remote host); the panel runs in the browser.
import { execSync } from 'node:child_process';

export const PORT = 3100;
export const CONTAINER = 'cx-e2e';
export const WORKSPACE = '/home/workspace/sample';
const run = (cmd: string) => execSync(cmd, { stdio: ['ignore', 'pipe', 'inherit'], cwd: new URL('../..', import.meta.url).pathname });

export default async function setup(): Promise<() => void> {
  run('npm run package');
  run('docker build -q -f test/e2e/Dockerfile -t code-explainer-e2e .');
  run(`docker rm -f ${CONTAINER} || true`);
  run(`docker run -d --name ${CONTAINER} -p 127.0.0.1:${PORT}:3000 code-explainer-e2e`);
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return () => run(`docker rm -f ${CONTAINER}`);
}

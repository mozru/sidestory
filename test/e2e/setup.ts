// Builds the extension package and a browser-VS-Code container with it installed, then starts it.
// The extension runs in the container (Linux, like a remote host); the panel runs in the browser.
import { execSync } from 'node:child_process';
import { statfsSync } from 'node:fs';
import { tmpdir } from 'node:os';

export const PORT = 3100;
export const CONTAINER = process.env.CX_E2E_CONTAINER ?? 'cx-e2e';
export const WORKSPACE = '/home/workspace/sample';
const run = (cmd: string) => execSync(cmd, { stdio: ['ignore', 'pipe', 'inherit'], cwd: new URL('../..', import.meta.url).pathname });

/** Warns early when the disk (or Docker's VM disk) is nearly full, instead of failing midway through a build. */
function checkDiskSpace(): void {
  const MIN_GB = 5;
  const free = statfsSync(tmpdir());
  const gb = (free.bavail * free.bsize) / 1e9;
  if (gb < MIN_GB) console.warn(`warning: only ${gb.toFixed(1)} GB free on this disk; the e2e image needs ~1 GB plus build cache. Free space or run \`docker builder prune\`.`);
  try {
    const out = execSync("docker system df --format '{{.Type}} {{.Size}}'", { encoding: 'utf8' });
    console.log(`docker disk use: ${out.trim().replace(/\n/g, ', ')}`);
  } catch {
    // docker missing: the build below reports it
  }
}

export default async function setup(): Promise<() => void> {
  checkDiskSpace();
  run('npm run package');
  run('docker build -q -f test/e2e/Dockerfile -t sidestory-e2e .');
  // Each rebuild leaves the previous image untagged; remove those (ours only, by label) so runs don't pile up.
  run('docker image prune -f --filter label=org.sidestory.test=e2e');
  run(`docker rm -f ${CONTAINER} || true`);
  run(`docker run -d --name ${CONTAINER} -p 127.0.0.1:${PORT}:3000 sidestory-e2e`);
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

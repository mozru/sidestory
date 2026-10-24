// Entry of the Sidestory comments MCP server (bundled as plugins/sidestory-comments/server/mcp.cjs and
// dist/mcp.cjs):  node mcp.cjs --project <folder>
// Checks the Node version before loading anything else (docs/COMMENTS-PLAN.md §9.1).
const major = Number(process.versions.node.split('.')[0]);
if (!(major >= 20)) {
  process.stderr.write('Sidestory comments need Node 20 or later on PATH\n');
  process.exit(1);
}

async function main() {
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { SidestoryServer } = await import('./server.ts');
  const { resolveStateDir } = await import('../comments/state-dir.ts');
  const args = process.argv.slice(2);
  const i = args.indexOf('--project');
  const raw = i >= 0 ? args[i + 1] : undefined;
  // An unsubstituted "${CLAUDE_PROJECT_DIR}" (another client) or an empty value means no project argument.
  const project = raw && !raw.includes('${') ? raw : process.env.CLAUDE_PROJECT_DIR || undefined;
  const server = new SidestoryServer({ project, stateDir: await resolveStateDir(), log: (s) => process.stderr.write(`sidestory: ${s}\n`) });
  const transport = new StdioServerTransport();
  await server.start(transport);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    // A moment for answers still being written (stdout to a pipe is asynchronous on macOS).
    setTimeout(() => void server.close().then(() => process.exit(0)), 300);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.stdin.on('end', stop);
  process.stdin.on('close', stop);
  if (process.stdin.readableEnded || process.stdin.destroyed) stop();
}

main().catch((e: unknown) => {
  process.stderr.write(`sidestory: ${(e as Error).message}\n`);
  process.exit(1);
});

// A scripted stand-in for Claude Code (docs/COMMENTS-PLAN.md §13.4): spawns the real comments MCP server, speaks
// JSON-RPC to it over stdio as client "claude-code", and answers every channel event with ack, then reply.
//   node fake-claude.cjs <dist/mcp.cjs> <project folder>
const { spawn } = require('node:child_process');
const [server, project] = process.argv.slice(2);
const child = spawn(process.execPath, [server, '--project', project], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
let id = 0;
const pending = new Map();
const write = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
const call = (method, params) =>
  new Promise((resolve) => {
    const i = ++id;
    pending.set(i, resolve);
    write({ jsonrpc: '2.0', id: i, method, params });
  });

async function onPush(params) {
  console.log(`push ${JSON.stringify(params.meta)}`);
  const { thread, nonce } = params.meta;
  await call('tools/call', { name: 'ack', arguments: { thread, nonce } });
  const r = await call('tools/call', {
    name: 'reply',
    arguments: { thread, nonce, text: 'Equal jitter keeps half of the delay fixed, so retries stay spread out. See `rtl/bit_reader.sv#L1-L3`.', resolve_suggested: true },
  });
  console.log(`reply ${JSON.stringify(r.result ?? r.error)}`);
}

child.stdout.on('data', (d) => {
  buf += d;
  let n;
  while ((n = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, n);
    buf = buf.slice(n + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.id !== undefined && pending.has(m.id) && !m.method) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    } else if (m.method === 'notifications/claude/channel') void onPush(m.params);
    else if (m.method === 'roots/list') write({ jsonrpc: '2.0', id: m.id, result: { roots: [] } });
  }
});

(async () => {
  const init = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: 'e2e' } });
  console.log(`initialized ${JSON.stringify(init.result.capabilities)}`);
  write({ jsonrpc: '2.0', method: 'notifications/initialized' });
})();
setTimeout(() => process.exit(0), 180_000);

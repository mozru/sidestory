// The highlight worker (dist/highlight-worker.cjs): tokenizes sidestory code blocks off the extension host's
// thread, so a slow grammar on hostile input can be cut off by terminating it (docs/HIGHLIGHT-PLAN.md §5, §10.4).
import { parentPort, workerData } from 'node:worker_threads';
import { createOnigLib, Tokenizer } from './tokenize.ts';
import type { WorkerReply, WorkerRequest } from './worker-protocol.ts';

const notes: string[] = [];
const engine = createOnigLib((workerData as { wasmFiles?: string[] } | undefined)?.wasmFiles ?? [], (m) => notes.push(m));
const tokenizer = new Tokenizer(engine.then((e) => e.lib));

parentPort!.on('message', (m: WorkerRequest) => {
  void handle(m).then((reply) => parentPort!.postMessage(reply));
});

async function handle(m: WorkerRequest): Promise<WorkerReply> {
  try {
    if (m.theme) tokenizer.setTheme(m.theme);
    if (m.type === 'load') {
      const loaded = await tokenizer.load(m.scope, m.set);
      const e = await engine;
      return { id: m.id, ok: true, loaded: loaded === true, ...(loaded === 'stale' ? { stale: true } : {}), engine: e.engine, ...(notes.length ? { engineNote: notes.join('; ').slice(0, 500) } : {}) };
    }
    if (!tokenizer.isWarm(m.scope) || !tokenizer.hasTheme(m.themeKey)) return { id: m.id, ok: true, cold: true };
    const r = tokenizer.tokenize(m.code, m.scope, m.themeKey);
    return { id: m.id, ok: true, runs: r?.runs ?? null, palette: tokenizer.palette(m.themeKey) };
  } catch (e) {
    return { id: m.id, ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) };
  }
}

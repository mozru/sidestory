// The compile worker's entry (bundled as dist/compile-worker.cjs). Widget code is untrusted input, so it
// is compiled here, under the time and memory limits compile.ts sets, and never in the extension host's
// own thread. The worker stays warm between compiles and keeps a bounded cache of transformed modules.
import { parentPort, workerData } from 'node:worker_threads';
import { WidgetCompilerCore } from './compile-core.ts';
import type { CompileRequest, WorkerReply } from './types.ts';

const data = (workerData ?? {}) as { dataDir?: string; cacheBytes?: number };
const core = new WidgetCompilerCore({ dataDir: data.dataDir, cacheBytes: data.cacheBytes });

parentPort?.on('message', (req: CompileRequest) => {
  core.compile(req.explainerDir, req.src).then(
    (result) => parentPort!.postMessage({ id: req.id, result } satisfies WorkerReply),
    (e: unknown) => parentPort!.postMessage({ id: req.id, failure: e instanceof RangeError ? 'too-complex' : String((e as Error)?.message ?? e).slice(0, 500) } satisfies WorkerReply),
  );
});

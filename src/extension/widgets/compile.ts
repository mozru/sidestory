// The widget compiler, host side (docs/WIDGETS-PLAN.md §3 "Compile"): runs compiles in a warm
// worker_thread, one at a time, each with a time limit; a compile that times out or crashes the worker
// gets an error result and the worker is replaced. The work itself is in compile-core.ts.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { normalizeEntry } from './specifiers.ts';
import type { CompileRequest, CompileResult, Diag, WorkerReply } from './types.ts';

export type { CompileResult, Diag } from './types.ts';

export interface WidgetCompilerOptions {
  /** The worker script. Default: compile-worker.cjs next to the extension bundle. */
  workerFile?: string;
  /** Folder with exports.json and lucide.json. Default: widget-data next to the extension bundle. */
  dataDir?: string;
  /** Per-compile time limit in ms (default 2000). */
  timeoutMs?: number;
  /** The worker's heap limit (default 512 MB, enough for the 1 MB source cap). */
  maxOldGenerationSizeMb?: number;
  /** Bound on the worker's cache of transformed modules, in bytes (default 20 MB). */
  cacheBytes?: number;
}

interface Job {
  req: CompileRequest;
  timeoutMs: number;
  resolve: (r: CompileResult) => void;
  timer?: ReturnType<typeof setTimeout>;
}

const bundleDir = typeof __dirname === 'string' ? __dirname : undefined;

function failed(src: string, code: string, message: string): CompileResult {
  const e = normalizeEntry(src);
  const file = e.ok ? e.key : 'explainer.html';
  return { entry: e.ok ? e.key : '', modules: {}, libraries: [], icons: {}, warnings: [], errors: [{ file, code, message } satisfies Diag], hash: '', files: [] };
}

export class WidgetCompiler {
  private worker: Worker | undefined;
  private readonly queue: Job[] = [];
  private current: Job | undefined;
  private nextId = 1;
  private disposed = false;
  /** How many workers were started (tests: a timeout or crash replaces the worker). */
  workersStarted = 0;

  private readonly opts: WidgetCompilerOptions;

  constructor(opts: WidgetCompilerOptions = {}) {
    this.opts = opts;
  }

  /**
   * Compiles the widget at `src` (relative to `explainerDir`) and its import closure. Never rejects:
   * problems, including timeouts and worker crashes, come back in `errors`.
   */
  compile(explainerDir: string, src: string, opts: { timeoutMs?: number } = {}): Promise<CompileResult> {
    if (this.disposed) return Promise.resolve(failed(src, 'internal', 'The widget compiler has been shut down.'));
    return new Promise((resolve) => {
      this.queue.push({ req: { id: this.nextId++, explainerDir, src }, timeoutMs: opts.timeoutMs ?? this.opts.timeoutMs ?? 2000, resolve });
      this.pump();
    });
  }

  dispose(): void {
    this.disposed = true;
    this.stopWorker();
    for (const job of [...(this.current ? [this.current] : []), ...this.queue.splice(0)]) {
      clearTimeout(job.timer);
      job.resolve(failed(job.req.src, 'internal', 'The widget compiler has been shut down.'));
    }
    this.current = undefined;
  }

  private startWorker(): Worker {
    const file = this.opts.workerFile ?? (bundleDir && join(bundleDir, 'compile-worker.cjs'));
    if (!file || !existsSync(file)) throw new Error('The widget compiler worker is missing from this build.');
    const w = new Worker(resolve(file), {
      workerData: { dataDir: this.opts.dataDir ?? (bundleDir && join(bundleDir, 'widget-data')), cacheBytes: this.opts.cacheBytes },
      resourceLimits: { maxOldGenerationSizeMb: this.opts.maxOldGenerationSizeMb ?? 512, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
      stdout: false,
      stderr: false,
    });
    this.workersStarted++;
    w.unref();
    w.on('message', (msg: WorkerReply) => {
      if (w !== this.worker) return;
      const job = this.current;
      if (!job || job.req.id !== msg.id) return;
      this.finish(job, 'result' in msg ? msg.result : failed(job.req.src, msg.failure === 'too-complex' ? 'too-complex' : 'internal', msg.failure === 'too-complex' ? 'This widget is nested too deeply to compile.' : `The widget compiler failed: ${msg.failure}`));
    });
    const onDeath = (why: string) => {
      if (w !== this.worker) return;
      this.worker = undefined;
      const job = this.current;
      if (job) this.finish(job, failed(job.req.src, 'crashed', `The widget compiler stopped while compiling this widget (${why}); it may be too large or too complex.`));
    };
    w.on('error', (e) => onDeath(e.message.slice(0, 200)));
    w.on('exit', (code) => onDeath(`exit code ${code}`));
    return w;
  }

  private stopWorker(): void {
    const w = this.worker;
    this.worker = undefined;
    void w?.terminate();
  }

  private finish(job: Job, result: CompileResult): void {
    clearTimeout(job.timer);
    if (this.current === job) this.current = undefined;
    job.resolve(result);
    this.pump();
  }

  private pump(): void {
    if (this.current || this.disposed) return;
    const job = this.queue.shift();
    if (!job) return;
    try {
      this.worker ??= this.startWorker();
    } catch (e) {
      job.resolve(failed(job.req.src, 'internal', (e as Error).message));
      this.pump();
      return;
    }
    this.current = job;
    job.timer = setTimeout(() => {
      if (this.current !== job) return;
      this.stopWorker();
      this.finish(job, failed(job.req.src, 'timeout', `Compiling this widget took longer than ${job.timeoutMs / 1000} s; it may be too large or too complex.`));
    }, job.timeoutMs);
    this.worker.postMessage(job.req);
  }
}

let shared: WidgetCompiler | undefined;
let sharedOptions: WidgetCompilerOptions = {};

/** Sets options for the shared compiler used by compileWidget (replacing any running one). */
export function configureWidgetCompiler(opts: WidgetCompilerOptions): void {
  shared?.dispose();
  shared = undefined;
  sharedOptions = opts;
}

/** Compiles a widget with the shared, warm compiler. See WidgetCompiler.compile. */
export function compileWidget(explainerDir: string, src: string, opts?: { timeoutMs?: number }): Promise<CompileResult> {
  return (shared ??= new WidgetCompiler(sharedOptions)).compile(explainerDir, src, opts);
}

/** Stops the shared compiler's worker (extension deactivation). */
export function disposeWidgetCompiler(): void {
  shared?.dispose();
  shared = undefined;
}

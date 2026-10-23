// The highlighter, host side (docs/HIGHLIGHT-PLAN.md §2, §5): one warm worker shared by every panel, one job at a
// time with a time limit, a result cache, per-panel coalescing and a circuit breaker. No VS Code API here.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { type HighlightLang, type HighlightStyle, MAX_BLOCK_CHARS, MAX_BLOCK_LINES } from '../../shared/highlight-languages.ts';
import { SizeLru } from '../widgets/lru.ts';
import type { HighlightTheme } from './theme.ts';
import { countLines, grammarsFor } from './grammars.ts';
import type { WorkerReply, WorkerRequest } from './worker-protocol.ts';

export interface HighlighterOptions {
  /** The worker script. Default: highlight-worker.cjs next to the extension bundle. */
  workerFile?: string;
  /** Folder of grammar JSON files. Default: highlight/grammars next to the extension bundle. */
  grammarDir?: string;
  /** Limit for loading grammars (default 10 s). */
  loadTimeoutMs?: number;
  /** Minimum per-block limit (default 1 s; more for large blocks: 30 ms per KB). */
  blockTimeoutMs?: number;
  /** Added to the limit per KB of code (default 30 ms). */
  msPerKb?: number;
  /** Stop the idle worker after this long (default 2 min). */
  idleMs?: number;
  /** Worker time a requester may use within the breaker's window (default 20 s). */
  budgetMs?: number;
  /** Jobs up to this long aren't charged to the budget (default 250 ms). */
  slowJobMs?: number;
  /** Result cache, in bytes (default 4 MB). */
  cacheBytes?: number;
  log?: (message: string) => void;
}

export interface BlockRequest {
  id: number;
  lang: HighlightLang;
  code: string;
}

export interface HighlightResult {
  theme: string;
  palette: HighlightStyle[];
  blocks: { id: number; runs: number[] | null }[];
}

/** A panel (or anything else asking): one waiting request at a time, and its own circuit breaker. */
export interface Requester {
  running: boolean;
  waiting?: { blocks: BlockRequest[]; resolve: (r: HighlightResult | undefined) => void };
  /** Timeouts and worker crashes, and worker time spent [when, ms], within the breaker's window. */
  timeouts: number[];
  spent: [number, number][];
  tripped: boolean;
  /** When it tripped: highlighting comes back after the breaker's window. */
  trippedAt?: number;
  /** Its panel is gone: stop working for it. */
  disposed?: boolean;
}

export const BREAKER_TIMEOUTS = 3;
export const BREAKER_WINDOW_MS = 5 * 60_000;
/** Worker time one requester may use within the window before its code stays plain. */
export const BREAKER_BUDGET_MS = 20_000;
/** Jobs up to this long aren't charged; longer ones are charged the excess. */
export const SLOW_JOB_MS = 250;

interface Job {
  req: WorkerRequest;
  timeoutMs: number;
  resolve: (r: WorkerReply | 'timeout' | 'crashed') => void;
  /** When the worker got it (time waiting in the queue isn't the requester's). */
  startedAt?: number;
  timer?: ReturnType<typeof setTimeout>;
}

const bundleDir = typeof __dirname === 'string' ? __dirname : undefined;

export class Highlighter {
  private worker: Worker | undefined;
  /** What the current worker has: grammars loaded and warmed, themes sent. */
  private warm = new Set<string>();
  private themesSent = new Set<string>();
  private readonly queue: Job[] = [];
  private current: Job | undefined;
  private nextId = 1;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private theme: HighlightTheme | undefined;
  /** Results by (theme, lang, hash of code). */
  private readonly cache: SizeLru<Uint32Array | null>;
  /** Blocks being tokenized now, so a second request for the same block waits for the same answer. */
  private readonly inflight = new Map<string, Promise<number[] | null>>();
  /** The host's palette per theme (stable while the host runs; a replaced worker's indexes are remapped into it). */
  private readonly palettes = new Map<string, { styles: HighlightStyle[]; index: Map<string, number> }>();
  private readonly opts: HighlighterOptions;
  /** Tests: how many workers were started. */
  workersStarted = 0;

  constructor(opts: HighlighterOptions = {}) {
    this.opts = opts;
    this.cache = new SizeLru(opts.cacheBytes ?? 4 * 1024 * 1024);
  }

  setTheme(theme: HighlightTheme): void {
    this.theme = theme;
  }

  get themeKey(): string | undefined {
    return this.theme?.key;
  }

  newRequester(): Requester {
    return { running: false, timeouts: [], spent: [], tripped: false };
  }

  /**
   * Highlights blocks for a requester. Resolves undefined when a newer request from the same requester replaced
   * this one before it started. The result is always under the theme current when it resolves.
   */
  request(who: Requester, blocks: BlockRequest[]): Promise<HighlightResult | undefined> {
    return new Promise((resolve) => {
      if (who.running) {
        who.waiting?.resolve(undefined);
        who.waiting = { blocks, resolve };
        return;
      }
      void this.run(who, blocks, resolve);
    });
  }

  private async run(who: Requester, blocks: BlockRequest[], resolve: (r: HighlightResult | undefined) => void): Promise<void> {
    who.running = true;
    try {
      resolve(await this.highlightAll(who, blocks));
    } catch (e) {
      this.opts.log?.(`Highlighting failed: ${(e as Error).message}`);
      resolve(undefined);
    } finally {
      who.running = false;
      const next = who.waiting;
      who.waiting = undefined;
      if (next) void this.run(who, next.blocks, next.resolve);
    }
  }

  private async highlightAll(who: Requester, blocks: BlockRequest[]): Promise<HighlightResult | undefined> {
    if (who.tripped && Date.now() - (who.trippedAt ?? 0) > BREAKER_WINDOW_MS) {
      who.tripped = false;
      who.timeouts = [];
      who.spent = [];
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const theme = this.theme;
      if (!theme || this.disposed) return undefined;
      const out: HighlightResult['blocks'] = [];
      for (const b of blocks) {
        if (this.theme !== theme || who.disposed) break;
        out.push({ id: b.id, runs: who.tripped ? null : await this.block(who, theme, b) });
      }
      // The theme changed meanwhile: do it again (mostly from the cache) under the new one.
      if (who.disposed) return undefined;
      if (this.theme !== theme) continue;
      return { theme: theme.key, palette: this.palette(theme.key).styles, blocks: out };
    }
    return undefined;
  }

  private palette(key: string): { styles: HighlightStyle[]; index: Map<string, number> } {
    let p = this.palettes.get(key);
    if (!p) {
      // Never evicted: cached runs hold its indexes (a palette is a few hundred entries at most).
      p = { styles: [{}], index: new Map() };
      this.palettes.set(key, p);
    }
    return p;
  }

  private async block(who: Requester, theme: HighlightTheme, b: BlockRequest): Promise<number[] | null> {
    const key = `${theme.key}\n${b.lang}\n${createHash('sha256').update(b.code).digest('base64url')}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit && Array.from(hit);
    let p = this.inflight.get(key);
    if (!p) {
      p = this.tokenize(who, theme, b, key).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  private async tokenize(who: Requester, theme: HighlightTheme, b: BlockRequest, key: string): Promise<number[] | null> {
    if (b.code.length > MAX_BLOCK_CHARS || countLines(b.code) > MAX_BLOCK_LINES) return null;
    const langs = grammarsFor(b.lang, b.code);
    // Two rounds: a worker replaced between loading and tokenizing (another job's timeout) answers "cold".
    for (let round = 0; round < 2; round++) {
      for (let tries = 0; !langs.every((l) => this.warm.has(l)); tries++) {
        if (tries >= 2 || who.tripped) return null;
        const r = await this.job({ id: 0, type: 'load', langs }, this.opts.loadTimeoutMs ?? 10_000, theme); // loading grammars isn't charged: it happens once per worker
        if (r === 'timeout') this.timedOut(who);
        else if (typeof r === 'object' && r.ok) for (const l of langs) this.warm.add(l);
        else {
          if (r === 'crashed') this.timedOut(who);
          return null; // crashed or failed: give up on this block for now
        }
      }
      if (who.tripped) return null;
      const limit = Math.max(this.opts.blockTimeoutMs ?? 1000, Math.ceil((b.code.length / 1024) * (this.opts.msPerKb ?? 30)));
      const r = await this.job({ id: 0, type: 'tokenize', lang: b.lang, code: b.code, themeKey: theme.key }, limit, theme, who);
      if (r === 'timeout' || r === 'crashed') {
        this.timedOut(who);
        this.cache.set(key, null, 64); // warm and still too slow, or it killed the worker: stays plain under this theme
        return null;
      }
      if (!r.ok) return null;
      if (r.cold) {
        this.warm.clear();
        this.themesSent.clear();
        continue;
      }
      if (!r.runs) {
        this.cache.set(key, null, 64);
        return null;
      }
      const runs = this.remap(theme.key, r.runs, r.palette ?? [{}]);
      this.cache.set(key, Uint32Array.from(runs), runs.length * 4 + 64);
      return runs;
    }
    return null;
  }

  /** Worker palette indexes → the host's stable ones. */
  private remap(themeKey: string, runs: number[], workerPalette: HighlightStyle[]): number[] {
    const pal = this.palette(themeKey);
    const map = workerPalette.map((s, i) => {
      if (i === 0) return 0;
      const k = `${s.color ?? ''}|${s.font ?? 0}`;
      let j = pal.index.get(k);
      if (j === undefined) {
        j = pal.styles.length;
        pal.styles.push(s);
        pal.index.set(k, j);
      }
      return j;
    });
    const out = runs.slice();
    for (let i = 1; i < out.length; i += 2) out[i] = map[out[i]!] ?? 0;
    return out;
  }

  private timedOut(who: Requester): void {
    const now = Date.now();
    who.timeouts = [...who.timeouts.filter((t) => now - t < BREAKER_WINDOW_MS), now];
    if (who.timeouts.length >= BREAKER_TIMEOUTS) this.trip(who, `took too long to highlight ${BREAKER_TIMEOUTS} times`);
  }

  /** Worker time used for a requester: past the budget within the window, its code stays plain. */
  private spend(who: Requester, ms: number): void {
    const now = Date.now();
    // Only slow jobs count: live editing re-tokenizes a block per keystroke, which is fine however long it goes on.
    const free = this.opts.slowJobMs ?? SLOW_JOB_MS;
    if (ms <= free) return;
    who.spent = [...who.spent.filter(([t]) => now - t < BREAKER_WINDOW_MS).slice(-500), [now, ms - free]];
    if (who.spent.reduce((n, [, m]) => n + m, 0) > (this.opts.budgetMs ?? BREAKER_BUDGET_MS)) this.trip(who, 'kept the highlighter busy too long');
  }

  private trip(who: Requester, why: string): void {
    if (who.tripped) return;
    who.tripped = true;
    who.trippedAt = Date.now();
    this.opts.log?.(`Code blocks in this sidestory ${why}; they stay plain in this panel for ${BREAKER_WINDOW_MS / 60_000} minutes.`);
  }

  /** Runs a job in the worker; resolves with its outcome and the worker time it took (`ms`). */
  private job(req: WorkerRequest, timeoutMs: number, theme: HighlightTheme, who?: Requester): Promise<WorkerReply | 'timeout' | 'crashed'> {
    if (this.disposed) return Promise.resolve('crashed');
    return new Promise((resolve) => {
      const job: Job = {
        req: { ...req, id: this.nextId++ },
        timeoutMs,
        resolve: (r) => {
          if (who && job.startedAt !== undefined) this.spend(who, Date.now() - job.startedAt);
          resolve(r);
        },
      };
      this.queue.push(job);
      // The theme goes with the job the first time this worker needs it (decided when the job starts).
      (this.queue.at(-1) as Job & { theme?: HighlightTheme }).theme = theme;
      this.pump();
    });
  }

  private pump(): void {
    if (this.current || this.disposed) return;
    const job = this.queue.shift() as (Job & { theme?: HighlightTheme }) | undefined;
    if (!job) {
      this.armIdle();
      return;
    }
    clearTimeout(this.idleTimer);
    try {
      this.worker ??= this.startWorker();
    } catch (e) {
      this.opts.log?.((e as Error).message);
      job.resolve('crashed');
      this.pump();
      return;
    }
    this.current = job;
    job.startedAt = Date.now();
    const req = { ...job.req };
    if (job.theme && !this.themesSent.has(job.theme.key)) {
      req.theme = job.theme;
      this.themesSent.add(job.theme.key);
    }
    job.timer = setTimeout(() => {
      if (this.current !== job) return;
      this.stopWorker();
      this.finish(job, 'timeout');
    }, job.timeoutMs);
    this.worker.postMessage(req);
  }

  private finish(job: Job, r: WorkerReply | 'timeout' | 'crashed'): void {
    clearTimeout(job.timer);
    if (this.current === job) this.current = undefined;
    job.resolve(r);
    this.pump();
  }

  private startWorker(): Worker {
    const file = this.opts.workerFile ?? (bundleDir && join(bundleDir, 'highlight-worker.cjs'));
    if (!file || !existsSync(file)) throw new Error('The highlight worker is missing from this build.');
    const w = new Worker(resolve(file), {
      workerData: { grammarDir: this.opts.grammarDir ?? (bundleDir && join(bundleDir, 'highlight', 'grammars')) },
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
      stdout: false,
      stderr: false,
    });
    this.workersStarted++;
    w.unref();
    w.on('message', (msg: WorkerReply) => {
      if (w !== this.worker) return;
      const job = this.current;
      if (job && job.req.id === msg.id) this.finish(job, msg);
    });
    const onDeath = () => {
      if (w !== this.worker) return;
      this.stopWorker();
      if (this.current) this.finish(this.current, 'crashed');
    };
    w.on('error', onDeath);
    w.on('exit', onDeath);
    return w;
  }

  private armIdle(): void {
    clearTimeout(this.idleTimer);
    if (!this.worker) return;
    this.idleTimer = setTimeout(() => {
      if (!this.current && !this.queue.length) this.stopWorker();
    }, this.opts.idleMs ?? 120_000);
    this.idleTimer.unref?.();
  }

  private stopWorker(): void {
    const w = this.worker;
    this.worker = undefined;
    // A new worker starts cold: the next block loads its grammars (on their own clock) first.
    this.warm.clear();
    this.themesSent.clear();
    void w?.terminate();
  }

  /** Tests: whether a worker is running. */
  get running(): boolean {
    return this.worker !== undefined;
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.idleTimer);
    this.stopWorker();
    for (const job of [...(this.current ? [this.current] : []), ...this.queue.splice(0)]) {
      clearTimeout(job.timer);
      job.resolve('crashed');
    }
    this.current = undefined;
  }
}

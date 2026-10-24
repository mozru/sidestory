// The highlighter, host side (docs/HIGHLIGHT-PLAN.md §2, §5): one warm worker shared by every panel, one job at a
// time with a time limit, a result cache, per-panel coalescing and a circuit breaker. No VS Code API here.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { type HighlightStyle, MAX_BLOCK_CHARS, MAX_BLOCK_LINES } from '../../shared/highlight-languages.ts';
import { SizeLru } from '../widgets/lru.ts';
import type { GrammarSet } from './catalog.ts';
import type { HighlightTheme } from './theme.ts';
import { countLines } from './grammars.ts';
import type { EngineName } from './tokenize.ts';
import type { WorkerReply, WorkerRequest } from './worker-protocol.ts';

/** Where grammars come from (docs/HIGHLIGHT-PLAN.md §10): the installed extensions, through a GrammarCatalog. */
export interface GrammarSource {
  /** Changes when what it would load changes. */
  readonly key: string;
  /** The scope a block's language name picks, or undefined (the block stays plain). */
  scopeFor(lang: string): string | undefined;
  /** A scope's grammar files (its includes and injections with it), or undefined when it can't be read. */
  load(scope: string, have?: ReadonlySet<string>): Promise<GrammarSet | undefined>;
  /** The extension a scope's grammar comes from, for messages. */
  origin?(scope: string): string | undefined;
}

export interface HighlighterOptions {
  /** The worker script. Default: highlight-worker.cjs next to the extension bundle. */
  workerFile?: string;
  /** Candidate paths of VS Code's onig.wasm; the worker uses the first that loads, else a JavaScript regex engine. */
  wasmFiles?: string[];
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
  /** Grammar text a worker may hold before it's replaced (default 12 MB). */
  workerGrammarBudget?: number;
  log?: (message: string) => void;
  /** News that isn't a problem (default: `log`). */
  info?: (message: string) => void;
}

export interface BlockRequest {
  id: number;
  /** The language name the block gives (`ts`, `python`); the grammar source maps it to a scope. */
  lang: string;
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

/** Grammar text (UTF-16 code units) a worker may hold before it's replaced: ~8 bytes of heap per unit parsed. */
export const WORKER_GRAMMAR_BUDGET = 12 * 1024 * 1024;

interface Job {
  /** Only for this worker (its grammar set leaves out what that worker had); another answers "cold". */
  forWorker?: number;
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
  /** Grammar scopes sent to the current worker, and their text's size. */
  private sent = new Set<string>();
  private sentBytes = 0;
  /** Counts workers started: a job can be tied to one. */
  private workerGen = 0;
  private themesSent = new Set<string>();
  private readonly queue: Job[] = [];
  private current: Job | undefined;
  private nextId = 1;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private theme: HighlightTheme | undefined;
  private grammars: GrammarSource | undefined;
  /** Bumped by every theme or grammar change: a result made under an older one is made again. */
  private version = 0;
  /** The worker must be replaced before its next job (the grammars changed). */
  private restartWorker = false;
  /** Scopes whose grammar couldn't be read or loaded, under the current grammars. */
  private readonly failed = new Set<string>();
  private engineName: EngineName | undefined;
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
    if (theme.key !== this.theme?.key) this.version++;
    this.theme = theme;
  }

  /** New grammars: results are made again, and the worker is replaced (it has the old ones loaded). */
  setGrammars(grammars: GrammarSource): void {
    // The same grammars (a refresh for another reason): keep the source, so reads in progress stay valid.
    if (grammars.key === this.grammars?.key) return;
    this.grammars = grammars;
    this.version++;
    this.failed.clear();
    if (this.current) this.restartWorker = true;
    else this.stopWorker();
  }

  /** What the panel sees as "the theme": its colors and the grammars, so either changing recolors blocks. */
  get themeKey(): string | undefined {
    return this.theme && `${this.theme.key}.${this.grammars?.key ?? 'none'}`;
  }

  /** The regex engine the worker last reported (tests, logs). */
  get engine(): EngineName | undefined {
    return this.engineName;
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
      const version = this.version;
      const key = this.themeKey;
      if (!theme || !key || this.disposed) return undefined;
      const out: HighlightResult['blocks'] = [];
      for (const b of blocks) {
        if (this.version !== version || who.disposed) break;
        out.push({ id: b.id, runs: who.tripped ? null : await this.block(who, theme, key, b) });
      }
      // The theme or the grammars changed meanwhile: do it again (mostly from the cache) under the new ones.
      if (who.disposed) return undefined;
      if (this.version !== version) continue;
      return { theme: key, palette: this.palette(theme.key).styles, blocks: out };
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

  private async block(who: Requester, theme: HighlightTheme, themeKey: string, b: BlockRequest): Promise<number[] | null> {
    const scope = this.grammars?.scopeFor(b.lang);
    if (!scope || this.failed.has(scope)) return null;
    const key = `${themeKey}\n${scope}\n${createHash('sha256').update(b.code).digest('base64url')}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit && Array.from(hit);
    let p = this.inflight.get(key);
    if (!p) {
      p = this.tokenize(who, theme, scope, b.code, key).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  private async tokenize(who: Requester, theme: HighlightTheme, scope: string, code: string, key: string): Promise<number[] | null> {
    if (code.length > MAX_BLOCK_CHARS || countLines(code) > MAX_BLOCK_LINES) return null;
    // Two rounds: a worker replaced between loading and tokenizing (another job's timeout) answers "cold".
    for (let round = 0; round < 2; round++) {
      for (let tries = 0; !this.warm.has(scope); tries++) {
        if (tries >= 3 || who.tripped || this.failed.has(scope)) return null;
        const grammars = this.grammars;
        if (!grammars) return null;
        // A worker holding many grammars is replaced before it loads more (its heap is capped).
        if (this.sentBytes > (this.opts.workerGrammarBudget ?? WORKER_GRAMMAR_BUDGET)) this.restartWorker = true;
        // What the current worker already has isn't sent again; such a set only fits that worker.
        const have = this.restartWorker || !this.worker ? new Set<string>() : new Set(this.sent);
        const forWorker = have.size ? this.workerGen : undefined;
        const set = await grammars.load(scope, have).catch(() => undefined);
        if (grammars !== this.grammars) return null; // changed while reading: the result is made again anyway
        const from = grammars.origin?.(scope);
        const name = `${scope}${from ? ` (from ${from})` : ''}`;
        if (!set) {
          this.failed.add(scope);
          this.opts.log?.(`Code block colors: couldn't read the grammar ${name}; its blocks stay plain.`);
          return null;
        }
        const fresh = this.restartWorker || !this.worker || this.sent.size === 0;
        // Charged to the requester like tokenizing (beyond the free time), so naming every language costs it.
        const r = await this.job({ id: 0, type: 'load', scope, set }, this.opts.loadTimeoutMs ?? 10_000, theme, who, forWorker);
        if (grammars !== this.grammars) return null;
        if (r === 'timeout' || r === 'crashed') {
          // On a worker with nothing else loaded, this grammar alone is to blame: it stays plain. Otherwise the worker
          // may have been full of others' grammars: try again on a fresh one, without charging this requester.
          if (fresh) {
            this.timedOut(who);
            this.failed.add(scope);
            this.opts.log?.(`Code block colors: loading the grammar ${name} ${r === 'timeout' ? 'took too long' : 'stopped the highlighter'}; its blocks stay plain.`);
            return null;
          }
          continue;
        }
        if (!r.ok) return null;
        this.noteEngine(r);
        if (r.cold) continue; // the worker was replaced before the job ran: read the set again
        if (r.stale) {
          this.restartWorker = true;
          continue;
        }
        for (const f of set.files) this.sent.add(f.scopeName);
        this.sentBytes += set.bytes ?? 0;
        if (!r.loaded) {
          this.failed.add(scope);
          this.opts.log?.(`Code block colors: the grammar ${name} didn't load; its blocks stay plain.`);
          return null;
        }
        this.warm.add(scope);
      }
      if (who.tripped) return null;
      const limit = Math.max(this.opts.blockTimeoutMs ?? 1000, Math.ceil((code.length / 1024) * (this.opts.msPerKb ?? 30)));
      const r = await this.job({ id: 0, type: 'tokenize', scope, code, themeKey: theme.key }, limit, theme, who);
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

  private noteEngine(r: { engine?: EngineName; engineNote?: string }): void {
    if (!r.engine || r.engine === this.engineName) return;
    this.engineName = r.engine;
    if (r.engine === 'oniguruma') (this.opts.info ?? this.opts.log)?.("Code block colors: using VS Code's Oniguruma regex engine.");
    else this.opts.log?.(`Code block colors: VS Code's Oniguruma regex engine isn't available here${r.engineNote ? ` (${r.engineNote})` : ''}; using a JavaScript one, which may leave a few patterns uncolored.`);
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
  private job(req: WorkerRequest, timeoutMs: number, theme: HighlightTheme, who?: Requester, forWorker?: number): Promise<WorkerReply | 'timeout' | 'crashed'> {
    if (this.disposed) return Promise.resolve('crashed');
    return new Promise((resolve) => {
      const job: Job = {
        req: { ...req, id: this.nextId++ },
        timeoutMs,
        forWorker,
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
    if (this.restartWorker) {
      this.restartWorker = false;
      this.stopWorker();
    }
    try {
      this.worker ??= this.startWorker();
    } catch (e) {
      this.opts.log?.((e as Error).message);
      job.resolve('crashed');
      this.pump();
      return;
    }
    if (job.forWorker !== undefined && job.forWorker !== this.workerGen) {
      // Made for a worker that's gone: the new one lacks what the set left out.
      job.resolve({ id: job.req.id, ok: true, cold: true });
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
      workerData: { wasmFiles: this.opts.wasmFiles ?? [] },
      resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
      stdout: false,
      stderr: false,
    });
    this.workersStarted++;
    this.workerGen++;
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
    this.sent.clear();
    this.sentBytes = 0;
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

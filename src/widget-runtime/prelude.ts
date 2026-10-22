// Injected at the top of every widget library and the runtime (esbuild `inject`), so it runs before any
// library captures the timer functions (d3-timer binds requestAnimationFrame at load): wraps setTimeout,
// setInterval and requestAnimationFrame so the runtime can suspend them while the widget is off-screen
// (`visible: false`). Chromium doesn't throttle timers in off-screen cross-origin frames.
// Idempotent: the first bundle to load installs it.

export interface CxEnv {
  suspend(): void;
  resume(): void;
  readonly suspended: boolean;
  /** The browser's own functions, for the runtime's housekeeping (never suspended). */
  native: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout; requestAnimationFrame: typeof requestAnimationFrame; cancelAnimationFrame: typeof cancelAnimationFrame };
}

declare global {
  // eslint-disable-next-line no-var
  var __cxEnv: CxEnv | undefined;
}

type Timer = { kind: 'timeout' | 'interval'; cb: unknown; args: unknown[]; delay: number; due: number; native?: number };

function install(): CxEnv {
  const w = globalThis as typeof globalThis & Window;
  const native = {
    setTimeout: w.setTimeout.bind(w), clearTimeout: w.clearTimeout.bind(w),
    setInterval: w.setInterval.bind(w), clearInterval: w.clearInterval.bind(w),
    requestAnimationFrame: w.requestAnimationFrame.bind(w), cancelAnimationFrame: w.cancelAnimationFrame.bind(w),
  };
  let suspended = false;
  let next = 1;
  const timers = new Map<number, Timer>();
  const frames = new Map<number, { cb: FrameRequestCallback; native?: number }>();

  const call = (cb: unknown, args: unknown[]) => {
    // A string callback would be eval; CSP blocks it anyway. Ignore, as the browser does.
    if (typeof cb === 'function') (cb as (...a: unknown[]) => void)(...args);
  };
  const arm = (id: number, t: Timer, wait: number) => {
    t.due = performance.now() + wait;
    t.native = native.setTimeout(() => {
      if (t.kind === 'timeout') timers.delete(id);
      else arm(id, t, t.delay);
      call(t.cb, t.args);
    }, wait);
  };
  const add = (kind: Timer['kind']) => (cb: unknown, delay?: number, ...args: unknown[]) => {
    const id = next++;
    const t: Timer = { kind, cb, args, delay: Math.max(0, Number(delay) || 0), due: 0 };
    timers.set(id, t);
    if (suspended) t.due = t.delay; // while suspended, `due` holds the time left
    else arm(id, t, t.delay);
    return id;
  };
  const clear = (id?: number) => {
    const t = id === undefined ? undefined : timers.get(id);
    if (!t) return;
    if (t.native !== undefined) native.clearTimeout(t.native);
    timers.delete(id!);
  };
  const raf = (cb: FrameRequestCallback) => {
    const id = next++;
    const f: { cb: FrameRequestCallback; native?: number } = { cb };
    frames.set(id, f);
    if (!suspended) armFrame(id, f);
    return id;
  };
  const armFrame = (id: number, f: { cb: FrameRequestCallback; native?: number }) => {
    f.native = native.requestAnimationFrame((ts) => { frames.delete(id); f.cb(ts); });
  };
  const caf = (id: number) => {
    const f = frames.get(id);
    if (!f) return;
    if (f.native !== undefined) native.cancelAnimationFrame(f.native);
    frames.delete(id);
  };
  const define = (name: string, value: unknown) => Object.defineProperty(w, name, { value, writable: true, configurable: true });
  define('setTimeout', add('timeout'));
  define('setInterval', add('interval'));
  define('clearTimeout', clear);
  define('clearInterval', clear);
  define('requestAnimationFrame', raf);
  define('cancelAnimationFrame', caf);

  return {
    native: { setTimeout: native.setTimeout, clearTimeout: native.clearTimeout, requestAnimationFrame: native.requestAnimationFrame, cancelAnimationFrame: native.cancelAnimationFrame } as CxEnv['native'],
    get suspended() { return suspended; },
    suspend() {
      if (suspended) return;
      suspended = true;
      const now = performance.now();
      for (const t of timers.values()) {
        if (t.native !== undefined) native.clearTimeout(t.native);
        t.native = undefined;
        // Remember what was left, so a timeout doesn't fire the moment the widget scrolls back.
        t.due = t.due - now;
      }
      for (const f of frames.values()) {
        if (f.native !== undefined) native.cancelAnimationFrame(f.native);
        f.native = undefined;
      }
    },
    resume() {
      if (!suspended) return;
      suspended = false;
      for (const [id, t] of timers) arm(id, t, Math.max(0, t.due));
      for (const [id, f] of frames) armFrame(id, f);
    },
  };
}

if (!globalThis.__cxEnv && typeof window !== 'undefined') {
  Object.defineProperty(globalThis, '__cxEnv', { value: install(), configurable: false, writable: false, enumerable: false });
}

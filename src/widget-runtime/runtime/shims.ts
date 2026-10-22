// Artifact habits that don't fit a sandboxed, content-sized frame (docs/WIDGETS-PLAN.md §2):
// in-memory storage, a network stub with a clear message, and window.innerHeight = the panel's viewport.

export const NETWORK_MESSAGE = "Widgets can't use the network. Import data as a file instead: import data from './data.json'.";

/** Web Storage in memory: an opaque-origin frame has none (the real getters throw SecurityError). */
class MemoryStorage {
  #items = new Map<string, string>();
  get length() { return this.#items.size; }
  key(i: number) { return [...this.#items.keys()][i] ?? null; }
  getItem(k: string) { return this.#items.get(String(k)) ?? null; }
  setItem(k: string, v: string) { this.#items.set(String(k), String(v)); }
  removeItem(k: string) { this.#items.delete(String(k)); }
  clear() { this.#items.clear(); }
}

function storage(): Storage {
  const s = new MemoryStorage();
  // Property access (`localStorage.foo = 'x'`, `localStorage['k']`) works on real Storage too.
  return new Proxy(s, {
    get(t, p) {
      if (typeof p === 'symbol' || p in t) { const v = Reflect.get(t, p, t); return typeof v === 'function' ? v.bind(t) : v; }
      return t.getItem(p) ?? undefined;
    },
    set(t, p, v) { if (typeof p === 'symbol' || p in t) return false; t.setItem(p, v); return true; },
    deleteProperty(t, p) { if (typeof p !== 'symbol') t.removeItem(p); return true; },
    has(t, p) { return p in t || (typeof p === 'string' && t.getItem(p) !== null); },
    ownKeys(t) { return Array.from({ length: t.length }, (_, i) => t.key(i)!); },
    getOwnPropertyDescriptor(t, p) {
      const v = typeof p === 'string' ? t.getItem(p) : null;
      return v === null ? undefined : { value: v, writable: true, enumerable: true, configurable: true };
    },
  }) as unknown as Storage;
}

export function installShims(opts: { viewportHeight: () => number; onNetwork: (what: string) => void }): void {
  const w = window as unknown as Record<string, unknown>;
  const define = (name: string, value: unknown) => Object.defineProperty(window, name, { value, configurable: true, writable: true });
  define('localStorage', storage());
  define('sessionStorage', storage());

  Object.defineProperty(window, 'innerHeight', { get: opts.viewportHeight, configurable: true });

  const refuse = (what: string) => { opts.onNetwork(what); return new TypeError(NETWORK_MESSAGE); };
  define('fetch', function fetch() { return Promise.reject(refuse('fetch')); });
  class XMLHttpRequest {
    static readonly UNSENT = 0; static readonly OPENED = 1; static readonly HEADERS_RECEIVED = 2; static readonly LOADING = 3; static readonly DONE = 4;
    readyState = 0; status = 0; responseText = ''; response = null;
    onload = null; onerror = null; onreadystatechange = null;
    open() { throw refuse('XMLHttpRequest'); }
    send() { throw refuse('XMLHttpRequest'); }
    setRequestHeader() {}
    abort() {}
    addEventListener() {}
    removeEventListener() {}
  }
  define('XMLHttpRequest', XMLHttpRequest);
  for (const name of ['WebSocket', 'EventSource', 'WebTransport']) {
    if (name in w) define(name, function Refused() { throw refuse(name); });
  }
  if ('sendBeacon' in navigator) Object.defineProperty(navigator, 'sendBeacon', { value: () => { refuse('sendBeacon'); return false; }, configurable: true });

  // Remote images, fonts and the like are blocked by the frame's CSP; say why, in the box.
  document.addEventListener('securitypolicyviolation', (e) => {
    if (/^(img|font|media|connect|default)-src/.test(e.effectiveDirective) && /^https?:|^wss?:/.test(e.blockedURI)) opts.onNetwork(e.effectiveDirective);
  });
}

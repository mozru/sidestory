// The module registry shared by the widget libraries, the runtime and widget code inside a widget frame.
// Each prebuilt library (dist/widget-libs/<id>.js, built by scripts/build-widget-libs.mjs) registers its
// modules here under the specifiers listed in src/shared/widget-imports.ts; the runtime's `require` reads it.

type Registry = Record<string, unknown>;

declare global {
  // eslint-disable-next-line no-var
  var __cxLibs: Registry | undefined;
}

export function registry(): Registry {
  return (globalThis.__cxLibs ??= Object.create(null) as Registry);
}

/**
 * Registers a module. ES module namespaces are copied into a plain object marked `__esModule`, so CommonJS
 * output (Sucrase's interop) reads `default` and named exports the way it would from a real ES module.
 * CommonJS libraries (React) are registered as their `module.exports`, as Node would give them.
 */
export function register(specifier: string, mod: unknown, esm: boolean): void {
  const r = registry();
  if (specifier in r) return;
  if (esm && mod && typeof mod === 'object') {
    const copy: Record<string, unknown> = Object.create(null);
    for (const k of Object.keys(mod)) copy[k] = (mod as Record<string, unknown>)[k];
    Object.defineProperty(copy, '__esModule', { value: true });
    r[specifier] = Object.freeze(copy);
  } else {
    r[specifier] = mod;
  }
}

/** Private registry keys (not importable specifiers) for things only the runtime uses. */
export const LUCIDE_FACTORY = 'cx:lucide';

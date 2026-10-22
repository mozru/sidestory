// Generates the data the widget compiler checks imports against, from the installed libraries:
// - exports.json: the export names of each library specifier (named-import checks, "did you mean").
// - lucide.json: every lucide-react icon's data ({name, size, node}, as lucide-react's createLucideIcon
//   takes it) by canonical name, plus the alias export names (XIcon, LucideX, renamed icons) → canonical.
// Run by scripts/build.mjs; also importable (tests generate into a temporary folder).
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Specifiers whose export lists come from node_modules. The SDK, UI shims and @/lib/utils are listed in src/shared/widget-imports.ts. */
const LIBRARY_SPECIFIERS = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', 'recharts', 'd3', 'motion/react', 'lodash', 'clsx', 'tailwind-merge'];

export interface LucideData {
  /** Export name → canonical icon name, for every export that isn't itself canonical. */
  aliases: Record<string, string>;
  icons: Record<string, unknown>;
}

async function exportNames(specifier: string): Promise<string[]> {
  const mod = (await import(specifier)) as Record<string, unknown>;
  const names = new Set(Object.keys(mod));
  // CommonJS packages: Node's static analysis of named exports can miss some; the object itself is the truth.
  const def = mod.default;
  if (def && (typeof def === 'object' || typeof def === 'function') && !('__esModule' in mod && mod.__esModule)) {
    for (const k of Object.keys(def)) names.add(k);
  }
  names.delete('module.exports');
  names.delete('__esModule');
  return [...names].sort();
}

async function lucideData(root: string): Promise<LucideData> {
  // The ESM build throughout, so components compare equal between the index and the icon modules.
  const req = createRequire(join(root, 'package.json'));
  const pkgDir = dirname(req.resolve('lucide-react/package.json'));
  const lr = (await import(pathToFileURL(join(pkgDir, 'dist/esm/lucide-react.mjs')).href)) as Record<string, unknown> & { icons: Record<string, unknown> };
  const canonicalOf = new Map<unknown, string>(Object.entries(lr.icons).map(([name, component]) => [component, name]));
  const aliases: Record<string, string> = {};
  for (const [name, value] of Object.entries(lr)) {
    const canonical = canonicalOf.get(value);
    if (canonical && canonical !== name) aliases[name] = canonical;
  }
  // Icon data lives in each icon's own module (`__iconData`), next to the component it creates.
  const iconsDir = join(pkgDir, 'dist/esm/icons');
  const icons: Record<string, unknown> = {};
  for (const file of readdirSync(iconsDir).filter((f) => f.endsWith('.mjs')).sort()) {
    const m = (await import(pathToFileURL(join(iconsDir, file)).href)) as { default?: unknown; __iconData?: unknown };
    const canonical = canonicalOf.get(m.default);
    if (canonical && m.__iconData && !(canonical in icons)) icons[canonical] = m.__iconData;
  }
  const missing = Object.keys(lr.icons).filter((n) => !(n in icons));
  if (missing.length) throw new Error(`lucide-react: no icon data for ${missing.slice(0, 5).join(', ')}`);
  return { aliases, icons };
}

/** Writes exports.json and lucide.json into `outDir`; returns their sizes in bytes. */
export async function generateWidgetData(outDir: string, root = process.cwd()): Promise<{ exports: number; lucide: number }> {
  mkdirSync(outDir, { recursive: true });
  const exports: Record<string, string[]> = {};
  for (const s of LIBRARY_SPECIFIERS) exports[s] = await exportNames(s);
  const lucide = await lucideData(root);
  const e = JSON.stringify(exports);
  const l = JSON.stringify(lucide);
  writeFileSync(join(outDir, 'exports.json'), e);
  writeFileSync(join(outDir, 'lucide.json'), l);
  return { exports: e.length, lucide: l.length };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const out = process.argv[2] ?? 'dist/widget-data';
  console.log(await generateWidgetData(out));
}

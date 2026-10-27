// The widget compiler proper (docs/WIDGETS-PLAN.md §2, §3 "Compile", §5.2): resolves a widget's import
// closure inside its explainer folder, transforms and checks each module, and assembles what the widget
// runtime loads. Runs inside the compile worker (compile-worker.ts); compile.ts is the host side.
import { createHash } from 'node:crypto';
import { constants, readFileSync } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  EXPLAINER_SDK_EXPORTS,
  LIB_UTILS_EXPORTS,
  UI_COMPONENT_EXPORTS,
  UI_COMPONENTS,
  UNAVAILABLE_IMPORTS,
  WIDGET_ALIASES,
  WIDGET_LIBRARIES,
  libraryFor,
} from '../../shared/widget-imports.ts';
import { SizeLru } from '../lru.ts';
import { realPathInside } from '../paths.ts';
import { analyzeSource, finishModule, type ModuleAnalysis } from './analyze.ts';
import { isSecretFileName, isSecretPath } from './secret-files.ts';
import { ALLOWED_EXTENSIONS, candidatesFor, extensionOf, isRelativeSpecifier, kindOf, lexicalProblem, normalizeEntry, resolveRelative, type FileKind } from './specifiers.ts';
import { didYouMean } from './suggest.ts';
import type { CompileResult, Diag } from './types.ts';

export const LIMITS = {
  /** Source and JSON bytes in one widget's import closure. */
  totalSourceBytes: 1_000_000,
  files: 50,
  imageBytes: 1_000_000,
  totalImageBytes: 5_000_000,
} as const;

/** Bumped whenever compiler output changes, so cached results from an older compiler aren't reused. */
const COMPILER_VERSION = '1';

const IMAGE_MIME: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
};

const UI_PREFIX = '@/components/ui/';

/** Every specifier a widget may import, for "did you mean". */
const ALLOWED_SPECIFIERS = [
  ...WIDGET_LIBRARIES.flatMap((l) => l.specifiers),
  ...Object.keys(WIDGET_ALIASES),
  'lucide-react',
  ...UI_COMPONENTS.map((c) => UI_PREFIX + c),
];

interface LucideData {
  aliases: Record<string, string>;
  icons: Record<string, unknown>;
}

export interface CoreOptions {
  /** Folder holding exports.json and lucide.json (scripts/widget-data.ts). */
  dataDir?: string;
  /** Bound on the cache of transformed modules, in bytes (default 20 MB). */
  cacheBytes?: number;
}

interface Loaded {
  key: string;
  kind: FileKind;
  bytes: Uint8Array;
  analysis?: ModuleAnalysis;
  analysisKey?: string;
  /** CommonJS code for JSON and images (source modules are finished later). */
  code?: string;
}

const sha256 = (...parts: (string | Uint8Array)[]) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest('hex');
};

export function packageRoot(spec: string): string {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

/** Library ids in load order: dependencies first, in declaration order, then 'tailwind' and 'runtime'. */
export function orderLibraries(used: Iterable<string>): string[] {
  const byId = new Map(WIDGET_LIBRARIES.map((l) => [l.id, l]));
  const out: string[] = [];
  const place = (id: string) => {
    if (out.includes(id)) return;
    for (const d of byId.get(id)?.deps ?? []) place(d);
    out.push(id);
  };
  const want = new Set(used);
  for (const l of WIDGET_LIBRARIES) if (want.has(l.id) && l.id !== 'tailwind' && l.id !== 'runtime') place(l.id);
  for (const d of [...(byId.get('tailwind')?.deps ?? []), ...(byId.get('runtime')?.deps ?? [])]) place(d);
  place('tailwind');
  place('runtime');
  return out;
}

export class WidgetCompilerCore {
  readonly cache: SizeLru<ModuleAnalysis | string>;
  private exportsData: Record<string, string[]> | null | undefined;
  private lucideData: LucideData | null | undefined;

  private readonly opts: CoreOptions;

  constructor(opts: CoreOptions = {}) {
    this.opts = opts;
    this.cache = new SizeLru(opts.cacheBytes ?? 20_000_000);
  }

  private loadJson<T>(name: string): T | null {
    if (!this.opts.dataDir) return null;
    try {
      return JSON.parse(readFileSync(join(this.opts.dataDir, name), 'utf8')) as T;
    } catch {
      return null;
    }
  }

  /** Export names of a library specifier (after aliases), or undefined when they aren't known (no check). */
  private exportsOf(spec: string): readonly string[] | undefined {
    if (spec === 'explainer') return EXPLAINER_SDK_EXPORTS;
    if (spec === '@/lib/utils') return LIB_UTILS_EXPORTS;
    if (spec.startsWith(UI_PREFIX)) return UI_COMPONENT_EXPORTS[spec.slice(UI_PREFIX.length) as keyof typeof UI_COMPONENT_EXPORTS];
    if (this.exportsData === undefined) this.exportsData = this.loadJson('exports.json');
    return this.exportsData?.[spec];
  }

  private lucide(): LucideData | null {
    if (this.lucideData === undefined) this.lucideData = this.loadJson<LucideData>('lucide.json');
    return this.lucideData ?? null;
  }

  async compile(explainerDir: string, src: string): Promise<CompileResult> {
    const errors: Diag[] = [];
    const warnings: Diag[] = [];
    const entry = normalizeEntry(src);
    const empty = (e: Diag): CompileResult => ({ entry: entry.ok ? entry.key : '', modules: {}, libraries: [], icons: {}, warnings: [], errors: [e], hash: '', files: [] });
    const shownSrc = JSON.stringify(src.slice(0, 200));
    if (!entry.ok) return empty({ file: 'sidestory.html', code: entry.code, message: `Widget src ${shownSrc}: ${entry.message}.` });

    let root: string;
    try {
      root = await realpath(explainerDir);
    } catch {
      return empty({ file: 'sidestory.html', code: 'not-found', message: "The sidestory folder can't be read." });
    }

    const loaded = new Map<string, Loaded>();
    let sourceBytes = 0;
    let imageBytes = 0;
    let stopped = false;
    const libs = new Set<string>();
    const icons: Record<string, unknown> = {};
    /** Per module: specifier literal start → rewritten specifier. */
    const rewrites = new Map<string, Map<number, string>>();
    /** Relative imports to check once every module is loaded. */
    const relativeNames: { from: string; to: string; spec: string; names: { name: string; line: number; column?: number }[] }[] = [];

    /** Reads a file in the folder with every check; returns an error message instead when it's refused. */
    const read = async (key: string, kind: FileKind): Promise<Uint8Array | { code: string; message: string }> => {
      if (isSecretPath(key)) return { code: 'secret-file', message: 'files with secret-looking names (.env, *.key, credentials.json, …) are never given to widgets; rename the file' };
      const abs = join(root, ...key.split('/'));
      const real = await realPathInside(abs, root);
      if (!real) {
        const exists = await lstat(abs).then(() => true, () => false);
        return exists ? { code: 'outside-folder', message: 'the file is a link to somewhere outside the sidestory folder' } : { code: 'not-found', message: 'no such file' };
      }
      if (isSecretFileName(basename(real))) return { code: 'secret-file', message: 'the file links to a file with a secret-looking name; widgets never get those' };
      const max = kind === 'image' ? LIMITS.imageBytes : LIMITS.totalSourceBytes - sourceBytes;
      // Not a regular file (a FIFO would block open() forever): refused before opening, and opened without
      // blocking in case it is swapped in between.
      if (!(await stat(real).then((s) => s.isFile(), () => false))) return { code: 'not-found', message: 'not a file' };
      const handle = await open(real, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
      try {
        const st = await handle.stat();
        if (!st.isFile()) return { code: 'not-found', message: 'not a file' };
        if (kind === 'image' && st.size > LIMITS.imageBytes) return { code: 'too-large', message: `images imported by widgets must be at most ${LIMITS.imageBytes / 1e6} MB` };
        if (kind === 'image' && imageBytes + st.size > LIMITS.totalImageBytes) return { code: 'too-large', message: `a widget's images may total at most ${LIMITS.totalImageBytes / 1e6} MB` };
        if (kind !== 'image' && st.size > max) return { code: 'too-large', message: `a widget's code and data may total at most ${LIMITS.totalSourceBytes / 1e6} MB` };
        const buf = Buffer.alloc(st.size);
        let off = 0;
        while (off < st.size) {
          const { bytesRead } = await handle.read(buf, off, st.size - off, off);
          if (bytesRead === 0) break;
          off += bytesRead;
        }
        return new Uint8Array(buf.buffer, buf.byteOffset, off);
      } finally {
        await handle.close();
      }
    };

    /** The first existing candidate for a resolved key, as a folder-relative key. */
    const probe = async (key: string): Promise<string | undefined> => {
      for (const c of candidatesFor(key)) {
        const st = await lstat(join(root, ...c.split('/'))).catch(() => undefined);
        if (st && !st.isDirectory()) return c;
      }
      return undefined;
    };

    const load = async (key: string, at: Diag): Promise<boolean> => {
      if (loaded.has(key)) return true;
      if (stopped) return false;
      if (loaded.size >= LIMITS.files) {
        errors.push({ ...at, code: 'too-many-files', message: `A widget may use at most ${LIMITS.files} files.` });
        stopped = true;
        return false;
      }
      const kind = kindOf(key)!;
      let bytes: Uint8Array | { code: string; message: string };
      try {
        bytes = await read(key, kind);
      } catch {
        bytes = { code: 'not-found', message: "the file can't be read" };
      }
      if (!(bytes instanceof Uint8Array)) {
        errors.push({ ...at, code: bytes.code, message: `${at.message}: ${bytes.message}.` });
        if (bytes.code === 'too-large') stopped = true;
        return false;
      }
      const rec: Loaded = { key, kind, bytes };
      loaded.set(key, rec);
      if (kind === 'image') {
        imageBytes += bytes.byteLength;
        rec.code = `module.exports = ${JSON.stringify(`data:${IMAGE_MIME[extensionOf(key)]};base64,${Buffer.from(bytes).toString('base64')}`)};`;
        return true;
      }
      sourceBytes += bytes.byteLength;
      const text = new TextDecoder().decode(bytes);
      if (kind === 'json') {
        const json = text.replace(/^﻿/, '');
        try {
          JSON.parse(json);
        } catch (e) {
          errors.push({ file: key, code: 'invalid-json', message: `Not valid JSON: ${(e as Error).message}` });
        }
        // JSON.parse at run time: an object literal would treat a "__proto__" key as the prototype.
        rec.code = `module.exports = JSON.parse(${JSON.stringify(json)});`;
        return true;
      }
      rec.analysisKey = sha256('analysis\0', COMPILER_VERSION, '\0', key, '\0', bytes);
      let analysis = this.cache.get(rec.analysisKey) as ModuleAnalysis | undefined;
      if (!analysis) {
        analysis = analyzeSource(key, text);
        this.cache.set(rec.analysisKey, analysis, analysis.code.length * 2 + 1000);
      }
      rec.analysis = analysis;
      errors.push(...analysis.errors);
      warnings.push(...analysis.warnings);
      await this.checkImports(rec, load, probe, errors, libs, icons, rewrites, relativeNames);
      return true;
    };

    const ok = await load(entry.key, { file: 'sidestory.html', code: '', message: `Widget src ${shownSrc}` });

    if (ok) {
      // Named imports between the widget's own modules.
      for (const r of relativeNames) {
        const target = loaded.get(r.to);
        if (!target) continue;
        if (target.kind === 'image') {
          for (const n of r.names) if (n.name !== 'default') errors.push({ file: r.from, line: n.line, column: n.column, code: 'unknown-export', message: `'${r.spec}' is an image; import it as a default import (import url from '${r.spec}').` });
        }
        const a = target.analysis;
        if (!a || a.exportStar || a.errors.length) continue;
        for (const n of r.names) {
          if (a.exports.includes(n.name)) continue;
          errors.push({
            file: r.from,
            line: n.line,
            column: n.column,
            code: 'unknown-export',
            message: n.name === 'default' ? `'${r.spec}' has no default export.` : `'${r.spec}' has no export named '${n.name}'.${didYouMean(n.name, a.exports.filter((e) => e !== 'default'))}`,
          });
        }
      }
      const e = loaded.get(entry.key)?.analysis;
      if (e && !e.errors.length && !e.exportStar && !e.exports.includes('default')) {
        errors.push({ file: entry.key, code: 'no-default-export', message: 'A widget file must export its component as the default export (export default function MyWidget() { … }).' });
      }
    }

    const modules: Record<string, string> = {};
    for (const rec of loaded.values()) {
      if (rec.code !== undefined) {
        modules[rec.key] = rec.code;
        continue;
      }
      const a = rec.analysis!;
      if (a.errors.length) continue;
      const rw = rewrites.get(rec.key) ?? new Map<number, string>();
      const finishKey = sha256('finish\0', rec.analysisKey!, JSON.stringify([...rw]));
      let code = this.cache.get(finishKey) as string | undefined;
      if (code === undefined) {
        const r = finishModule(rec.key, a, rw);
        if ('error' in r) {
          errors.push(r.error);
          continue;
        }
        code = r.code;
        this.cache.set(finishKey, code, code.length * 2 + 100);
      }
      modules[rec.key] = code;
    }

    const files = [...loaded.keys()].sort();
    const h = createHash('sha256');
    for (const f of files) {
      const b = loaded.get(f)!.bytes;
      h.update(`${f}\0${b.byteLength}\0`);
      h.update(b);
    }
    return {
      entry: entry.key,
      modules,
      libraries: orderLibraries(libs),
      icons,
      warnings,
      errors,
      hash: files.length ? h.digest('hex') : '',
      files,
    };
  }

  private async checkImports(
    rec: Loaded,
    load: (key: string, at: Diag) => Promise<boolean>,
    probe: (key: string) => Promise<string | undefined>,
    errors: Diag[],
    libs: Set<string>,
    icons: Record<string, unknown>,
    rewrites: Map<string, Map<number, string>>,
    relativeNames: { from: string; to: string; spec: string; names: { name: string; line: number; column?: number }[] }[],
  ): Promise<void> {
    const file = rec.key;
    const rw = new Map<number, string>();
    rewrites.set(file, rw);
    for (const site of rec.analysis!.imports) {
      const at = { file, line: site.line, column: site.column };
      const spec = site.spec;
      if (!isRelativeSpecifier(spec)) {
        const problem = lexicalProblem(spec);
        if (problem) {
          errors.push({ ...at, code: problem.code, message: `Can't import '${spec}': ${problem.message}.` });
          continue;
        }
      } else {
        const r = resolveRelative(file, spec);
        if (!r.ok) {
          errors.push({ ...at, code: r.code, message: `Can't import '${spec}': ${r.message}.` });
          continue;
        }
        const found = await probe(r.key);
        if (!found) {
          const ext = extensionOf(r.key);
          errors.push(
            ext && !kindOf(r.key) && !r.key.endsWith('/')
              ? { ...at, code: 'bad-extension', message: `Can't import '${spec}': widgets can import ${ALLOWED_EXTENSIONS.join(', ')} files.` }
              : { ...at, code: 'not-found', message: `Can't import '${spec}': no such file in the sidestory folder.` },
          );
          continue;
        }
        if (!(await load(found, { ...at, code: '', message: `Can't import '${spec}'` }))) continue;
        rw.set(site.start, found);
        if (site.names.length) relativeNames.push({ from: file, to: found, spec, names: site.names });
        continue;
      }

      const lib = libraryFor(spec);
      if (!lib) {
        const root = packageRoot(spec);
        const unavailable = UNAVAILABLE_IMPORTS[spec] ?? UNAVAILABLE_IMPORTS[root];
        if (unavailable) errors.push({ ...at, code: 'unavailable-import', message: `'${spec}': ${unavailable}` });
        else if (spec.startsWith('@radix-ui/')) errors.push({ ...at, code: 'unavailable-import', message: `'${spec}': Radix isn't available; use the shadcn-style components from @/components/ui/* (${UI_COMPONENTS.join(', ')}).` });
        else if (spec.startsWith(UI_PREFIX)) {
          errors.push({ ...at, code: 'unknown-import', message: `'${spec}' isn't one of the provided components (${UI_COMPONENTS.join(', ')}).${didYouMean(spec.slice(UI_PREFIX.length), UI_COMPONENTS)}` });
        } else {
          errors.push({ ...at, code: 'unknown-import', message: `'${spec}' can't be imported in a widget.${didYouMean(spec, ALLOWED_SPECIFIERS) || ' Widgets can import react, recharts, d3, motion/react, lucide-react, lodash, clsx, tailwind-merge, @/components/ui/*, @/lib/utils and explainer (the widget helpers), plus files in the sidestory folder.'}` });
        }
        continue;
      }
      libs.add(lib);
      const canonical = WIDGET_ALIASES[spec] ?? spec;
      if (canonical !== spec) rw.set(site.start, canonical);

      if (canonical === 'lucide-react') {
        this.checkLucide(file, site, errors, icons);
        continue;
      }
      const exported = this.exportsOf(canonical);
      if (!exported) continue;
      for (const n of site.names) {
        if (exported.includes(n.name)) continue;
        if (n.name === 'default') {
          errors.push({ file, line: n.line, column: n.column, code: 'unknown-export', message: `'${spec}' has no default export; use named imports, or import * as name from '${spec}'.` });
        } else {
          errors.push({ file, line: n.line, column: n.column, code: 'unknown-export', message: `'${spec}' has no export named '${n.name}'.${didYouMean(n.name, exported)}` });
        }
      }
    }
  }

  private checkLucide(file: string, site: ModuleAnalysis['imports'][number], errors: Diag[], icons: Record<string, unknown>): void {
    const at = { file, line: site.line, column: site.column };
    if (site.namespace) {
      errors.push({ ...at, code: 'lucide-namespace', message: "Import lucide icons by name (import { Activity } from 'lucide-react'), so only the icons used are sent to the widget." });
      return;
    }
    const data = this.lucide();
    if (!data) {
      errors.push({ ...at, code: 'internal', message: 'Lucide icon data is missing from this build of Sidestory.' });
      return;
    }
    for (const n of site.names) {
      const canonical = Object.hasOwn(data.icons, n.name) ? n.name : Object.hasOwn(data.aliases, n.name) ? data.aliases[n.name]! : undefined;
      if (canonical) {
        icons[n.name] = data.icons[canonical];
        continue;
      }
      const msg =
        n.name === 'default'
          ? "lucide-react has no default export; import icons by name (import { Activity } from 'lucide-react')."
          : `lucide-react has no icon named '${n.name}'.${didYouMean(n.name, iconNames(data))}`;
      errors.push({ file, line: n.line, column: n.column, code: 'unknown-export', message: msg });
    }
  }
}

const iconNameLists = new WeakMap<LucideData, string[]>();
function iconNames(d: LucideData): string[] {
  let names = iconNameLists.get(d);
  if (!names) iconNameLists.set(d, (names = [...Object.keys(d.icons), ...Object.keys(d.aliases)]));
  return names;
}

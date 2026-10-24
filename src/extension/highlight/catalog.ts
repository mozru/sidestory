// Grammars from the installed extensions (docs/HIGHLIGHT-PLAN.md §10): which grammar a code block's language
// name picks, and the files a grammar needs. Pure: extensions are given as plain data and files are read
// through an injected reader, so this is unit-tested without VS Code.
import { createHash } from 'node:crypto';
import { resolveInside, type ThemeReader } from './theme.ts';

/** What the catalog needs to know about an installed extension. */
export interface ExtensionInfo {
  /** `publisher.name`, for logs. */
  id: string;
  /** The extension folder's URI (`file:///…/ext`), no trailing slash needed. */
  root: string;
  /** VS Code's own extensions come first, so a reader's grammar for the same language wins. */
  builtin: boolean;
  /** `packageJSON.contributes`, unvalidated. */
  contributes: unknown;
}

export interface GrammarEntry {
  scopeName: string;
  /** The grammar file, inside `root`. */
  uri: string;
  root: string;
  format: 'json' | 'plist';
  extension: string;
}

/** A grammar file as the worker gets it: the text is parsed there. */
export interface GrammarFile {
  scopeName: string;
  format: 'json' | 'plist';
  text: string;
}

/** What one scope's grammar needs: its files (it first) and the injections into those scopes. */
export interface GrammarSet {
  files: GrammarFile[];
  injections: [string, string[]][];
}

export const MAX_GRAMMAR_FILE = 4 * 1024 * 1024;
export const MAX_GRAMMAR_SET_BYTES = 12 * 1024 * 1024;
export const MAX_GRAMMAR_SET_FILES = 128;
const MAX_SCOPE = 256;
const MAX_NAMES_PER_LANGUAGE = 200;

/** Fence names people write that VS Code has no alias or extension for, → VS Code language ids. */
const FENCE_NAMES: ReadonlyMap<string, string> = new Map([
  ['python3', 'python'], ['py3', 'python'],
  ['golang', 'go'],
  ['node', 'javascript'],
  ['shell', 'shellscript'], ['console', 'shellscript'], ['shell-session', 'shellscript'],
  ['make', 'makefile'],
  ['json5', 'jsonc'],
]);

const SCOPE = /^[^\s\0]{1,256}$/;

function str(v: unknown, max = MAX_SCOPE): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined;
}

function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v.slice(0, 10_000) : [];
}

function formatOf(path: string): GrammarEntry['format'] | undefined {
  const p = path.toLowerCase();
  if (p.endsWith('.json')) return 'json';
  if (p.endsWith('.tmlanguage') || p.endsWith('.plist') || p.endsWith('.tmgrammar')) return 'plist';
  return undefined;
}

export class GrammarCatalog {
  /** Scope name → its grammar (the last contribution wins). */
  private readonly grammars = new Map<string, GrammarEntry>();
  /** Language id → the scope of its grammar. */
  private readonly languageScope = new Map<string, string>();
  /** Lower-case names → language id, by how they name it. */
  private readonly ids = new Map<string, string>();
  private readonly aliases = new Map<string, string>();
  private readonly fileExtensions = new Map<string, string>();
  /** Scope → scopes injected into it. */
  private readonly injectors = new Map<string, string[]>();
  /** Changes whenever what the catalog would load changes. */
  readonly key: string;

  constructor(extensions: readonly ExtensionInfo[]) {
    const hash = createHash('sha256');
    const ordered = [...extensions.filter((e) => e.builtin), ...extensions.filter((e) => !e.builtin)];
    for (const ext of ordered) {
      const c = ext.contributes as { languages?: unknown; grammars?: unknown } | undefined;
      if (!c || typeof c !== 'object') continue;
      for (const l of list(c.languages) as { id?: unknown; aliases?: unknown; extensions?: unknown }[]) {
        const id = l && str(l.id, 128);
        if (!id) continue;
        this.ids.set(id.toLowerCase(), id);
        for (const a of list(l.aliases).slice(0, MAX_NAMES_PER_LANGUAGE)) {
          const name = str(a, 128);
          if (name) this.aliases.set(name.toLowerCase(), id);
        }
        for (const e of list(l.extensions).slice(0, MAX_NAMES_PER_LANGUAGE)) {
          const name = str(e, 128);
          if (name?.startsWith('.') && name.length > 1) this.fileExtensions.set(name.slice(1).toLowerCase(), id);
        }
      }
      const root = ext.root.endsWith('/') ? ext.root : `${ext.root}/`;
      for (const g of list(c.grammars) as { scopeName?: unknown; path?: unknown; language?: unknown; injectTo?: unknown }[]) {
        const scopeName = g && str(g.scopeName);
        const path = g && str(g.path, 1024);
        if (!scopeName || !SCOPE.test(scopeName) || !path) continue;
        const format = formatOf(path);
        const uri = format && resolveInside(path.replace(/^\.\//, ''), root, root);
        if (!format || !uri) continue;
        this.grammars.set(scopeName, { scopeName, uri, root, format, extension: ext.id });
        const language = str(g.language, 128);
        if (language) this.languageScope.set(language, scopeName);
        for (const t of list(g.injectTo).slice(0, MAX_NAMES_PER_LANGUAGE)) {
          const target = str(t);
          if (!target) continue;
          const into = this.injectors.get(target) ?? [];
          if (!into.includes(scopeName)) into.push(scopeName);
          this.injectors.set(target, into);
        }
        hash.update(`${scopeName}\0${uri}\0${language ?? ''}\0${list(g.injectTo).join(',')}\n`);
      }
    }
    // Names change which grammar a block gets, so they're part of the key too.
    for (const m of [this.ids, this.aliases, this.fileExtensions]) for (const [k, v] of m) hash.update(`${k}=${v}\n`);
    this.key = hash.digest('base64url').slice(0, 16);
  }

  /** The scope of the grammar a code block's language name picks, or undefined (the block stays plain). */
  scopeFor(name: string): string | undefined {
    const n = name.trim().toLowerCase();
    for (const id of [this.ids.get(n), this.aliases.get(n), this.fileExtensions.get(n), FENCE_NAMES.get(n)]) {
      const scope = id === undefined ? undefined : this.languageScope.get(id);
      if (scope && this.grammars.has(scope)) return scope;
    }
    return undefined;
  }

  grammar(scope: string): GrammarEntry | undefined {
    return this.grammars.get(scope);
  }

  injectorsOf(scope: string): readonly string[] {
    return this.injectors.get(scope) ?? [];
  }

  get size(): number {
    return this.grammars.size;
  }
}

/** Scopes a grammar's text includes (`source.js`, `text.html.basic#tags` → `text.html.basic`), found without parsing it. */
export function includedScopes(text: string, format: GrammarEntry['format']): string[] {
  const re = format === 'json' ? /"include"\s*:\s*"((?:[^"\\]|\\.){1,512})"/g : /<key>\s*include\s*<\/key>\s*<string>([^<]{1,512})<\/string>/g;
  const out = new Set<string>();
  for (const m of text.matchAll(re)) {
    const ref = m[1]!;
    if (ref.startsWith('#') || ref.startsWith('$')) continue;
    const scope = ref.split('#')[0]!;
    if (scope && SCOPE.test(scope)) out.add(scope);
  }
  return [...out];
}

/**
 * Reads one scope's grammar and everything it needs (includes and injections, breadth first, within the caps:
 * what doesn't fit is left out and stays uncolored). Undefined when the scope's own grammar can't be read.
 */
export async function loadGrammarSet(catalog: GrammarCatalog, scope: string, reader: ThemeReader, log?: (m: string) => void): Promise<GrammarSet | undefined> {
  if (!catalog.grammar(scope)) return undefined;
  const files: GrammarFile[] = [];
  const injections = new Map<string, string[]>();
  const seen = new Set<string>([scope]);
  const queue = [scope];
  let bytes = 0;
  while (queue.length && files.length < MAX_GRAMMAR_SET_FILES) {
    const s = queue.shift()!;
    const g = catalog.grammar(s);
    if (!g) continue;
    const text = (await reader.inside(g.uri, g.root)) ? await reader.read(g.uri, MAX_GRAMMAR_FILE) : undefined;
    if (text === undefined || text.length > MAX_GRAMMAR_FILE || bytes + text.length > MAX_GRAMMAR_SET_BYTES) {
      if (s === scope) return undefined;
      log?.(`Code block colors: skipped the grammar ${s} from ${g.extension} (unreadable, outside its extension, or over the size limits).`);
      continue;
    }
    bytes += text.length;
    files.push({ scopeName: s, format: g.format, text });
    const injectors = catalog.injectorsOf(s).filter((i) => catalog.grammar(i));
    if (injectors.length) injections.set(s, [...injectors]);
    for (const next of [...includedScopes(text, g.format), ...injectors]) {
      if (seen.has(next) || !catalog.grammar(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return { files, injections: [...injections] };
}

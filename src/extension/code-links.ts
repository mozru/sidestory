// Code links without an anchor, in the extension host (docs/AUTHORING-PLAN.md §8.1, §8.2): `data-explain-code`
// targets resolved against documents, the checks an `openCode` request passes before anything opens, and the
// symbol tables cursor lighting and clicks share.
//
//   (from code-paths.ts, which the checker shares: OpenCodeGate, checkCodePath, matchProviderSymbol)
//   SymbolTables      SV symbol tables per (document, version): scanned in slices, abandoned for a newer version,
//                     and for files over 1 MB only after 1 s without edits (§4.3)
//   resolveLink       a link's line range in an open document: lines, a symbol (SV scanner, or the language's
//                     symbol provider when allowed), or the whole file
import * as vscode from 'vscode';
import { basename } from 'node:path';
import type { LineRange } from '../core/manifest.ts';
import { findSvSymbol, isSvPath, scanSvSliced, type SymbolTable } from '../core/symbols/sv.ts';
import { parseCodeTarget, type CodeLink } from '../shared/code-link.ts';
import { matchProviderSymbol, type LinkResolution, type ProviderSymbol } from './code-paths.ts';
import { MAX_CODE_BYTES } from './explainers.ts';

export { checkCodePath, matchProviderSymbol, OpenCodeGate, type LinkResolution, type PathCheck } from './code-paths.ts';

/** Symbol providers get this long; then the symbol counts as unavailable. */
export const PROVIDER_TIMEOUT_MS = 2000;
/** SV files larger than this are scanned only after they've been left alone for IDLE_MS. */
export const LARGE_FILE_CHARS = 1_000_000;
export const IDLE_MS = 1000;
const SLICE_MS = 15;
const pause = () => new Promise<void>((r) => setImmediate(r));

/** Symbol tables for open SV documents, one per (document, version), shared by lighting and clicks. */
export class SymbolTables implements vscode.Disposable {
  private readonly cache = new Map<string, { version: number; table: Promise<SymbolTable | undefined> }>();
  private readonly editedAt = new Map<string, number>();
  private readonly sub: vscode.Disposable;
  private disposed = false;
  private readonly max: number;

  constructor(max = 8) {
    this.max = max;
    this.sub = vscode.workspace.onDidChangeTextDocument((e) => {
      const key = e.document.uri.toString();
      // Only documents we've scanned: one map lookup per edit anywhere.
      if (this.cache.has(key)) this.editedAt.set(key, Date.now());
    });
  }

  /** The table for this version of the document; undefined when it's too large, or a newer version took over. */
  get(doc: vscode.TextDocument): Promise<SymbolTable | undefined> {
    const key = doc.uri.toString();
    const hit = this.cache.get(key);
    if (hit && hit.version === doc.version) return hit.table;
    const version = doc.version;
    const stale = () => this.disposed || doc.isClosed || doc.version !== version;
    const table = (async () => {
      const text = doc.getText();
      if (text.length > MAX_CODE_BYTES) return undefined;
      // A large file being edited is scanned once the edits stop (§4.3).
      if (text.length > LARGE_FILE_CHARS) {
        for (;;) {
          const wait = (this.editedAt.get(key) ?? 0) + IDLE_MS - Date.now();
          if (wait <= 0) break;
          await new Promise((r) => setTimeout(r, wait));
          if (stale()) return undefined;
        }
      }
      return scanSvSliced(text, { sliceMs: SLICE_MS, stop: stale, pause });
    })();
    this.cache.delete(key);
    this.cache.set(key, { version, table });
    while (this.cache.size > this.max) this.cache.delete(this.cache.keys().next().value!);
    return table;
  }

  dispose(): void {
    this.disposed = true;
    this.sub.dispose();
    this.cache.clear();
  }
}

const MAX_PROVIDER_SYMBOLS = 20_000;

/** The language's own symbols for an open document (`vscode.executeDocumentSymbolProvider`), within 2 s. */
async function providerSymbols(uri: vscode.Uri): Promise<ProviderSymbol[] | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), PROVIDER_TIMEOUT_MS)));
  try {
    const result = await Promise.race([Promise.resolve(vscode.commands.executeCommand<unknown[]>('vscode.executeDocumentSymbolProvider', uri)).catch(() => undefined), timeout]);
    if (!Array.isArray(result)) return undefined;
    const out: ProviderSymbol[] = [];
    const lines = (r: vscode.Range): LineRange => ({ start: r.start.line + 1, end: r.end.line + 1 });
    const walk = (s: Record<string, unknown>, chain: string[]) => {
      if (out.length >= MAX_PROVIDER_SYMBOLS || typeof s.name !== 'string') return;
      if (s.location && typeof s.location === 'object') {
        // SymbolInformation: flat, with a container name
        const container = typeof s.containerName === 'string' && s.containerName ? s.containerName.split('.') : [];
        out.push({ chain: [...container, s.name], range: lines((s.location as vscode.Location).range) });
        return;
      }
      const next = [...chain, s.name];
      if (s.range) out.push({ chain: next, range: lines(s.range as vscode.Range) });
      if (Array.isArray(s.children) && chain.length < 32) for (const c of s.children) walk(c as Record<string, unknown>, next);
    };
    for (const s of result) walk(s as Record<string, unknown>, []);
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Where a link points in an open document. Non-SV symbols ask the language's symbol provider only when
 * `provider` is true: it opens the document and wakes language servers, so that's for a click, or a document the
 * reader already has open (§8.1, §10.4).
 */
export async function resolveLink(doc: vscode.TextDocument, link: CodeLink, tables: SymbolTables, provider: boolean): Promise<LinkResolution> {
  if (link.target === undefined) return { ok: true, range: { start: 1, end: Math.max(1, doc.lineCount) } };
  const t = parseCodeTarget(link.target);
  if (!t) return { ok: false, message: `\`${link.target}\` isn't a line range or a symbol` };
  if (t.kind === 'lines') {
    if (t.start > doc.lineCount) return { ok: false, message: `line ${t.start} is past the end (${doc.lineCount} lines)` };
    return { ok: true, range: { start: t.start, end: Math.min(t.end, doc.lineCount) } };
  }
  if (isSvPath(doc.uri.path, doc.languageId)) {
    const table = await tables.get(doc);
    if (!table) return { ok: false, message: 'the file is too large to search, or changed meanwhile', unavailable: true };
    const r = findSvSymbol(table, t.path);
    return r.ok ? { ok: true, range: r.extent } : { ok: false, message: r.message.replace(/\.$/, '') };
  }
  if (!provider) return { ok: false, message: 'symbols in this language are found when the link is clicked', unavailable: true };
  const symbols = await providerSymbols(doc.uri);
  if (!symbols) return { ok: false, message: `no symbols for ${basename(doc.uri.path)} (no language support for it, or it took too long)`, unavailable: true };
  return matchProviderSymbol(symbols, t.path);
}

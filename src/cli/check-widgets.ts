// The standalone widget checker (docs/WIDGETS-PLAN.md §2 "Checking"), bundled as dist/check.cjs:
//
//   node <extension>/dist/check.cjs <explainer-dir> [--json] [--pin [--yes-widgets-may-read]]
//
// Finds explainer.html's <explain-widget> elements, compiles each with the extension's widget compiler,
// validates their props, checks the anchor ids widget code names against manifest.json, reports anchors
// read through useAnchorCode that widgets won't get (not pinned, secret-looking files …) and placement
// problems visible in the HTML and CSS. Prints `file:line: severity code: message`; exits 1 on errors.
// Runs nothing from the repository (compiling isn't running), so it needs no consent.
//
// --pin records each anchor's current code from the files on disk, as "Pin Anchors" does, never for
// secret-looking files, and never for anchors widgets read unless --yes-widgets-may-read is given: those
// let widgets read the code, so the user decides (docs/WIDGETS.md, "Checking your work").
import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parse, type Node } from 'acorn';
import { simple } from 'acorn-walk';
import { parseManifest, type Anchor, type LineRange, type Manifest } from '../core/manifest.ts';
import { pinQuote, trimBlankLines } from '../core/pin.ts';
import { resolveAnchor } from '../core/resolve.ts';
import { PreparedText } from '../core/text.ts';
import { patchManifest, type AnchorPatch } from '../extension/manifest-edit.ts';
import { realPathInside, writeFileAtomic } from '../extension/paths.ts';
import { WidgetCompiler, type CompileResult, type WidgetCompilerOptions } from '../extension/widgets/compile.ts';
import { anchorsRead } from '../extension/widgets/html.ts';
import { isSecretFileName, isSecretPath } from '../extension/widgets/secret-files.ts';
import { describeProblem, parseCss, placementProblems, type ParsedCss } from './css.ts';
import { scanHtml, type WidgetElement } from './html.ts';

export type Severity = 'error' | 'warning' | 'info';

export interface Finding {
  severity: Severity;
  /** Absolute path. */
  file: string;
  line?: number;
  column?: number;
  code: string;
  message: string;
}

export interface WidgetReport {
  src: string;
  line: number;
  anchor: string | null;
  ok: boolean;
}

export interface PinReport {
  pinned: { anchor: string; file: string; range: LineRange }[];
  unchanged: string[];
  skipped: { anchor: string; reason: string }[];
  /** Anchors widgets read whose pinning needs the user's go-ahead (--yes-widgets-may-read). */
  needsConsent: { anchor: string; file: string; range: LineRange; lines: number }[];
  /** With --yes-widgets-may-read: what widgets may now read. */
  widgetsMayRead: { anchor: string; file: string; range: LineRange; lines: number }[];
}

export interface CheckReport {
  explainer: string;
  widgets: WidgetReport[];
  findings: Finding[];
  pin?: PinReport;
  errors: number;
  warnings: number;
}

export interface CheckOptions {
  pin?: boolean;
  yesWidgetsMayRead?: boolean;
  /** Where the compiler's worker and data are (default: next to the bundle). */
  compiler?: WidgetCompilerOptions;
}

/** Same caps as the panel (docs/WIDGETS-PLAN.md §2, §3). */
export const CHECK_LIMITS = { propsBytes: 16 * 1024, widgetsPerExplainer: 24, maxHeight: 20_000, codeBytes: 10 * 1024 * 1024, quoteLines: 2000 } as const;

const GUIDE = 'docs/WIDGETS.md';
const SDK_FUNCTIONS = new Set(['reveal', 'goToStep', 'highlight', 'useAnchorCode', 'useIsActive', 'useStepValue']);

type UseKind = 'reveal' | 'goToStep' | 'highlight' | 'Ref' | 'useAnchorCode' | 'useIsActive' | 'useStepValue';
interface AnchorUse {
  kind: UseKind;
  /** The anchor id, when written as a literal. */
  id?: string;
  /** The id is computed at run time (can't be checked). */
  dynamic?: boolean;
  /** highlight() without an anchor option: the widget's enclosing anchor. */
  implicit?: boolean;
  file: string;
  line: number;
}

// ---- reading widget code for anchor ids ----

type AnyNode = Node & Record<string, any>;

function literalString(n: AnyNode | undefined): string | undefined {
  if (!n) return undefined;
  if (n.type === 'Literal' && typeof n.value === 'string') return n.value;
  if (n.type === 'TemplateLiteral' && n.expressions.length === 0) return n.quasis[0]?.value?.cooked ?? undefined;
  return undefined;
}

function propNamed(obj: AnyNode, name: string): AnyNode | undefined {
  return (obj.properties as AnyNode[]).find((p) => p.type === 'Property' && !p.computed && (p.key.name === name || p.key.value === name));
}

/**
 * Anchor ids named by SDK calls in one compiled module (CommonJS from the widget compiler: imports are
 * `var _explainer = require('explainer')` and calls `_explainer.reveal.call(void 0, …)`; line numbers are
 * the source's). Returns undefined when the code can't be parsed.
 */
export function anchorUses(file: string, code: string): AnchorUse[] | undefined {
  let ast: AnyNode;
  try {
    ast = parse(code, { ecmaVersion: 'latest', sourceType: 'script', locations: true, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, allowHashBang: true }) as AnyNode;
  } catch {
    return undefined;
  }
  const bindings = new Set<string>();
  const isRequireExplainer = (n: AnyNode | null | undefined): boolean =>
    !!n && n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'require' && literalString(n.arguments[0]) === 'explainer';
  // Two passes: interop wrappers (`var ex = _interopRequireWildcard(_explainer)`) follow the require.
  for (let pass = 0; pass < 2; pass++) {
    simple(ast, {
      VariableDeclarator(n) {
        const d = n as AnyNode;
        if (d.id.type !== 'Identifier' || !d.init) return;
        if (isRequireExplainer(d.init) || (d.init.type === 'CallExpression' && (d.init.arguments as AnyNode[]).some((a) => a.type === 'Identifier' && bindings.has(a.name) || isRequireExplainer(a)))) {
          bindings.add(d.id.name);
        }
      },
    });
  }
  if (!bindings.size) return [];
  /** `X.name` with X an explainer binding → name. */
  const sdkMember = (n: AnyNode | undefined): string | undefined =>
    n?.type === 'MemberExpression' && !n.computed && n.object.type === 'Identifier' && bindings.has(n.object.name) ? (n.property.name as string) : undefined;

  const uses: AnchorUse[] = [];
  simple(ast, {
    CallExpression(n) {
      const call = n as AnyNode;
      const line = call.loc!.start.line;
      let callee = call.callee as AnyNode;
      let args = call.arguments as AnyNode[];
      // fn.call(void 0, …) (Sucrase's form for imported functions, jsx included) and (0, fn)(…)
      if (callee.type === 'MemberExpression' && !callee.computed && callee.property.name === 'call') {
        callee = callee.object;
        args = args.slice(1);
      } else if (callee.type === 'SequenceExpression') {
        callee = callee.expressions.at(-1);
      }
      // JSX: jsx(_explainer.Ref, { anchor: "x", … })
      if (sdkMember(args[0]) === 'Ref' && args[1]?.type === 'ObjectExpression') {
        const p = propNamed(args[1], 'anchor');
        const id = literalString(p?.value);
        uses.push({ kind: 'Ref', id, dynamic: !id, file, line });
      }
      const name = sdkMember(callee);
      if (!name || !SDK_FUNCTIONS.has(name)) return;
      const kind = name as UseKind;
      if (kind === 'useStepValue') {
        const obj = args[0];
        if (obj?.type !== 'ObjectExpression') return;
        for (const p of obj.properties as AnyNode[]) {
          if (p.type !== 'Property' || p.computed) continue;
          const id = p.key.type === 'Identifier' ? (p.key.name as string) : literalString(p.key);
          if (id !== undefined) uses.push({ kind, id, file, line: p.loc?.start.line ?? line });
        }
        return;
      }
      if (kind === 'highlight') {
        const opts = args[1];
        if (!opts) return void uses.push({ kind, implicit: true, file, line });
        if (opts.type !== 'ObjectExpression') return void uses.push({ kind, dynamic: true, file, line });
        const p = propNamed(opts, 'anchor');
        if (!p) return void uses.push({ kind, implicit: true, file, line });
        const id = literalString(p.value);
        return void uses.push({ kind, id, dynamic: !id, file, line });
      }
      const id = literalString(args[0]);
      uses.push({ kind, id, dynamic: !id, file, line });
    },
  });
  return uses;
}

// ---- the check ----

const isSource = (key: string) => /\.(tsx|ts|jsx|js)$/i.test(key);

interface Context {
  dir: string;
  root: string;
  htmlFile: string;
  manifestFile: string;
  findings: Finding[];
}

function add(ctx: Context, f: Finding) {
  if (ctx.findings.some((g) => g.file === f.file && g.line === f.line && g.code === f.code && g.message === f.message)) return;
  ctx.findings.push(f);
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** Reads a file of the repository through its real path, refusing links out of the repository and huge files. */
async function readInRepo(root: string, rel: string): Promise<{ text: string; real: string } | { error: string }> {
  const real = await realPathInside(join(root, rel), root);
  if (!real) return { error: 'file missing or outside the repository' };
  try {
    const st = await stat(real);
    if (!st.isFile()) return { error: 'not a file' };
    if (st.size > CHECK_LIMITS.codeBytes) return { error: 'file too large' };
    return { text: await readFile(real, 'utf8'), real };
  } catch {
    return { error: "file can't be read" };
  }
}

function jsonErrorLine(text: string, err: unknown, firstLine: number): number {
  const msg = String((err as Error)?.message ?? '');
  const pos = /position (\d+)/.exec(msg);
  if (pos) return firstLine + (text.slice(0, Number(pos[1])).match(/\r\n|\r|\n/g)?.length ?? 0);
  const lc = /line (\d+)/.exec(msg);
  return lc ? firstLine + Number(lc[1]) - 1 : firstLine;
}

function checkProps(ctx: Context, w: WidgetElement) {
  const at = { file: ctx.htmlFile, line: w.line };
  const attr = w.attrs.get('props');
  const child = w.jsonChildren[0];
  if (w.jsonChildren.length > 1) add(ctx, { severity: 'warning', ...at, line: w.jsonChildren[1]!.line, code: 'props-json', message: 'Only the first <script type="application/json"> child is used for props.' });
  if (child && attr !== undefined) add(ctx, { severity: 'warning', ...at, code: 'props-both', message: 'Both a props attribute and a JSON child are given; the JSON child wins. Keep one.' });
  const text = child ? child.text : attr;
  if (text === undefined || text.trim() === '') return;
  const line = child ? child.line : w.line;
  if (Buffer.byteLength(text) > CHECK_LIMITS.propsBytes) {
    add(ctx, { severity: 'error', file: ctx.htmlFile, line, code: 'props-too-large', message: `Props are limited to ${CHECK_LIMITS.propsBytes / 1024} KB; put larger data in a file next to the widget and import it (import data from './data.json').` });
    return;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    add(ctx, { severity: 'error', file: ctx.htmlFile, line: child ? jsonErrorLine(text, e, line) : line, code: 'props-json', message: `Props aren't valid JSON: ${(e as Error).message}` });
    return;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    add(ctx, { severity: 'error', file: ctx.htmlFile, line, code: 'props-json', message: 'Props must be a JSON object ({"depth": 8}); the widget gets its fields as props.' });
  }
}

function checkAttributes(ctx: Context, w: WidgetElement, ids: Map<string, number>) {
  const at = { file: ctx.htmlFile, line: w.line };
  if (w.selfClosing) add(ctx, { severity: 'warning', ...at, code: 'self-closing', message: '<explain-widget … /> doesn\'t close in HTML (it would swallow the rest of the section); it is treated as empty. Write <explain-widget …>fallback</explain-widget>.' });
  if (w.nested) add(ctx, { severity: 'error', ...at, code: 'nested-widget', message: 'An <explain-widget> inside another one is never shown; close the outer one first.' });
  if (!w.attrs.get('title')) add(ctx, { severity: 'warning', ...at, code: 'no-title', message: 'Give the widget a title="…": it is the widget\'s accessible name (default: its file name).' });
  if (!w.hasFallback && !w.selfClosing) add(ctx, { severity: 'warning', ...at, code: 'no-fallback', message: 'No fallback content: readers who don\'t run widgets (Restricted Mode, widgets off, no consent) see only a placeholder. Add an image, a table or a sentence inside the element.' });
  const height = w.attrs.get('height');
  if (height !== undefined && !(/^\d+$/.test(height.trim()) && Number(height) > 0 && Number(height) <= CHECK_LIMITS.maxHeight)) {
    add(ctx, { severity: 'warning', ...at, code: 'bad-height', message: `height="${height}" should be a whole number of pixels from 1 to ${CHECK_LIMITS.maxHeight} (the initial height; the widget then sizes to its content).` });
  }
  const aspect = w.attrs.get('aspect');
  if (aspect !== undefined && !/^\s*\d+(\.\d+)?\s*(\/\s*\d+(\.\d+)?\s*)?$/.test(aspect)) {
    add(ctx, { severity: 'warning', ...at, code: 'bad-aspect', message: `aspect="${aspect}" should be a ratio like 16/9 or 1.5.` });
  }
  const id = w.attrs.get('id');
  if (id) {
    if (ids.has(id)) add(ctx, { severity: 'warning', ...at, code: 'duplicate-id', message: `Another widget (line ${ids.get(id)}) has id="${id}"; ids keep each widget's saved state apart, so make them unique.` });
    else ids.set(id, w.line);
  }
}

async function loadCss(ctx: Context, styles: ReturnType<typeof scanHtml>['styles']): Promise<ParsedCss> {
  const css: ParsedCss = { rules: [], geometryKeyframes: new Set() };
  for (const s of styles) {
    if (s.kind === 'style' && s.text) {
      parseCss(s.text, s.line, undefined, css);
      continue;
    }
    const href = s.href ?? '';
    if (/^[a-z][a-z0-9+.-]*:|^\/|^\\/i.test(href)) continue; // remote or absolute: the panel drops these
    const rel = href.split(/[?#]/)[0]!;
    const real = await realPathInside(join(ctx.dir, rel), ctx.dir);
    if (!real) continue;
    const text = await readText(real);
    if (text !== undefined && text.length <= 5_000_000) parseCss(text, 1, rel, css);
  }
  return css;
}

/** A conservative mark: the widget's code couldn't be read completely, so it may read any anchor. */
function unscannable(r: CompileResult): boolean {
  if (r.errors.some((e) => ['timeout', 'crashed', 'internal', 'too-complex'].includes(e.code))) return true;
  return r.files.some((f) => isSource(f) && !Object.hasOwn(r.modules, f));
}

interface Scan {
  uses: AnchorUse[];
  /** Some widget reads code we couldn't see (a computed useAnchorCode id, or code that didn't compile). */
  mayReadAny: boolean;
  /** Anchors widgets read, as the extension judges it (it serves a widget nothing else). */
  read: Set<string>;
}

async function compileAndScan(ctx: Context, widgets: WidgetElement[], compiler: WidgetCompiler, reports: WidgetReport[]): Promise<Scan> {
  const bySrc = new Map<string, Promise<CompileResult>>();
  const uses: AnchorUse[] = [];
  let mayReadAny = false;
  const read = new Set<string>();
  for (const w of widgets) {
    const src = w.attrs.get('src');
    const report: WidgetReport = { src: src ?? '', line: w.line, anchor: w.anchor ?? null, ok: false };
    reports.push(report);
    if (w.nested) continue;
    if (!src) {
      add(ctx, { severity: 'error', file: ctx.htmlFile, line: w.line, code: 'no-src', message: '<explain-widget> needs src="widgets/name.tsx" (a file in the explainer folder).' });
      continue;
    }
    let p = bySrc.get(src);
    if (!p) bySrc.set(src, (p = compiler.compile(ctx.dir, src, { timeoutMs: 10_000 })));
    const r = await p;
    for (const d of [...r.errors.map((e) => ({ ...e, severity: 'error' as const })), ...r.warnings.map((e) => ({ ...e, severity: 'warning' as const }))]) {
      const inHtml = d.file === 'explainer.html';
      add(ctx, { severity: d.severity, file: inHtml ? ctx.htmlFile : join(ctx.dir, d.file), line: inHtml ? w.line : d.line, column: inHtml ? undefined : d.column, code: d.code, message: d.message });
    }
    report.ok = r.errors.length === 0;
    if (unscannable(r)) mayReadAny = true;
    // The extension's own judgment (html.ts), so Pin here and in VS Code agree on what widgets read.
    const ids = anchorsRead(r.modules);
    if (ids === 'all') mayReadAny = true;
    else for (const id of ids) read.add(id);
    for (const [key, code] of Object.entries(r.modules)) {
      if (!isSource(key)) continue;
      const found = anchorUses(join(ctx.dir, key), code);
      if (!found) {
        mayReadAny = true;
        continue;
      }
      for (const u of found) {
        if (u.kind === 'useAnchorCode' && u.dynamic) mayReadAny = true;
        if (u.kind === 'highlight' && u.implicit && !w.anchor) {
          add(ctx, { severity: 'warning', file: u.file, line: u.line, code: 'highlight-no-anchor', message: `highlight() without {anchor} uses the widget's enclosing anchor, but the widget at explainer.html:${w.line} isn't inside an element with data-explain-anchor; it highlights nothing. Put the widget in an anchored section or pass {anchor: 'id'}.` });
        }
        uses.push(u);
      }
    }
  }
  return { uses, mayReadAny, read };
}

/** Why useAnchorCode won't serve an anchor, judged from the manifest and the file on disk, or undefined. */
async function servingProblem(root: string, a: Anchor): Promise<{ severity: Severity; code: string; message: string } | undefined> {
  if (isSecretPath(a.file)) return { severity: 'error', code: 'secret-file', message: `useAnchorCode('${a.id}') will never get code: ${a.file} has a secret-looking name, and widgets never read those.` };
  const file = await readInRepo(root, a.file);
  if ('error' in file) return { severity: 'error', code: 'lost', message: `useAnchorCode('${a.id}'): ${a.file}: ${file.error}.` };
  if (isSecretFileName(basename(file.real))) return { severity: 'error', code: 'secret-file', message: `useAnchorCode('${a.id}') will never get code: ${a.file} links to a file with a secret-looking name.` };
  if (!a.quote) {
    return { severity: 'warning', code: 'not-pinned', message: `useAnchorCode('${a.id}') returns {status: 'unavailable', reason: 'not-pinned'} until the anchor is pinned. Pin it with --pin --yes-widgets-may-read, but only after showing the user which lines widgets could then read and getting their go-ahead (${GUIDE}).` };
  }
  if (a.quote.norm !== 'ws') {
    return { severity: 'warning', code: 'not-pinned', message: `useAnchorCode('${a.id}'): the anchor's quote is case-insensitive (norm "${a.quote.norm}"), which doesn't count as pinned for widgets; re-pin it (norm "ws").` };
  }
  const r = resolveAnchor(PreparedText.from(file.text), a);
  if (!r.range) return { severity: 'warning', code: 'lost', message: `useAnchorCode('${a.id}') returns unavailable (lost): the pinned code isn't in ${a.file}. Re-anchor or re-pin it.` };
  // The extension measures the anchor where it resolves now, as here.
  const lines = r.range.end - r.range.start + 1;
  if (lines > CHECK_LIMITS.quoteLines) return { severity: 'warning', code: 'too-large', message: `useAnchorCode('${a.id}'): widgets get at most ${CHECK_LIMITS.quoteLines} lines; this anchor spans ${lines}.` };
  if (r.state !== 'exact' && r.state !== 'moved') {
    return { severity: 'warning', code: 'changed', message: `useAnchorCode('${a.id}'): the code in ${a.file} changed since it was pinned (${r.state}). Widgets then get it only if git tracks the file and the quote matches its committed version: otherwise the reason is 'changed-untracked' (not tracked) or 'changed-since-commit' (the committed version differs too). Re-pin it.` };
  }
  return undefined;
}

async function checkAnchors(ctx: Context, manifest: Manifest | undefined, scan: Scan, steps: Set<string>) {
  if (!manifest) return;
  const has = (id: string) => manifest.anchors.has(id);
  const served = new Map<string, Awaited<ReturnType<typeof servingProblem>> | null>();
  for (const u of scan.uses) {
    if (u.id === undefined) continue;
    const at = { file: u.file, line: u.line };
    const call = u.kind === 'Ref' ? `<Ref anchor="${u.id}">` : u.kind === 'useStepValue' ? `useStepValue key '${u.id}'` : `${u.kind}('${u.id}')`;
    if (!has(u.id)) {
      const severity = u.kind === 'useStepValue' ? 'warning' : 'error';
      add(ctx, { severity, ...at, code: 'unknown-anchor', message: `${call}: no anchor "${u.id}" in manifest.json.` });
      continue;
    }
    if ((u.kind === 'goToStep' || u.kind === 'useStepValue' || u.kind === 'useIsActive') && steps.size && !steps.has(u.id)) {
      add(ctx, { severity: 'warning', ...at, code: 'not-a-step', message: `${call}: "${u.id}" isn't a step (a top-level element with data-explain-anchor in explainer.html), so it never becomes the current step.` });
    }
    if (u.kind === 'useAnchorCode') {
      if (!served.has(u.id)) served.set(u.id, (await servingProblem(ctx.root, manifest.anchors.get(u.id)!)) ?? null);
      const p = served.get(u.id);
      if (p) add(ctx, { ...p, ...at });
      else add(ctx, { severity: 'info', ...at, code: 'unconfirmed', message: `useAnchorCode('${u.id}') is pinned. Until the manifest with exactly this quote is committed, or the reader confirms it in VS Code ("Let widgets read …"), the reason is 'unconfirmed'. A file git ignores is never served ('ignored'); this check can't ask git, so look at .gitignore if widgets get nothing.` });
    }
  }
}

// ---- --pin ----

function lineCount(r: LineRange) {
  return r.end - r.start + 1;
}

async function pin(ctx: Context, manifestText: string, manifest: Manifest, widgetRead: (id: string) => boolean, yes: boolean): Promise<PinReport> {
  const report: PinReport = { pinned: [], unchanged: [], skipped: [], needsConsent: [], widgetsMayRead: [] };
  const patches = new Map<string, AnchorPatch>();
  const files = new Map<string, Awaited<ReturnType<typeof readInRepo>>>();
  for (const a of manifest.anchors.values()) {
    if (isSecretPath(a.file)) {
      report.skipped.push({ anchor: a.id, reason: `${a.file} has a secret-looking name; Pin never copies those into the manifest` });
      continue;
    }
    if (!files.has(a.file)) files.set(a.file, await readInRepo(ctx.root, a.file));
    const file = files.get(a.file)!;
    if ('error' in file) {
      report.skipped.push({ anchor: a.id, reason: `${a.file}: ${file.error}` });
      continue;
    }
    if (isSecretFileName(basename(file.real))) {
      report.skipped.push({ anchor: a.id, reason: `${a.file} links to a file with a secret-looking name` });
      continue;
    }
    const doc = PreparedText.from(file.text);
    const r = resolveAnchor(doc, a);
    const confident = !!r.range && !r.ambiguous && (r.state === 'exact' || r.state === 'moved' || (r.state === 'changed' && r.similarity >= 0.9));
    if (!confident) {
      const why = !r.range ? 'code not found' : r.ambiguous ? 'ambiguous' : r.state === 'changed' ? 'code changed' : r.state === 'stale' ? 'out of date' : 'code not found';
      report.skipped.push({ anchor: a.id, reason: `${why}; use Re-anchor Section to Selection or Pin Anchors in VS Code, which let you accept intended changes` });
      continue;
    }
    const range = trimBlankLines(doc.lines, r.range!);
    const quote = range && pinQuote(doc.lines, range, a.quote?.norm);
    if (!range || !quote) {
      report.skipped.push({ anchor: a.id, reason: 'lines blank or too long to quote' });
      continue;
    }
    const same = a.quote && a.quote.exact === quote.exact && a.quote.prefix === quote.prefix && a.quote.suffix === quote.suffix && a.quote.norm === quote.norm && a.range.start === range.start && a.range.end === range.end;
    if (same) {
      report.unchanged.push(a.id);
      continue;
    }
    if (widgetRead(a.id)) {
      const entry = { anchor: a.id, file: a.file, range, lines: lineCount(range) };
      if (!yes) {
        report.needsConsent.push(entry);
        continue;
      }
      report.widgetsMayRead.push(entry);
    }
    patches.set(a.id, { range, quote });
    report.pinned.push({ anchor: a.id, file: a.file, range });
  }
  if (patches.size) await writeFileAtomic(ctx.manifestFile, patchManifest(manifestText, patches));
  return report;
}

// ---- entry ----

export async function checkExplainer(dirArg: string, opts: CheckOptions = {}): Promise<CheckReport> {
  let dir = resolve(dirArg);
  if (/explainer\.html$|manifest\.json$/.test(dir)) dir = dirname(dir);
  const ctx: Context = { dir, root: dirname(dirname(dir)), htmlFile: join(dir, 'explainer.html'), manifestFile: join(dir, 'manifest.json'), findings: [] };
  const report: CheckReport = { explainer: dir, widgets: [], findings: ctx.findings, errors: 0, warnings: 0 };

  if (basename(dirname(dir)) !== '.explain') {
    add(ctx, { severity: 'warning', file: dir, code: 'not-in-explain', message: 'Explainers live in a folder under .explain/ at the repository root; manifest paths are read from the folder that holds .explain/.' });
  }
  const html = await readText(ctx.htmlFile);
  if (html === undefined) {
    add(ctx, { severity: 'error', file: ctx.htmlFile, code: 'not-found', message: "explainer.html can't be read." });
    return finish(report);
  }
  let manifestText = await readText(ctx.manifestFile);
  let manifest: Manifest | undefined;
  const parseIt = () => {
    if (manifestText === undefined) return undefined;
    const p = parseManifest(manifestText);
    if (!p.ok) {
      add(ctx, { severity: 'error', file: ctx.manifestFile, code: 'manifest', message: p.error });
      return undefined;
    }
    return p.manifest;
  };
  if (manifestText === undefined) add(ctx, { severity: 'error', file: ctx.manifestFile, code: 'not-found', message: "manifest.json can't be read." });
  manifest = parseIt();

  const scanned = scanHtml(html);
  const widgets = scanned.widgets;
  if (widgets.length > CHECK_LIMITS.widgetsPerExplainer) {
    add(ctx, { severity: 'warning', file: ctx.htmlFile, line: widgets[CHECK_LIMITS.widgetsPerExplainer]!.line, code: 'too-many-widgets', message: `${widgets.length} widgets: at most ${CHECK_LIMITS.widgetsPerExplainer} run per explainer (and 8 at once); the rest show their fallback.` });
  }
  const ids = new Map<string, number>();
  const css = await loadCss(ctx, scanned.styles);
  for (const w of widgets) {
    checkAttributes(ctx, w, ids);
    checkProps(ctx, w);
    const el = { name: 'explain-widget', attrs: w.attrs, line: w.line };
    for (const p of placementProblems(w.ancestors, el, css)) {
      add(ctx, { severity: p.severity, file: ctx.htmlFile, line: w.line, code: 'placement', message: describeProblem(p, p.element === el) });
    }
  }

  const compiler = new WidgetCompiler(opts.compiler ?? {});
  let scan: Scan;
  try {
    scan = await compileAndScan(ctx, widgets, compiler, report.widgets);
  } finally {
    compiler.dispose();
  }

  if (opts.pin && manifest && manifestText !== undefined) {
    const read = new Set([...scan.read, ...scan.uses.filter((u) => u.kind === 'useAnchorCode' && u.id).map((u) => u.id!)]);
    report.pin = await pin(ctx, manifestText, manifest, (id) => scan.mayReadAny || read.has(id), !!opts.yesWidgetsMayRead);
    for (const s of report.pin.skipped) add(ctx, { severity: 'warning', file: ctx.manifestFile, code: 'pin-skipped', message: `Not pinned: ${s.anchor} (${s.reason}).` });
    if (report.pin.needsConsent.length) {
      const list = report.pin.needsConsent.map((e) => `${e.file} lines ${e.range.start}–${e.range.end} (${e.lines} lines, anchor ${e.anchor})`).join('; ');
      add(ctx, {
        severity: 'warning', file: ctx.manifestFile, code: 'pin-needs-consent',
        message: `Not pinned, because widgets ${scan.mayReadAny ? 'may read any anchor (some widget code computes the anchor id, uses useAnchorCode other than as a direct call with a literal id, or could not be read)' : 'read these anchors with useAnchorCode'}, and pinning lets them read: ${list}. Show the user these files and line ranges, and rerun with --yes-widgets-may-read only if they agree.`,
      });
    }
    manifestText = await readText(ctx.manifestFile);
    manifest = parseIt();
  }

  await checkAnchors(ctx, manifest, scan, new Set(scanned.steps));
  return finish(report);
}

function finish(report: CheckReport): CheckReport {
  report.errors = report.findings.filter((f) => f.severity === 'error').length;
  report.warnings = report.findings.filter((f) => f.severity === 'warning').length;
  return report;
}

const rank: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

export function formatReport(report: CheckReport, cwd = process.cwd()): string {
  const shown = (file: string) => {
    const r = relative(cwd, file);
    return r && !r.startsWith('..') && !isAbsolute(r) ? r : file;
  };
  const sorted = [...report.findings].sort((a, b) => rank[a.severity] - rank[b.severity] || a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0));
  const out = sorted.map((f) => `${shown(f.file)}${f.line ? `:${f.line}${f.column ? `:${f.column}` : ''}` : ''}: ${f.severity} ${f.code}: ${f.message}`);
  const p = report.pin;
  if (p) {
    out.push(`Pinned ${p.pinned.length} anchor(s)${p.pinned.length ? `: ${p.pinned.map((x) => x.anchor).join(', ')}` : ''}; ${p.unchanged.length} already pinned; ${p.skipped.length + p.needsConsent.length} not pinned.`);
    if (p.widgetsMayRead.length) {
      out.push('Widgets in this explainer may now read (once the quotes are committed, or confirmed in VS Code):');
      for (const e of p.widgetsMayRead) out.push(`  ${e.file} lines ${e.range.start}–${e.range.end} (${e.lines} lines, anchor ${e.anchor})`);
    }
  }
  const n = report.widgets.length;
  out.push(n === 0 ? 'No <explain-widget> elements in explainer.html.' : `${n} widget${n === 1 ? '' : 's'} checked: ${report.errors} error(s), ${report.warnings} warning(s).`);
  return out.join('\n');
}

const USAGE = 'usage: node check.cjs <explainer-dir> [--json] [--pin [--yes-widgets-may-read]]';

export async function main(argv: string[], io: { out: (s: string) => void; err: (s: string) => void } = { out: (s) => process.stdout.write(`${s}\n`), err: (s) => process.stderr.write(`${s}\n`) }, compiler?: WidgetCompilerOptions): Promise<number> {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const args = argv.filter((a) => !a.startsWith('--'));
  const known = new Set(['--json', '--pin', '--yes-widgets-may-read', '--help']);
  const unknown = [...flags].filter((f) => !known.has(f));
  if (flags.has('--help')) {
    io.out(USAGE);
    return 0;
  }
  if (args.length !== 1 || unknown.length) {
    io.err(unknown.length ? `unknown option ${unknown.join(', ')}\n${USAGE}` : USAGE);
    return 2;
  }
  if (flags.has('--yes-widgets-may-read') && !flags.has('--pin')) {
    io.err(`--yes-widgets-may-read only goes with --pin\n${USAGE}`);
    return 2;
  }
  const report = await checkExplainer(args[0]!, { pin: flags.has('--pin'), yesWidgetsMayRead: flags.has('--yes-widgets-may-read'), compiler });
  io.out(flags.has('--json') ? JSON.stringify(report, null, 2) : formatReport(report));
  return report.errors > 0 ? 1 : 0;
}

// Run when bundled as dist/check.cjs (or run directly by node); not when imported by tests.
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (e: unknown) => { process.stderr.write(`check.cjs: ${(e as Error)?.stack ?? e}\n`); process.exitCode = 2; },
  );
}

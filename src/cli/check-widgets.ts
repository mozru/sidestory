// The standalone widget checker (docs/WIDGETS-PLAN.md §2 "Checking"), bundled as dist/check.cjs:
//
//   node <extension>/dist/check.cjs <sidestory-dir> [--json] [--types] [--pin] [--accept <ids>] [--yes-widgets-may-read]
//
// Finds sidestory.html's <explain-widget> elements, compiles each with the extension's widget compiler,
// validates their props, checks the anchor ids widget code names against manifest.json, reports anchors
// read through useAnchorCode that widgets won't get (not pinned, secret-looking files …) and placement
// problems visible in the HTML and CSS. Prints `file:line: severity code: message`; exits 1 on errors.
// Runs nothing from the repository (compiling isn't running), so it needs no consent.
//
// --types also writes .sidestory/tsconfig.json and .sidestory/.types/*.d.ts (as "Add Widget Types" does), so
// `npx -y -p typescript tsc -p .sidestory` typechecks the widgets.
//
// --pin records each anchor's current code from the files on disk, as "Pin Anchors" does, never for
// secret-looking files, and never for anchors widgets read unless --yes-widgets-may-read is given: those
// let widgets read the code, so the user decides (docs/WIDGETS.md, "Checking your work"). In a sidestory
// with a base, base-side anchors are pinned against the merge-base blob, never the working tree, and anchors
// with code added since they were pinned are left alone: --accept <ids> re-pins those (docs/CHANGES-PLAN.md
// §13.1). --pin also writes a stable `id` when the manifest has none (docs/COMMENTS-PLAN.md §3.1).
//
// Every check also resolves each manifest anchor as the panel and the sidebar's drift badges do, and reports code
// that is lost (anchor-lost), out of date (anchor-stale) or changed a little (anchor-changed).
//
//   node check.cjs [<sidestory-dir>] --coverage [--base <ref>] [--committed | --head <sha>] [--repo <dir>] [--json]
//
// --coverage checks the branch's merge diff against the sidestories that belong to it (src/cli/coverage.ts) and
// exits 3 when there are no errors but some change isn't explained or marked trivial.
import { applyRules, lockedLevels, lockedWhy, manifestLevels, parseChecksFile, parseIgnore, type Ignore } from '../core/check-rules.ts';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parse, type Node } from 'acorn';
import { simple } from 'acorn-walk';
import { plainLine } from '../core/display-text.ts';
import { outlineHtml } from '../core/html-scan.ts';
import { explainerNameSchema, parseGroup, parseManifest, type Anchor, type LineRange, type Manifest } from '../core/manifest.ts';
import { pinQuote, trimBlankLines } from '../core/pin.ts';
import { resolveAnchor } from '../core/resolve.ts';
import { PreparedText } from '../core/text.ts';
import { sideOf } from '../core/manifest.ts';
import { patchManifest, type AnchorPatch } from '../extension/manifest-edit.ts';
import { realPathInside, writeFileAtomic } from '../extension/paths.ts';
import { WidgetCompiler, type CompileResult, type WidgetCompilerOptions } from '../extension/widgets/compile.ts';
import { anchorsRead } from '../extension/widgets/html.ts';
import { isSecretFileName, isSecretPath } from '../extension/widgets/secret-files.ts';
import { TYPECHECK_COMMAND, writeWidgetTypes } from '../widget-types/index.ts';
import { describeProblem, parseCss, placementProblems, type ParsedCss } from './css.ts';
import { threadsMain } from './threads.ts';
import { describeElement, lineIndex, scanHtml, type WidgetElement } from './html.ts';
import { manifestLines, type ManifestLines } from './manifest-lines.ts';
import { checkCodeLinks, checkIds, scanPageLinks } from './checks/links.ts';
import { newUlid } from '../comments/fsx.ts';
import { commandPath, manifestDiagnosticFindings, runCoverage, type BaseText, type BranchContext, type CoverageResult } from './coverage.ts';

export type Severity = 'error' | 'warning' | 'info';

export interface Finding {
  severity: Severity;
  /** Absolute path. */
  file: string;
  line?: number;
  column?: number;
  code: string;
  message: string;
  /** The anchor (step) it is about: its step's rule levels apply (src/core/check-rules.ts). */
  anchor?: string;
  /** Where in the page the element it is about starts, for the page's exceptions (not in the report). */
  offset?: number;
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
  /** Anchors with code added since they were pinned (docs/CHANGES-PLAN.md §6.3), left for --accept. */
  held: { anchor: string; lines: number[] }[];
  /** The stable id written to a manifest that had none. */
  id?: string;
}

export interface CheckReport {
  sidestory: string;
  /** The manifest's title, as the sidebar and pickers show it. */
  title?: string;
  /** The manifest's group, when valid. */
  group?: string;
  /** The steps as the workspace index outlines them (docs/NAVIGATION-PLAN.md §6.2). */
  steps?: { id: string; title: string }[];
  /** data-explain-detail names in document order, deduplicated. */
  details?: string[];
  widgets: WidgetReport[];
  findings: Finding[];
  pin?: PinReport;
  errors: number;
  warnings: number;
  /** Findings the repository's rules turned off (src/core/check-rules.ts), and why. */
  ignored?: { code: string; reason: string }[];
}

export interface CheckOptions {
  pin?: boolean;
  /** Anchors to re-pin even though code was added inside them since they were pinned (--accept). */
  accept?: readonly string[];
  /** The branch comparison, for base-side pins and the anchors --pin leaves alone. */
  branch?: BranchContext;
  /** Makes the stable id --pin writes (tests). */
  newId?: () => string;
  yesWidgetsMayRead?: boolean;
  /** Where the compiler's worker and data are (default: next to the bundle). */
  compiler?: WidgetCompilerOptions;
  /** Code files already read in this run (shared by the sidestories one run checks). */
  files?: CodeFiles;
  /** The folder commands in messages are relative to (default: the working directory). */
  cwd?: string;
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
  /** Code files read so far, each read and prepared once per run (shared by the sidestories one run checks). */
  files: CodeFiles;
  /** Merge-base texts (base-side anchors), prepared once per check. */
  bases: Map<string, Promise<PreparedText | BaseText>>;
}

/** A code file: prepared, or why it wasn't read (`missing`: there is nothing at that path). */
type CodeFile = { real: string; doc: PreparedText } | { error: string; missing: boolean };
/** Code files by `<root>\0<repository-relative path>`. */
export type CodeFiles = Map<string, Promise<CodeFile>>;

function add(ctx: Context, f: Finding) {
  if (ctx.findings.some((g) => g.file === f.file && g.line === f.line && g.offset === f.offset && g.code === f.code && g.message === f.message)) return;
  ctx.findings.push(f);
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Reads and prepares a file of the repository through its real path, refusing links out of the repository and huge
 * files; once per run.
 */
function codeFile(ctx: Context, rel: string): Promise<CodeFile> {
  const key = `${ctx.root}\u0000${rel}`;
  let p = ctx.files.get(key);
  if (!p) {
    p = (async (): Promise<CodeFile> => {
      const path = join(ctx.root, rel);
      const real = await realPathInside(path, ctx.root);
      // Nothing there at all, or something (a link out of the repository) that isn't read.
      if (!real) return { error: 'file missing or outside the repository', missing: !(await lstat(path).then(() => true, () => false)) };
      try {
        const st = await stat(real);
        if (!st.isFile()) return { error: 'not a file', missing: false };
        if (st.size > CHECK_LIMITS.codeBytes) return { error: 'file too large', missing: false };
        return { real, doc: PreparedText.from(await readFile(real, 'utf8')) };
      } catch {
        return { error: "file can't be read", missing: false };
      }
    })();
    ctx.files.set(key, p);
  }
  return p;
}

/** A file's merge-base text, prepared once per check, or why there is none. */
function baseFile(ctx: Context, branch: BranchContext, rel: string): Promise<PreparedText | BaseText> {
  let p = ctx.bases.get(rel);
  if (!p) {
    p = branch.baseText(rel).then((t) => ('text' in t ? PreparedText.from(t.text) : t));
    ctx.bases.set(rel, p);
  }
  return p;
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
      add(ctx, { severity: 'error', file: ctx.htmlFile, line: w.line, code: 'no-src', message: '<explain-widget> needs src="widgets/name.tsx" (a file in the sidestory folder).' });
      continue;
    }
    let p = bySrc.get(src);
    if (!p) bySrc.set(src, (p = compiler.compile(ctx.dir, src, { timeoutMs: 10_000 })));
    const r = await p;
    for (const d of [...r.errors.map((e) => ({ ...e, severity: 'error' as const })), ...r.warnings.map((e) => ({ ...e, severity: 'warning' as const }))]) {
      const inHtml = d.file === 'sidestory.html';
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
          add(ctx, { severity: 'warning', file: u.file, line: u.line, code: 'highlight-no-anchor', message: `highlight() without {anchor} uses the widget's enclosing anchor, but the widget at sidestory.html:${w.line} isn't inside an element with data-explain-anchor; it highlights nothing. Put the widget in an anchored section or pass {anchor: 'id'}.` });
        }
        uses.push(u);
      }
    }
  }
  return { uses, mayReadAny, read };
}

/** Why useAnchorCode won't serve an anchor, judged from the manifest and the file on disk, or undefined. */
async function servingProblem(ctx: Context, a: Anchor): Promise<{ severity: Severity; code: string; message: string } | undefined> {
  if (isSecretPath(a.file)) return { severity: 'error', code: 'secret-file', message: `useAnchorCode('${a.id}') will never get code: ${a.file} has a secret-looking name, and widgets never read those.` };
  const file = await codeFile(ctx, a.file);
  if ('error' in file) return { severity: 'error', code: 'lost', message: `useAnchorCode('${a.id}'): ${a.file}: ${file.error}.` };
  if (isSecretFileName(basename(file.real))) return { severity: 'error', code: 'secret-file', message: `useAnchorCode('${a.id}') will never get code: ${a.file} links to a file with a secret-looking name.` };
  if (!a.quote) {
    return { severity: 'warning', code: 'not-pinned', message: `useAnchorCode('${a.id}') returns {status: 'unavailable', reason: 'not-pinned'} until the anchor is pinned. Pin it with --pin --yes-widgets-may-read, but only after showing the user which lines widgets could then read and getting their go-ahead (${GUIDE}).` };
  }
  if (a.quote.norm !== 'ws') {
    return { severity: 'warning', code: 'not-pinned', message: `useAnchorCode('${a.id}'): the anchor's quote is case-insensitive (norm "${a.quote.norm}"), which doesn't count as pinned for widgets; re-pin it (norm "ws").` };
  }
  const r = resolveAnchor(file.doc, a);
  if (!r.range) return { severity: 'warning', code: 'lost', message: `useAnchorCode('${a.id}') returns unavailable (lost): the pinned code isn't in ${a.file}. Re-anchor or re-pin it.` };
  // The extension measures the anchor where it resolves now, as here.
  const lines = r.range.end - r.range.start + 1;
  if (lines > CHECK_LIMITS.quoteLines) return { severity: 'warning', code: 'too-large', message: `useAnchorCode('${a.id}'): widgets get at most ${CHECK_LIMITS.quoteLines} lines; this anchor spans ${lines}.` };
  if (r.state !== 'exact' && r.state !== 'moved') {
    return { severity: 'warning', code: 'changed', message: `useAnchorCode('${a.id}'): the code in ${a.file} changed since it was pinned (${r.state}). Widgets then get it only if git tracks the file and the quote matches its committed version: otherwise the reason is 'changed-untracked' (not tracked) or 'changed-since-commit' (the committed version differs too). Re-pin it.` };
  }
  return undefined;
}

// ---- drift: anchors whose code is lost, out of date or changed ----

/** The anchor id of each drift finding, so coverage's explained-stale can be matched to the anchor-stale it repeats. */
const driftAnchor = new WeakMap<Finding, string>();
const span = (r: LineRange) => (r.start === r.end ? `line ${r.start}` : `lines ${r.start}–${r.end}`);

/**
 * Resolves every anchor as a fresh open of the panel does (and the sidebar's drift badges, src/extension/nav/drift.ts),
 * and reports what VS Code flags: "Code not found" (anchor-lost) and "Out of date" or changed more than --pin re-pins
 * by itself (anchor-stale) as warnings, a small change --pin would re-pin (anchor-changed) as info. A file that isn't
 * read (a link out of the repository, too large …) is anchor-unchecked, as the sidebar counts it; secret-looking ones
 * are skipped. Base-side anchors are resolved against the merge-base when the check has the branch comparison, and
 * skipped otherwise. `widgetsRead`: whether widgets may read an anchor, so pinning it needs the user's go-ahead.
 */
async function anchorDrift(ctx: Context, manifest: Manifest, steps: ReadonlyMap<string, string>, lines: ManifestLines | undefined, branch: BranchContext | undefined, widgetsRead: (id: string) => boolean, cwd: string): Promise<Map<string, Finding>> {
  const out = new Map<string, Finding>();
  const folder = commandPath(cwd, ctx.dir);
  for (const a of manifest.anchors.values()) {
    if (isSecretPath(a.file)) continue;
    const base = sideOf(a) === 'base';
    if (base && !branch) continue;
    const title = steps.get(a.id);
    const report = (code: string, severity: Severity, message: string) => {
      const line = lines?.anchor(a.id);
      const f: Finding = { severity, file: ctx.manifestFile, ...(line ? { line } : {}), anchor: a.id, code, message: `${title !== undefined ? `Step "${title}" (anchor "${a.id}")` : `Anchor "${a.id}"`}: ${message}` };
      driftAnchor.set(f, a.id);
      out.set(a.id, f);
    };
    const reanchor = `re-anchor it: set the anchor's "file" and "range" to the code${base ? ' as it is at the merge-base' : ''}, delete its "quote" and run --pin${base ? '' : ' (or Re-anchor Section to Selection in VS Code)'}`;
    const run = (args: string) => `check.cjs ${folder} ${args}${widgetsRead(a.id) ? " --yes-widgets-may-read, but only with the user's go-ahead (widgets can then read its code)" : ''}`;
    const pinnedAt = a.quote || a.snippet ? `last pinned at ${span(a.range)}` : `its range is ${span(a.range)}`;
    const lost = (what: string) =>
      report('anchor-lost', 'warning', `${what}. If it moved or was rewritten, ${reanchor}; if it was removed on purpose, remove ${title !== undefined ? 'the step' : 'the anchor and what refers to it'}.${widgetsRead(a.id) ? ' Widgets may read it (useAnchorCode).' : ''}`);
    const unchecked = (why: string) => report('anchor-unchecked', 'info', `${why}, so its code wasn't checked.`);
    let doc: PreparedText;
    if (base) {
      const t = await baseFile(ctx, branch!, a.file);
      if ('missing' in t) lost(`${a.file} isn't a file at the merge-base (${pinnedAt})`);
      else if ('unchecked' in t) unchecked(`${a.file} at the merge-base is ${t.unchecked}`);
      if (!(t instanceof PreparedText)) continue;
      doc = t;
    } else {
      const file = await codeFile(ctx, a.file);
      if ('error' in file) {
        if (file.missing) lost(`${a.file} doesn't exist (${pinnedAt})`);
        else unchecked(`${a.file}: ${file.error}`);
        continue;
      }
      if (isSecretFileName(basename(file.real))) continue;
      doc = file.doc;
    }
    const r = resolveAnchor(doc, a);
    if (!r.range) {
      lost(a.quote || a.snippet ? `its code isn't in ${a.file}${base ? ' at the merge-base' : ''} any more (${pinnedAt})` : `its range (${span(a.range)}) is past the end of ${a.file} (${doc.lines.length} lines)`);
      continue;
    }
    if (r.state === 'exact' || r.state === 'moved') continue;
    const now = r.range.start === a.range.start && r.range.end === a.range.end ? '' : `; it is now at ${span(r.range)}`;
    // What --pin re-pins by itself; VS Code still says "Code changed".
    if (r.state === 'changed' && r.similarity >= 0.9 && !r.ambiguous) {
      report('anchor-changed', 'info', `the code in ${a.file} changed a little since it was pinned at ${span(a.range)} ("Code changed" in VS Code)${now}. If the prose still fits, run ${run(widgetsRead(a.id) ? `--accept ${a.id}` : '--pin')}.`);
      continue;
    }
    const what = r.state === 'stale' ? 'changed a lot since it was pinned' : 'changed since it was pinned';
    const badge = r.state === 'stale' ? '"Out of date" in VS Code' : '"Code changed" in VS Code, too much for --pin to re-pin by itself';
    const fix = r.ambiguous
      ? `It matches more than one place about equally well, so --accept can't pick one: ${reanchor}.`
      : `Check the prose still fits, then run ${run(`--accept ${a.id}`)}; if that isn't the code ${title !== undefined ? 'the step' : 'the anchor'} is about, ${reanchor}.`;
    report('anchor-stale', 'warning', `the code in ${a.file} ${what} at ${span(a.range)} (${badge})${now}. ${fix}`);
  }
  return out;
}

/**
 * Checks the anchors widget code names. Returns the head-side anchors (widgets read the working tree) whose
 * useAnchorCode finding is lost or changed, with that finding's severity; the finding is left out when the anchor's
 * anchor-lost or anchor-stale in `drift` already says it.
 */
async function checkAnchors(ctx: Context, manifest: Manifest | undefined, scan: Scan, steps: ReadonlySet<string>, drift: ReadonlyMap<string, Finding>): Promise<Map<string, Severity>> {
  const broken = new Map<string, Severity>();
  if (!manifest) return broken;
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
      add(ctx, { severity: 'warning', ...at, code: 'not-a-step', message: `${call}: "${u.id}" isn't a step (a top-level element with data-explain-anchor in sidestory.html), so it never becomes the current step.` });
    }
    if (u.kind === 'useAnchorCode') {
      const a = manifest.anchors.get(u.id)!;
      if (!served.has(u.id)) served.set(u.id, (await servingProblem(ctx, a)) ?? null);
      const p = served.get(u.id);
      if ((p?.code === 'lost' || p?.code === 'changed') && sideOf(a) === 'head') {
        broken.set(u.id, p.severity);
        const d = drift.get(u.id)?.code;
        if (d === 'anchor-lost' || d === 'anchor-stale') continue;
      }
      if (p) add(ctx, { ...p, ...at });
      else add(ctx, { severity: 'info', ...at, code: 'unconfirmed', message: `useAnchorCode('${u.id}') is pinned. Until the manifest with exactly this quote is committed, or the reader confirms it in VS Code ("Let widgets read …"), the reason is 'unconfirmed'. A file git ignores is never served ('ignored'); this check can't ask git, so look at .gitignore if widgets get nothing.` });
    }
  }
  return broken;
}

// ---- --pin ----

function lineCount(r: LineRange) {
  return r.end - r.start + 1;
}

interface PinWhat {
  /** --pin: every anchor (but those code was added inside); otherwise only `accept`. */
  all: boolean;
  accept: ReadonlySet<string>;
  branch?: BranchContext;
  newId?: () => string;
}

/** `unresolved`: anchors skipped because their code or file wasn't found as it was pinned (what anchor drift reports). */
async function pin(ctx: Context, manifestText: string, manifest: Manifest, widgetRead: (id: string) => boolean, yes: boolean, what: PinWhat): Promise<{ report: PinReport; unresolved: Set<string> }> {
  const report: PinReport = { pinned: [], unchanged: [], skipped: [], needsConsent: [], widgetsMayRead: [], held: [] };
  const unresolved = new Set<string>();
  const patches = new Map<string, AnchorPatch>();
  for (const a of manifest.anchors.values()) {
    const accepting = what.accept.has(a.id);
    if (!what.all && !accepting) continue;
    const held = what.branch?.held.get(a.id);
    if (held && !accepting) {
      // Code was added inside this step after it was pinned: re-pinning would hide it from the coverage check.
      report.held.push({ anchor: a.id, lines: held });
      continue;
    }
    if (isSecretPath(a.file)) {
      report.skipped.push({ anchor: a.id, reason: `${a.file} has a secret-looking name; Pin never copies those into the manifest` });
      continue;
    }
    let doc: PreparedText;
    if (sideOf(a) === 'base') {
      // Removed code: the merge-base's version of the file, never the working tree (§7.6).
      if (!what.branch) {
        report.skipped.push({ anchor: a.id, reason: 'a base-side anchor is pinned against the merge-base, which needs the branch comparison: run it inside the repository, with a base that resolves (--coverage says why it doesn\'t)' });
        continue;
      }
      const text = await baseFile(ctx, what.branch, a.file);
      if (!(text instanceof PreparedText)) {
        unresolved.add(a.id);
        report.skipped.push({ anchor: a.id, reason: 'unchecked' in text ? `${a.file} at the merge-base is ${text.unchecked}` : `${a.file} isn't a file at the merge-base` });
        continue;
      }
      doc = text;
    } else {
      const file = await codeFile(ctx, a.file);
      if ('error' in file) {
        unresolved.add(a.id);
        report.skipped.push({ anchor: a.id, reason: `${a.file}: ${file.error}` });
        continue;
      }
      if (isSecretFileName(basename(file.real))) {
        report.skipped.push({ anchor: a.id, reason: `${a.file} links to a file with a secret-looking name` });
        continue;
      }
      doc = file.doc;
    }
    const r = resolveAnchor(doc, a);
    // --accept takes the code where the anchor is now, changed or not (the author has checked the prose).
    const confident = !!r.range && !r.ambiguous && (accepting ? r.state !== 'lost' : r.state === 'exact' || r.state === 'moved' || (r.state === 'changed' && r.similarity >= 0.9));
    if (!confident) {
      unresolved.add(a.id);
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
  // A stable id for a manifest that has none (docs/COMMENTS-PLAN.md §3.1); a bad one is reported, never replaced. One the
  // manifest had at the merge-base or HEAD (an agent rewrote it whole) is put back, so its comment threads stay.
  const id = what.all && manifest.raw.id === undefined ? (what.branch?.previousId ?? (what.newId ?? newUlid)()) : undefined;
  if (patches.size || id) await writeFileAtomic(ctx.manifestFile, patchManifest(manifestText, patches, { id }));
  if (id) report.id = id;
  return { report, unresolved };
}

// ---- entry ----

export async function checkExplainer(dirArg: string, opts: CheckOptions = {}): Promise<CheckReport> {
  let dir = resolve(dirArg);
  if (/sidestory\.html$|manifest\.json$/.test(dir)) dir = dirname(dir);
  const ctx: Context = { dir, root: dirname(dirname(dir)), htmlFile: join(dir, 'sidestory.html'), manifestFile: join(dir, 'manifest.json'), findings: [], files: opts.files ?? new Map(), bases: new Map() };
  const report: CheckReport = { sidestory: dir, widgets: [], findings: ctx.findings, errors: 0, warnings: 0 };

  if (basename(dirname(dir)) !== '.sidestory') {
    add(ctx, { severity: 'warning', file: dir, code: 'not-in-sidestory', message: 'Sidestories live in a folder under .sidestory/ at the repository root; manifest paths are read from the folder that holds .sidestory/.' });
  }
  const html = await readText(ctx.htmlFile);
  if (html === undefined) {
    add(ctx, { severity: 'error', file: ctx.htmlFile, code: 'not-found', message: "sidestory.html can't be read." });
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
    // The branch fields and the id (docs/CHANGES-PLAN.md §3.4): bad values are dropped with a diagnostic.
    for (const f of manifestDiagnosticFindings(ctx.manifestFile, manifestText, p.diagnostics)) add(ctx, f);
    return p.manifest;
  };
  if (manifestText === undefined) add(ctx, { severity: 'error', file: ctx.manifestFile, code: 'not-found', message: "manifest.json can't be read." });
  manifest = parseIt();

  if (manifest) {
    report.title = manifest.title;
    const g = parseGroup(manifest.raw.group);
    if (g.error) add(ctx, { severity: 'error', file: ctx.manifestFile, code: 'group', message: `group ${g.error}: it must be a string of 1–60 characters with no control characters (it files the sidestory under that group in the sidebar).` });
    if (g.value !== undefined) report.group = g.value;
  }
  await checkOutline(ctx, report, html);

  // Links in the page (docs/AUTHORING-PLAN.md §2.3, §3.3, §8.1): structure and code links now, ids once widgets are read.
  const page = scanPageLinks(html);
  for (const p of page.problems) add(ctx, { ...p, file: ctx.htmlFile });
  for (const p of await checkCodeLinks(ctx.root, page.codes, CHECK_LIMITS.codeBytes)) add(ctx, { ...p, file: ctx.htmlFile });

  const scanned = scanHtml(html);
  for (const b of scanned.unlinkedBoxes) {
    add(ctx, { severity: 'warning', file: ctx.htmlFile, line: b.line, offset: b.offset, code: 'box-unlinked', message: `This diagram part lights up on a step (data-explain-on) but links to no code, so readers can't click it to see the code it stands for (${describeElement(b.el)}). Add data-explain-code or data-explain-ref to it or around it; if it isn't about code (a legend, a label), mark it data-explain-ignore="box-unlinked: why".` });
  }
  const widgets = scanned.widgets;
  if (widgets.length > CHECK_LIMITS.widgetsPerExplainer) {
    add(ctx, { severity: 'warning', file: ctx.htmlFile, line: widgets[CHECK_LIMITS.widgetsPerExplainer]!.line, code: 'too-many-widgets', message: `${widgets.length} widgets: at most ${CHECK_LIMITS.widgetsPerExplainer} run per sidestory (and 8 at once); the rest show their fallback.` });
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

  const accept = new Set(opts.accept ?? []);
  if (manifest) {
    for (const id of accept) if (!manifest.anchors.has(id)) add(ctx, { severity: 'error', file: ctx.manifestFile, code: 'accept', message: `--accept ${id}: no anchor "${id}" in manifest.json.` });
  }
  const read = new Set([...scan.read, ...scan.uses.filter((u) => u.kind === 'useAnchorCode' && u.id).map((u) => u.id!)]);
  const widgetsRead = (id: string) => scan.mayReadAny || read.has(id);
  let unresolved = new Set<string>();
  if ((opts.pin || accept.size) && manifest && manifestText !== undefined) {
    ({ report: report.pin, unresolved } = await pin(ctx, manifestText, manifest, widgetsRead, !!opts.yesWidgetsMayRead, { all: !!opts.pin, accept, branch: opts.branch, newId: opts.newId }));
    if (report.pin.needsConsent.length) {
      const list = report.pin.needsConsent.map((e) => `${e.file} lines ${e.range.start}–${e.range.end} (${e.lines} lines, anchor ${e.anchor})`).join('; ');
      add(ctx, {
        severity: 'warning', file: ctx.manifestFile, code: 'pin-needs-consent',
        message: `Not pinned, because widgets ${scan.mayReadAny ? 'may read any anchor (some widget code computes the anchor id, uses useAnchorCode other than as a direct call with a literal id, or could not be read)' : 'read these anchors with useAnchorCode'}, and pinning lets them read: ${list}. Show the user these files and line ranges, and rerun with --yes-widgets-may-read only if they agree.`,
      });
    }
    // Read back without repeating the diagnostics already reported.
    manifestText = await readText(ctx.manifestFile);
    const before = ctx.findings.length;
    manifest = parseIt();
    ctx.findings.splice(before);
  }
  if (manifest?.base !== undefined && manifest.raw.id === undefined) {
    add(ctx, { severity: 'info', file: ctx.manifestFile, code: 'missing-id', message: 'No "id": a stable id keeps comments attached when the sidestory is renamed or archived. --pin adds one; never change or remove it afterwards.' });
  }

  const lines = manifestText === undefined ? undefined : manifestLines(manifestText);
  // Code lost, out of date or changed, as VS Code shows it. One finding per anchor: pin skipping it because of that,
  // or a widget not getting its code, would only repeat it.
  const drift = manifest ? await anchorDrift(ctx, manifest, new Map(report.steps!.map((s) => [s.id, s.title])), lines, opts.branch, widgetsRead, opts.cwd ?? process.cwd()) : new Map<string, Finding>();
  for (const s of report.pin?.skipped ?? []) {
    if (!(unresolved.has(s.anchor) && drift.has(s.anchor))) add(ctx, { severity: 'warning', file: ctx.manifestFile, code: 'pin-skipped', message: `Not pinned: ${s.anchor} (${s.reason}).` });
  }
  const broken = await checkAnchors(ctx, manifest, scan, new Set(scanned.steps), drift);
  for (const [id, f] of drift) {
    const widget = broken.get(id);
    // A widget's lost or changed finding says more than a note that the code changed a little or wasn't checked.
    if (f.severity === 'info' && widget) continue;
    // Standing in for the widget's finding, it keeps that finding's severity (a widget reading a missing file fails the check).
    if (widget === 'error') f.severity = 'error';
    add(ctx, f);
  }
  if (manifest) {
    // Both ways: the page's ids are in the manifest, and each manifest anchor is used by the page or a widget.
    const widgetIds = scan.mayReadAny || scan.uses.some((u) => u.dynamic) ? 'any' : new Set(scan.uses.flatMap((u) => (u.id ? [u.id] : [])));
    // Trivial marks are used by definition: they mark changes, they aren't steps (docs/CHANGES-PLAN.md §3.3).
    const trivial = new Set([...manifest.anchors.values()].filter((a) => a.trivial).map((a) => a.id));
    const ids = checkIds(page, new Set(manifest.anchors.keys()), widgetIds, (id) => lines?.anchor(id), trivial);
    for (const p of ids.html) add(ctx, { ...p, file: ctx.htmlFile });
    for (const p of ids.manifest) add(ctx, { ...p, file: ctx.manifestFile });
  }
  await applyCheckRules(ctx, report, manifestText, scanned.ignores);
  return finish(report);
}

/**
 * The repository's rules (src/core/check-rules.ts): `.sidestory/checks.json`, the manifest's and its anchors'
 * "checks", and the page's data-explain-ignore. Mistakes in them are findings too, and so is an exception that no
 * longer silences anything.
 */
async function applyCheckRules(ctx: Context, report: CheckReport, manifestText: string | undefined, ignoresRaw: readonly { value: string; line: number; endLine: number; start: number; end: number }[]) {
  const checksFile = join(dirname(ctx.dir), 'checks.json');
  const checksText = await readText(checksFile);
  const global: ReturnType<typeof parseChecksFile> = checksText === undefined ? { levels: new Map(), problems: [] } : parseChecksFile(checksText);
  for (const p of global.problems) add(ctx, { severity: 'error', file: checksFile, code: 'checks-json', message: `.sidestory/checks.json ${p}.` });
  // Coverage reads only the repository root's file: a package's own minimum would do nothing, so say so.
  if (global.coverageMinimum !== undefined && !existsSync(join(dirname(dirname(ctx.dir)), '.git'))) {
    add(ctx, { severity: 'info', file: checksFile, code: 'checks-json', message: '"coverage" is read only from the .sidestory/checks.json at the repository root; this one, in a package, has no effect on branch coverage.' });
  }
  const local = manifestText === undefined ? undefined : manifestLevels(manifestText);
  for (const p of local?.problems ?? []) add(ctx, { severity: 'error', file: ctx.manifestFile, code: 'checks-json', message: `manifest.json ${p}.` });
  const ignores: Ignore[] = [];
  for (const raw of ignoresRaw) {
    const i = parseIgnore(raw.value);
    if (i.bad.length) add(ctx, { severity: 'warning', file: ctx.htmlFile, line: raw.line, code: 'ignore-syntax', message: `data-explain-ignore: ${i.bad.slice(0, 3).map((b) => `"${b.slice(0, 40)}"`).join(', ')} isn't a rule name. Write data-explain-ignore="rule-name: why".` });
    if (!i.codes.length) continue;
    if (!i.reason) add(ctx, { severity: 'warning', file: ctx.htmlFile, line: raw.line, code: 'ignore-no-reason', message: `data-explain-ignore="${raw.value.slice(0, 60)}" gives no reason: add one after a colon ("${i.codes[0]}: why"), so the next person knows why it's off.` });
    ignores.push({ codes: i.codes, reason: i.reason, line: raw.line, endLine: raw.endLine, start: raw.start, end: raw.end });
  }
  // A rule that can't be turned down, turned down anywhere: a mistake even before anything fires.
  const tried = [
    ...lockedLevels(global.levels).map((l) => ({ ...l, file: checksFile, where: '.sidestory/checks.json' })),
    ...lockedLevels(local?.sidestory ?? new Map()).map((l) => ({ ...l, file: ctx.manifestFile, where: 'manifest.json' })),
  ];
  for (const t of tried) add(ctx, { severity: 'error', file: t.file, code: 'rule-locked', message: `${t.code} ${t.why}, so it can't be turned down (${t.where}). Remove that line, and fix what it reports instead.` });
  const applied = applyRules(ctx.findings, { global: global.levels, sidestory: local?.sidestory ?? new Map(), anchors: local?.anchors ?? new Map(), ignores, htmlFile: ctx.htmlFile });
  ctx.findings.splice(0, ctx.findings.length, ...applied.findings.map(({ offset: _offset, ...f }) => f));
  for (const l of applied.locked) add(ctx, { severity: 'error', file: l.where.startsWith('data-explain-ignore') ? ctx.htmlFile : l.where === '.sidestory/checks.json' ? checksFile : ctx.manifestFile, code: 'rule-locked', message: `${l.code} ${lockedWhy(l.code)}, so it can't be turned down (${l.where}); the finding stays. Fix what it reports instead.` });
  for (const u of applied.unusedIgnores) add(ctx, { severity: 'warning', file: ctx.htmlFile, line: u.line, code: 'unused-ignore', message: `data-explain-ignore="${u.codes.join(' ')}" silences nothing here any more: remove it.` });
  if (applied.off.length) report.ignored = applied.off;
}

/** The outline the workspace index builds, and the detail links in it (docs/NAVIGATION-PLAN.md §5.3). */
async function checkOutline(ctx: Context, report: CheckReport, html: string) {
  const outline = outlineHtml(html);
  report.steps = outline.steps.map((s) => ({ id: s.id, title: s.title }));
  report.details = [...new Set(outline.details.map((d) => d.name))];
  if (outline.truncated) add(ctx, { severity: 'warning', file: ctx.htmlFile, code: 'outline-truncated', message: 'The page is too complex to outline in time: the sidebar and Go to Step list only the steps found before the scan stopped.' });
  let lines: ((offset: number) => number) | undefined;
  const self = basename(ctx.dir);
  const exists = new Map<string, Promise<boolean>>();
  for (const d of outline.details) {
    const line = (lines ??= lineIndex(html))(d.offset);
    if (d.name === self) {
      add(ctx, { severity: 'warning', file: ctx.htmlFile, line, code: 'detail-self', message: `data-explain-detail="${d.name}" names this sidestory itself; it links nowhere. Name a sibling under .sidestory/.` });
      continue;
    }
    if (!explainerNameSchema.safeParse(d.name).success) {
      add(ctx, { severity: 'warning', file: ctx.htmlFile, line, code: 'unknown-detail', message: `data-explain-detail="${d.name.slice(0, 80)}" isn't a sidestory name (letters, digits, ".", "-" and "_", at most 64).` });
      continue;
    }
    let found = exists.get(d.name);
    if (!found) {
      found = stat(join(dirname(ctx.dir), d.name, 'manifest.json')).then((st) => st.isFile(), () => false);
      exists.set(d.name, found);
    }
    if (!(await found)) {
      add(ctx, { severity: 'warning', file: ctx.htmlFile, line, code: 'unknown-detail', message: `data-explain-detail="${d.name}" names no sidestory next to this one (expected .sidestory/${d.name}/manifest.json).` });
    }
  }
}

function finish(report: CheckReport): CheckReport {
  report.errors = report.findings.filter((f) => f.severity === 'error').length;
  report.warnings = report.findings.filter((f) => f.severity === 'warning').length;
  return report;
}

const rank: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/** Findings as `file:line: severity code: message`, one plain line each: errors first, or in file order. */
export function formatFindings(findings: readonly Finding[], cwd = process.cwd(), order: 'severity' | 'place' = 'severity'): string[] {
  // Messages and file names quote repository text (compiler diagnostics, names, paths): each prints as one plain
  // line, without control, bidirectional or invisible characters.
  const shown = (file: string) => {
    const r = relative(cwd, file);
    return plainLine(r && !r.startsWith('..') && !isAbsolute(r) ? r : file);
  };
  const byPlace = (a: Finding, b: Finding) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0);
  const sorted = [...findings].sort((a, b) => (order === 'severity' ? rank[a.severity] - rank[b.severity] || byPlace(a, b) : byPlace(a, b) || rank[a.severity] - rank[b.severity]));
  return sorted.map((f) => `${shown(f.file)}${f.line ? `:${f.line}${f.column ? `:${f.column}` : ''}` : ''}: ${f.severity} ${f.code}: ${plainLine(f.message)}`);
}

/**
 * The text report. `coverage`: it comes before the coverage section, whose totals line ends the output, so the
 * widget line gives the count only, and is left out when there are no widgets.
 */
export function formatReport(report: CheckReport, cwd = process.cwd(), coverage = false): string {
  const out = formatFindings(report.findings, cwd);
  const p = report.pin;
  if (p) {
    out.push(`Pinned ${p.pinned.length} anchor(s)${p.pinned.length ? `: ${p.pinned.map((x) => x.anchor).join(', ')}` : ''}; ${p.unchanged.length} already pinned; ${p.skipped.length + p.needsConsent.length + p.held.length} not pinned.`);
    if (p.held.length) out.push(`Not re-pinned, because code was added inside them since they were pinned: ${p.held.map((h) => h.anchor).join(', ')}. Read each step, make its prose cover the new lines, then run again with --accept ${p.held.map((h) => h.anchor).join(',')}.`);
    if (p.id) out.push(`Added a stable "id" to manifest.json (${p.id}); keep it as it is.`);
    if (p.widgetsMayRead.length) {
      out.push('Widgets in this sidestory may now read (once the quotes are committed, or confirmed in VS Code):');
      for (const e of p.widgetsMayRead) out.push(`  ${plainLine(e.file)} lines ${e.range.start}–${e.range.end} (${e.lines} lines, anchor ${e.anchor})`);
    }
  }
  const n = report.widgets.length;
  const off = report.ignored ?? [];
  if (off.length) {
    const why = [...new Set(off.map((o) => `${o.code}: ${o.reason}`))].slice(0, 5);
    out.push(`${off.length} ignored by the repository's rules (${why.join('; ')}${off.length > why.length ? '; …' : ''}).`);
  }
  if (coverage) {
    if (n) out.push(`${n} widget${n === 1 ? '' : 's'} checked.`);
  } else if (n === 0) out.push(`Checked: ${report.errors} error(s), ${report.warnings} warning(s); no widgets.`);
  else out.push(`${n} widget${n === 1 ? '' : 's'} checked: ${report.errors} error(s), ${report.warnings} warning(s).`);
  return out.join('\n');
}

const USAGE = [
  'usage: node check.cjs <sidestory-dir> [--json] [--types] [--pin] [--accept <anchor>[,…]] [--yes-widgets-may-read]',
  '                      [--coverage [--base <ref>] [--committed | --head <sha>] [--new-id]]',
  '       node check.cjs --coverage --base <ref> [--committed | --head <sha>] [--repo <dir>] [--new-id] [--json]',
  '       node check.cjs threads [<root>] [--waiting] [--all] [--json]',
  '       node check.cjs threads [<root>] --watch [--json]',
  'exit codes: 0 clean; 1 errors; 2 usage or crash; 3 (--coverage) no errors, but some change isn\'t explained or marked trivial (and the repository\'s coverage minimum isn\'t met)',
].join('\n');
const bundleDir = typeof __dirname === 'string' ? __dirname : undefined;

/** Flags that take a value (`--base main` or `--base=main`). */
const VALUED = new Set(['--base', '--head', '--repo', '--accept']);
const SWITCHES = new Set(['--json', '--pin', '--yes-widgets-may-read', '--types', '--help', '--coverage', '--committed', '--new-id']);

export interface MainHooks {
  /** Tests: the git to run and the environment it inherits; the stable id --pin writes. */
  gitPath?: string;
  env?: NodeJS.ProcessEnv;
  newId?: () => string;
  /** Tests: the folder commands in messages are relative to (default: the working directory). */
  cwd?: string;
}

export async function main(argv: string[], io: { out: (s: string) => void; err: (s: string) => void } = { out: (s) => process.stdout.write(`${s}\n`), err: (s) => process.stderr.write(`${s}\n`) }, compiler?: WidgetCompilerOptions, typesDir = bundleDir && join(bundleDir, 'widget-types'), hooks: MainHooks = {}): Promise<number> {
  // `check.cjs threads …`: comment threads for agents (docs/COMMENTS-PLAN.md §10.2), unless a folder is named "threads".
  if (argv[0] === 'threads' && !(await stat('threads').then((s) => s.isDirectory(), () => false))) return threadsMain(argv.slice(1), io);
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const args: string[] = [];
  const unknown: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) {
      args.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (VALUED.has(name)) {
      const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
      if (v === undefined || v === '') {
        io.err(`${name} needs a value\n${USAGE}`);
        return 2;
      }
      values.set(name, v);
      flags.add(name);
    } else if (SWITCHES.has(a)) flags.add(a);
    else unknown.push(a);
  }
  if (flags.has('--help')) {
    io.out(USAGE);
    return 0;
  }
  const coverage = flags.has('--coverage');
  const usage = (why?: string) => {
    io.err(why ? `${why}\n${USAGE}` : USAGE);
    return 2;
  };
  if (unknown.length) return usage(`unknown option ${unknown.join(', ')}`);
  if (args.length > 1 || (args.length === 0 && !coverage)) return usage();
  if (flags.has('--yes-widgets-may-read') && !flags.has('--pin') && !flags.has('--accept')) return usage('--yes-widgets-may-read only goes with --pin or --accept');
  if (!coverage && ['--base', '--committed', '--head', '--repo', '--new-id'].some((f) => flags.has(f))) return usage('--base, --committed, --head, --repo and --new-id go with --coverage');
  if (flags.has('--committed') && flags.has('--head')) return usage('--committed and --head are two different heads: give one');
  if (args.length === 0 && !flags.has('--base')) return usage('--coverage without a sidestory needs --base <branch>');
  if (args.length === 0 && (flags.has('--pin') || flags.has('--accept') || flags.has('--types'))) return usage('--pin, --accept and --types need a sidestory folder');
  if (args.length && flags.has('--repo')) return usage('--repo is for --coverage without a sidestory (a sidestory folder names its repository)');
  const accept = values.get('--accept')?.split(',').map((x) => x.trim()).filter(Boolean) ?? [];
  const json = flags.has('--json');

  // --types: what "Add Widget Types" writes, for a terminal (typecheck with TYPECHECK_COMMAND).
  let dir: string | undefined;
  if (args.length) {
    dir = resolve(args[0]!);
    if (/sidestory\.html$|manifest\.json$/.test(dir)) dir = dirname(dir);
  }
  if (flags.has('--types') && dir) {
    const explain = dirname(dir);
    if (!typesDir || basename(explain) !== '.sidestory') {
      io.err(!typesDir ? 'check.cjs: the widget types are missing next to it' : `--types writes into the .sidestory folder, and ${dir} isn't in one`);
      return 2;
    }
    const written = await writeWidgetTypes(explain, typesDir);
    io.err(`Wrote ${written.length} files to ${explain} (tsconfig.json, .types/). Typecheck the widgets with: ${TYPECHECK_COMMAND}`);
  }

  const covOpts = { base: values.get('--base'), committed: flags.has('--committed'), head: values.get('--head'), newId: flags.has('--new-id'), gitPath: hooks.gitPath, env: hooks.env, cwd: hooks.cwd };
  // The comparison is needed for --coverage, and for pinning a sidestory with a base (base-side anchors read the
  // merge-base; anchors with code added since they were pinned are left for --accept).
  let cov: CoverageResult | undefined;
  if (coverage) cov = await runCoverage({ ...covOpts, sidestory: dir, repo: values.get('--repo') });
  else if (dir && (flags.has('--pin') || accept.length) && (await hasBase(dir))) cov = await runCoverage({ ...covOpts, sidestory: dir });

  let report: CheckReport | undefined;
  // A file anchored by several sidestories is read and prepared once.
  const files: CodeFiles = new Map();
  if (dir) {
    report = await checkExplainer(dir, { pin: flags.has('--pin'), accept, branch: cov?.branch, newId: hooks.newId, yesWidgetsMayRead: flags.has('--yes-widgets-may-read'), compiler, files, cwd: hooks.cwd });
    // Pinning moved or re-quoted anchors: count again with the manifest as it is now.
    if (coverage && report.pin && (report.pin.pinned.length || report.pin.id)) cov = await runCoverage({ ...covOpts, sidestory: dir });
  }
  if (!coverage) {
    io.out(json ? JSON.stringify(report, null, 2) : formatReport(report!));
    return report!.errors > 0 ? 1 : 0;
  }

  // The normal checks on every other sidestory that belongs (§13.1).
  // Coverage names folders by their real path; the given one may be reached through a link (macOS's /var → /private/var).
  const real = (p: string) => realpath(p).catch(() => p);
  const self = dir === undefined ? undefined : await real(dir);
  const others: CheckReport[] = [];
  for (const d of cov!.sidestoryDirs) if (d !== dir && (await real(d)) !== self) others.push(await checkExplainer(d, { compiler, files, cwd: hooks.cwd }));
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const keep = (f: Finding) => {
    const k = `${f.file}\u0000${f.line ?? 0}\u0000${f.code}\u0000${f.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  };
  for (const r of [...(report ? [report] : []), ...others]) for (const f of r.findings) if (keep(f)) findings.push(f);
  // An anchor the normal check already calls unused needs no second warning from coverage.
  const unused = new Set(findings.filter((f) => f.code === 'unused-anchor').map((f) => `${f.file}\u0000${f.line}`));
  let covFindings = cov!.findings.filter((f) => !(f.code === 'anchor-unused' && unused.has(`${f.file}\u0000${f.line}`))).filter(keep);
  // A change explained by out-of-date anchors that the normal check already reports (anchor-stale) needs no second
  // warning: matched by sidestory folder and anchor id (`--json` still marks the change stale).
  const staleIds = new Set<string>();
  for (const r of [...(report ? [report] : []), ...others]) {
    for (const f of r.findings) {
      const id = driftAnchor.get(f) ?? f.anchor; // a finding the rules re-levelled is a copy, with its anchor
      if (f.code === 'anchor-stale' && id !== undefined) staleIds.add(`${await real(r.sidestory)}\u0000${id}`);
    }
  }
  const repeated = new Set<Finding>();
  for (const s of cov!.staleExplained ?? []) {
    const keys = await Promise.all(s.anchors.map(async (a) => `${await real(a.sidestory)}\u0000${a.anchor}`));
    if (keys.length && keys.every((k) => staleIds.has(k))) repeated.add(s.finding);
  }
  covFindings = covFindings.filter((f) => !repeated.has(f));
  const all = [...findings, ...covFindings];
  const errors = all.filter((f) => f.severity === 'error').length;
  const warnings = all.filter((f) => f.severity === 'warning').length;
  if (json) {
    const base = report ? { ...report, findings: all, errors, warnings } : { findings: all, errors, warnings };
    io.out(JSON.stringify({ ...base, coverage: cov!.coverage }, null, 2));
  } else {
    const head = report ? formatReport({ ...report, findings, errors: findings.filter((f) => f.severity === 'error').length, warnings: findings.filter((f) => f.severity === 'warning').length }, process.cwd(), true) : formatFindings(findings).join('\n');
    // One summary line, last: the coverage totals and every finding's count.
    const summary = `${cov!.summary} ${errors} error(s), ${warnings} warning(s).`;
    const lines = [head, cov!.header, ...formatFindings(covFindings, process.cwd(), 'place'), summary].filter((l) => l !== '');
    io.out(lines.join('\n'));
  }
  if (errors > 0) return 1;
  return cov!.done ? 0 : 3;
}

/** The manifest names a base (read leniently; the full parse comes with the check). */
async function hasBase(dir: string): Promise<boolean> {
  const text = await readText(join(dir, 'manifest.json'));
  if (text === undefined) return false;
  const p = parseManifest(text);
  return p.ok && p.manifest.base !== undefined;
}

// Run when bundled as dist/check.cjs (or run directly by node); not when imported by tests.
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (e: unknown) => { process.stderr.write(`check.cjs: ${(e as Error)?.stack ?? e}\n`); process.exitCode = 2; },
  );
}

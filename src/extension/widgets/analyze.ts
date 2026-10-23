// One widget source module: Sucrase (TypeScript, JSX) to ES modules, then one acorn pass that finds
// imports and exports, top-level await, the artifact habits worth a warning (docs/WIDGETS-PLAN.md §2),
// and where loop guards and the `autoFocus` rename go. `finishModule` then rewrites import specifiers to
// what the runtime registers and converts the module to CommonJS. Both steps keep line numbers.
// Pure functions of the input text, so results can be cached by a hash of it.
import { parse, type Node, type Program } from 'acorn';
import { fullAncestor } from 'acorn-walk';
import { transform, type Transform } from 'sucrase';
import * as sucraseTokens from 'sucrase/dist/TokenProcessor.js';
import { applyEdits, type TextEdit } from './edits.ts';
import { loopGuardEdits } from './loop-guards.ts';
import type { Diag } from './types.ts';

/** A place a module names another: `import … from`, `export … from`, or `require('…')`. */
export interface ImportSite {
  spec: string;
  /** The specifier string literal's range in the ES-module code. */
  start: number;
  end: number;
  line: number;
  column?: number;
  /** Names imported (`default` for a default import); empty for side-effect imports and `require`. */
  names: { name: string; line: number; column?: number }[];
  namespace: boolean;
}

export interface ModuleAnalysis {
  /** ES-module code after Sucrase's TypeScript and JSX transforms. */
  code: string;
  /** Loop guards and the autoFocus rename, applied by finishModule. */
  edits: TextEdit[];
  imports: ImportSite[];
  /** Names this module exports (`default` included). */
  exports: string[];
  /** True when the module has `export * from`, so `exports` may be incomplete. */
  exportStar: boolean;
  warnings: Diag[];
  errors: Diag[];
}

const SUCRASE_COMMON = { production: true, disableESTransforms: true, jsxRuntime: 'automatic' as const };

function transformsFor(file: string): Transform[] {
  const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
  if (ext === '.ts') return ['typescript'];
  if (ext === '.tsx') return ['typescript', 'jsx'];
  return ['jsx'];
}

/**
 * The token Sucrase's transformers were on. Their own errors ("Unexpected token when processing JSX
 * children", "Invalid scope depth") carry no position, unlike its parser's; the token they threw at gives it.
 * Recorded through TokenProcessor's prototype (the instance `transform` makes is internal), cheaply: only
 * which processor is current.
 */
interface TokenCursor { tokens: { start: number }[]; tokenIndex: number }
let lastProcessor: TokenCursor | undefined;
{
  const mod = sucraseTokens as unknown as { default?: unknown };
  // CommonJS default export: `default` is the class when bundled, the module object under Node's ESM interop.
  const cls = (typeof mod.default === 'function' ? mod.default : (mod.default as { default?: unknown } | undefined)?.default) as { prototype: Record<string, unknown> } | undefined;
  const proto = cls?.prototype;
  const original = proto?.matches1 as ((this: TokenCursor, ...a: unknown[]) => boolean) | undefined;
  if (proto && original) {
    proto.matches1 = function matches1(this: TokenCursor, ...a: unknown[]) {
      lastProcessor = this;
      return original.apply(this, a);
    };
  }
}

/** Line and column (1-based) of `offset` in `text`. */
function position(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, Math.max(0, Math.min(offset, text.length)));
  const lines = before.split(/\r\n|\r|\n|\u2028|\u2029/);
  return { line: lines.length, column: lines.at(-1)!.length + 1 };
}

/** Line and column (1-based) of a compile error: from the error, its "(line:col)" suffix, or the token Sucrase was on. */
function errorLocation(e: unknown, source?: string): { line?: number; column?: number } {
  const loc = (e as { loc?: { line: number; column: number } }).loc;
  if (loc && typeof loc.line === 'number') return { line: loc.line, column: loc.column + 1 };
  const m = /\((\d+):(\d+)\)\s*$/.exec(String((e as Error)?.message ?? ''));
  if (m) return { line: Number(m[1]), column: Number(m[2]) + 1 };
  const p = lastProcessor;
  if (source === undefined || !p?.tokens.length) return {};
  const token = p.tokens[Math.min(p.tokenIndex, p.tokens.length - 1)]!;
  return position(source, p.tokenIndex >= p.tokens.length ? source.length : token.start);
}

function isStackOverflow(e: unknown): boolean {
  return e instanceof RangeError && /call stack/i.test(e.message);
}

function failure(file: string, e: unknown, stage: string, source?: string): ModuleAnalysis {
  const message = String((e as Error)?.message ?? e).replace(/\s*\(\d+:\d+\)\s*$/, '').replace(/^Error transforming [^:]*: /, '');
  const err: Diag = isStackOverflow(e)
    ? { file, code: 'too-complex', message: 'This file is nested too deeply to compile.' }
    : { file, code: 'syntax', message: `${stage}: ${message}`, ...errorLocation(e, source) };
  return { code: '', edits: [], imports: [], exports: [], exportStar: false, warnings: [], errors: [err] };
}

const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const EFFECT_OR_TIMER = new Set(['useEffect', 'useLayoutEffect', 'useInsertionEffect', 'setTimeout', 'setInterval', 'requestAnimationFrame', 'requestIdleCallback', 'queueMicrotask', 'then', 'catch', 'finally']);
const NETWORK_GLOBALS = new Set(['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource']);
const STORAGE_GLOBALS = new Set(['localStorage', 'sessionStorage']);
const WINDOW_LIKE = new Set(['window', 'globalThis', 'self']);

const RE_FULL_HEIGHT = /(?<![\w-])(?:min-|max-)?h-(?:screen|dvh|svh|lvh)(?![\w-])|\b100[dsl]?vh\b/;
const RE_REMOTE_URL = /\bhttps?:\/\/(?!www\.w3\.org\/)[^\s"'`]/i;
const RE_HSL_VAR = /hsl\(\s*var\(\s*--/;
const RE_TW3_OPACITY = /(?<![\w-])(?:bg|text|border|ring|divide|placeholder)-opacity-\d+/;
/** A page background on a widget's outermost element (artifacts paint the page; a widget sits on the panel). */
const RE_PAGE_BG = /(?<![\w-])(?:[a-z]+:)*bg-(?:white|black|(?:gray|slate|zinc|neutral|stone)-\d{2,3})(?![\w-])/;
/** Palette greys for text: fixed colors that vanish on the opposite theme (text-gray-900 in Dark). */
const RE_PALETTE_TEXT = /(?<![\w:-])text-(?:gray|slate|zinc|neutral|stone)-\d{2,3}(?![\w-])/;
const RE_DARK_TEXT = /(?<![\w-])dark:text-/;
/** A fixed width in pixels, class form. */
const RE_PX_WIDTH = /(?<![\w:-])w-\[(\d+(?:\.\d+)?)px\]/g;
/** Wider than this doesn't fit a panel beside the code. */
const NARROW_PX = 360;
/** A fixed height on the parent of a ResponsiveContainer (h-64, h-[300px], h-px). */
const RE_FIXED_HEIGHT = /(?<![\w:-])h-(?:\d+(?:\.\d+)?|px|\[\d+(?:\.\d+)?(?:px|rem|em)\])(?![\w-])/;
const RE_HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
/** JSX props that take a color (SVG and Recharts). */
const COLOR_PROPS = new Set(['stroke', 'fill', 'color', 'stopColor', 'floodColor', 'lightingColor', 'background', 'backgroundColor']);

type AnyNode = Node & Record<string, any>;

function nameOf(n: AnyNode | null | undefined): string | undefined {
  if (!n) return undefined;
  if (n.type === 'Identifier') return n.name as string;
  if (n.type === 'Literal' && typeof n.value === 'string') return n.value;
  return undefined;
}

/** True for an Identifier that refers to a variable (not a property name, label or declaration name). */
function isReference(node: AnyNode, parent: AnyNode | undefined): boolean {
  if (!parent) return true;
  switch (parent.type) {
    case 'MemberExpression':
      return parent.object === node || parent.computed;
    case 'Property':
      return parent.value === node || parent.computed;
    case 'MethodDefinition':
    case 'PropertyDefinition':
      return parent.key !== node || parent.computed;
    case 'LabeledStatement':
    case 'BreakStatement':
    case 'ContinueStatement':
    case 'ImportSpecifier':
    case 'ImportDefaultSpecifier':
    case 'ImportNamespaceSpecifier':
    case 'ExportSpecifier':
      return false;
    case 'VariableDeclarator':
      return parent.init === node;
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ClassDeclaration':
    case 'ClassExpression':
      return parent.id !== node && !(parent.params as AnyNode[] | undefined)?.includes(node);
    default:
      return true;
  }
}

/** Transforms a source module to ES-module JavaScript and analyzes it. `file` is its folder-relative path. */
export function analyzeSource(file: string, text: string): ModuleAnalysis {
  const source = text.replace(/^﻿/, '');
  let code: string;
  try {
    lastProcessor = undefined;
    code = transform(source, { ...SUCRASE_COMMON, transforms: transformsFor(file), filePath: file }).code;
  } catch (e) {
    return failure(file, e, 'Syntax error', source);
  } finally {
    lastProcessor = undefined;
  }
  let ast: Program;
  try {
    ast = parse(code, { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowHashBang: true });
  } catch (e) {
    return failure(file, e, 'Syntax error');
  }

  const srcLines = source.split(/\r\n|\r|\n|\u2028|\u2029/);
  /** 1-based column of `word` on a source line (ES-module code keeps lines, not columns), when it's there. */
  const columnOf = (line: number, word: string): number | undefined => {
    const t = srcLines[line - 1];
    if (t === undefined) return undefined;
    const m = new RegExp(`(?<![\\w$])${word.replace(/[$.*+?^()[\]{}|\\/-]/g, '\\$&')}(?![\\w$])`).exec(t);
    return m ? m.index + 1 : undefined;
  };

  const out: ModuleAnalysis = { code, edits: [], imports: [], exports: [], exportStar: false, warnings: [], errors: [] };
  const seenWarnings = new Set<string>();
  const warn = (code: string, node: AnyNode, message: string, word?: string) => {
    const line = node.loc!.start.line;
    const key = `${code}:${line}`;
    if (seenWarnings.has(key)) return;
    seenWarnings.add(key);
    out.warnings.push({ file, line, column: word ? columnOf(line, word) : undefined, code, message });
  };

  // Names bound by imports, used to recognize JSX calls and explainer navigation calls.
  const jsxLocals = new Set<string>();
  /** highlight and reveal from 'explainer', by local name. */
  const sdkLocals = new Map<string, 'highlight' | 'reveal'>();
  /** Icons from lucide-react. */
  const iconLocals = new Set<string>();
  const navLocals = new Set<string>(); // reveal, goToStep, and next/prev destructured from useStep()
  const explainerNamespaces = new Set<string>();
  const useStepLocals = new Set<string>();
  const stepObjects = new Set<string>();
  for (const stmt of ast.body as AnyNode[]) {
    if (stmt.type !== 'ImportDeclaration') continue;
    const from = stmt.source.value as string;
    for (const s of stmt.specifiers as AnyNode[]) {
      const imported = s.type === 'ImportSpecifier' ? nameOf(s.imported) : undefined;
      if (from === 'react/jsx-runtime' && imported && /^(jsx|jsxs|Fragment)$/.test(imported)) jsxLocals.add(s.local.name);
      if (from === 'explainer') {
        if (s.type === 'ImportNamespaceSpecifier') explainerNamespaces.add(s.local.name);
        if (imported === 'reveal' || imported === 'goToStep') navLocals.add(s.local.name);
        if (imported === 'useStep') useStepLocals.add(s.local.name);
        if (imported === 'highlight' || imported === 'reveal') sdkLocals.set(s.local.name, imported);
      }
      if (from === 'lucide-react' && s.type === 'ImportSpecifier') iconLocals.add(s.local.name);
    }
  }
  // The component the widget renders: the default export (a function, or a name bound to one).
  const defaultFns = new Set<AnyNode>();
  {
    const byName = new Map<string, AnyNode>();
    for (const stmt of ast.body as AnyNode[]) {
      const d = stmt.type === 'ExportNamedDeclaration' && stmt.declaration ? stmt.declaration : stmt;
      if (d.type === 'FunctionDeclaration' && d.id) byName.set(d.id.name, d);
      if (d.type === 'VariableDeclaration') for (const v of d.declarations as AnyNode[]) if (v.id.type === 'Identifier' && v.init && FUNCTIONS.has(v.init.type)) byName.set(v.id.name, v.init);
    }
    for (const stmt of ast.body as AnyNode[]) {
      if (stmt.type !== 'ExportDefaultDeclaration') continue;
      const d = stmt.declaration as AnyNode;
      if (FUNCTIONS.has(d.type)) defaultFns.add(d);
      else if (d.type === 'Identifier' && byName.has(d.name)) defaultFns.add(byName.get(d.name)!);
    }
  }
  /** Every string in an expression (a className, cn(...) arguments, a template). */
  const strings = (n: AnyNode | undefined): string[] => {
    const out: string[] = [];
    const walk = (x: AnyNode | null | undefined) => {
      if (!x || typeof x !== 'object') return;
      if (x.type === 'Literal' && typeof x.value === 'string') out.push(x.value);
      else if (x.type === 'TemplateElement' && typeof x.value?.cooked === 'string') out.push(x.value.cooked);
      for (const k of Object.keys(x)) {
        if (k === 'loc' || k === 'start' || k === 'end') continue;
        const v = (x as Record<string, unknown>)[k];
        if (Array.isArray(v)) for (const c of v) walk(c as AnyNode);
        else if (v && typeof v === 'object' && 'type' in (v as object)) walk(v as AnyNode);
      }
    };
    walk(n);
    return out;
  };
  const prop = (props: AnyNode | undefined, name: string): AnyNode | undefined =>
    props?.type === 'ObjectExpression' ? (props.properties as AnyNode[]).find((p) => p.type === 'Property' && !p.computed && nameOf(p.key) === name) : undefined;
  /** A literal line number (or [first, last]) a call would drop: below 1, or not a whole number. */
  const badLines = (n: AnyNode | undefined): string | undefined => {
    if (!n) return undefined;
    const nums = n.type === 'ArrayExpression' ? (n.elements as (AnyNode | null)[]) : [n];
    for (const e of nums) {
      if (!e) continue;
      const v = e.type === 'Literal' && typeof e.value === 'number' ? e.value : e.type === 'UnaryExpression' && e.operator === '-' && e.argument.type === 'Literal' && typeof e.argument.value === 'number' ? -e.argument.value : undefined;
      if (v !== undefined && (!Number.isInteger(v) || v < 1)) return String(v);
    }
    return undefined;
  };
  const isUseStepCall = (n: AnyNode | null | undefined): boolean =>
    !!n &&
    n.type === 'CallExpression' &&
    ((n.callee.type === 'Identifier' && useStepLocals.has(n.callee.name)) ||
      (n.callee.type === 'MemberExpression' && n.callee.object.type === 'Identifier' && explainerNamespaces.has(n.callee.object.name) && nameOf(n.callee.property) === 'useStep'));
  const isJsxCall = (n: AnyNode): boolean => n.type === 'CallExpression' && n.callee.type === 'Identifier' && jsxLocals.has(n.callee.name);

  const navCalls: { node: AnyNode; chain: AnyNode[]; fn: AnyNode | undefined; name: string }[] = [];
  const awaits: { node: AnyNode; fn: AnyNode | undefined }[] = [];

  const addSite = (sourceNode: AnyNode, names: ImportSite['names'], namespace: boolean) => {
    const line = sourceNode.loc!.start.line;
    out.imports.push({ spec: sourceNode.value as string, start: sourceNode.start, end: sourceNode.end, line, column: columnOf(line, String(sourceNode.value)), names, namespace });
  };

  fullAncestor(ast, (n, _state, ancestors) => {
    const node = n as AnyNode;
    const parent = ancestors[ancestors.length - 2] as AnyNode | undefined;
    const fns = (ancestors as AnyNode[]).filter((a) => a !== node && FUNCTIONS.has(a.type));
    switch (node.type) {
      case 'ImportDeclaration': {
        const names: ImportSite['names'] = [];
        let namespace = false;
        for (const s of node.specifiers as AnyNode[]) {
          const line = s.loc!.start.line;
          if (s.type === 'ImportNamespaceSpecifier') namespace = true;
          else if (s.type === 'ImportDefaultSpecifier') names.push({ name: 'default', line, column: columnOf(line, s.local.name) });
          else {
            const name = nameOf(s.imported)!;
            names.push({ name, line, column: columnOf(line, name) });
          }
        }
        addSite(node.source, names, namespace);
        break;
      }
      case 'ExportNamedDeclaration': {
        if (node.declaration) {
          const d = node.declaration as AnyNode;
          if (d.type === 'VariableDeclaration') {
            for (const decl of d.declarations as AnyNode[]) collectPatternNames(decl.id, out.exports);
          } else if (d.id) out.exports.push(d.id.name);
        }
        for (const s of node.specifiers as AnyNode[]) out.exports.push(nameOf(s.exported)!);
        if (node.source) {
          const names = (node.specifiers as AnyNode[]).map((s) => {
            const name = nameOf(s.local)!;
            const line = s.loc!.start.line;
            return { name, line, column: columnOf(line, name) };
          });
          addSite(node.source, names, false);
        }
        break;
      }
      case 'ExportDefaultDeclaration':
        out.exports.push('default');
        break;
      case 'ExportAllDeclaration':
        if (node.exported) out.exports.push(nameOf(node.exported)!);
        else out.exportStar = true;
        addSite(node.source, [], true);
        break;
      case 'ImportExpression':
        out.errors.push({ file, line: node.loc!.start.line, column: columnOf(node.loc!.start.line, 'import'), code: 'dynamic-import', message: 'Dynamic import() is not supported in widgets; use a static import at the top of the file.' });
        break;
      case 'AwaitExpression':
        awaits.push({ node, fn: fns.at(-1) });
        if (fns.length === 0) {
          out.errors.push({ file, line: node.loc!.start.line, column: columnOf(node.loc!.start.line, 'await'), code: 'top-level-await', message: 'Top-level await is not supported in widgets; move the work into an async function or an effect (useEffect).' });
        }
        break;
      case 'ForOfStatement':
        if (node.await && fns.length === 0) {
          out.errors.push({ file, line: node.loc!.start.line, column: columnOf(node.loc!.start.line, 'await'), code: 'top-level-await', message: 'Top-level for await is not supported in widgets; move it into an async function or an effect (useEffect).' });
        }
        break;
      case 'CallExpression': {
        const callee = node.callee as AnyNode;
        // require('x') written in the source (not one of ours: the CommonJS conversion comes later).
        if (callee.type === 'Identifier' && callee.name === 'require' && node.arguments.length === 1 && node.arguments[0].type === 'Literal' && typeof node.arguments[0].value === 'string') {
          addSite(node.arguments[0], [], true);
        }
        if (isJsxCall(node)) {
          const props = node.arguments[1] as AnyNode | undefined;
          const tag = node.arguments[0] as AnyNode | undefined;
          if (props?.type === 'ObjectExpression') {
            for (const p of props.properties as AnyNode[]) {
              if (p.type === 'Property' && !p.computed && nameOf(p.key) === 'autoFocus') {
                warn('autofocus', p, 'autoFocus is ignored in widgets (it would take focus from the editor); focus moves into a widget only when the reader clicks it.', 'autoFocus');
                out.edits.push(p.shorthand ? { start: p.start, end: p.end, text: '"data-cx-autofocus": autoFocus', order: 2 } : { start: p.key.start, end: p.key.end, text: '"data-cx-autofocus"', order: 2 });
              }
            }
          }
          const tagName = tag?.type === 'Identifier' ? tag.name : tag?.type === 'MemberExpression' ? nameOf(tag.property) : tag?.type === 'Literal' ? String(tag.value) : undefined;
          const outer = (ancestors as AnyNode[]).filter((a) => a !== node && isJsxCall(a));
          if (tagName === 'ResponsiveContainer') {
            const height = prop(props, 'height');
            // A parent with a set height (h-64, h-[300px], style={{height: 300}}) gives 100% something to resolve against.
            const parent = outer.at(-1)?.arguments[1] as AnyNode | undefined;
            const parentHeight = strings(prop(parent, 'className')?.value).some((c) => RE_FIXED_HEIGHT.test(c)) || !!prop(prop(parent, 'style')?.value, 'height');
            if (!parentHeight && (!height || (height.value.type === 'Literal' && height.value.value === '100%'))) {
              warn('responsive-height', node, 'ResponsiveContainer with height="100%" needs a parent with a set height (h-64), which a widget\'s box doesn\'t have; give it a number (height={300}), an aspect, or a parent with a fixed height.', 'ResponsiveContainer');
            }
          }
          // The outermost element the component returns: a page background paints a slab on the panel.
          const chain = ancestors as AnyNode[];
          let fnAt = chain.length - 2;
          while (fnAt >= 0 && !FUNCTIONS.has(chain[fnAt]!.type)) fnAt--;
          const fn = chain[fnAt];
          const returned = !!fn && defaultFns.has(fn) && (fn.body === node || chain.slice(fnAt + 1, -1).some((a) => a.type === 'ReturnStatement'));
          if (outer.length === 0 && returned) {
            const bg = strings(prop(props, 'className')?.value).map((c) => RE_PAGE_BG.exec(c)?.[0]).find(Boolean);
            if (bg) warn('page-background', node, `${bg} on the widget's outermost element paints a page background over the panel (a slab in other themes); leave the root transparent, and use bg-card or bg-muted for a panel inside it.`, bg.replace(/^.*:/, ''));
          }
          // Hard-coded colors in color props ignore the theme.
          for (const p of props?.type === 'ObjectExpression' ? (props.properties as AnyNode[]) : []) {
            const key = p.type === 'Property' && !p.computed ? nameOf(p.key) : undefined;
            if (key && COLOR_PROPS.has(key) && p.value.type === 'Literal' && typeof p.value.value === 'string' && RE_HEX.test(p.value.value)) {
              warn('hex-color', p, `${key}="${p.value.value}" is fixed: it ignores the VS Code theme (and high contrast). Use a theme color: var(--chart-1) … var(--chart-6), var(--primary), var(--muted-foreground) or currentColor.`, p.value.value.slice(1));
            }
          }
          // An icon-only button needs a name for screen readers.
          if (tagName === 'Button' || tagName === 'button') {
            const children = prop(props, 'children')?.value as AnyNode | undefined;
            const kids = children?.type === 'ArrayExpression' ? (children.elements as AnyNode[]) : children ? [children] : [];
            const iconOnly = kids.length > 0 && kids.every((k) => k && isJsxCall(k) && k.arguments[0]?.type === 'Identifier' && iconLocals.has(k.arguments[0].name));
            if (iconOnly && !['aria-label', 'aria-labelledby', 'title'].some((n) => prop(props, n))) {
              warn('icon-button-label', node, 'This button shows only an icon: give it aria-label="…" (what it does), so screen readers can name it.', tagName);
            }
          }
        }
        // highlight() and reveal() arguments the runtime would drop.
        const sdk = callee.type === 'Identifier' ? sdkLocals.get(callee.name)
          : callee.type === 'MemberExpression' && callee.object.type === 'Identifier' && explainerNamespaces.has(callee.object.name) && ['highlight', 'reveal'].includes(nameOf(callee.property) ?? '') ? (nameOf(callee.property) as 'highlight' | 'reveal') : undefined;
        if (sdk === 'highlight') {
          const bad = badLines(node.arguments[0]);
          if (bad !== undefined) warn('highlight-lines', node, `highlight(${bad}): lines are whole numbers from 1, counted from the anchor's first line (pair them with useAnchorCode().startLine); this call is dropped.`, 'highlight');
        }
        if (sdk === 'reveal') {
          const opts = node.arguments[1] as AnyNode | undefined;
          const bad = badLines(prop(opts, 'lines')?.value);
          if (bad !== undefined) warn('reveal-lines', node, `reveal(…, {lines: ${bad}}): lines are whole numbers from 1, counted from the anchor's first line; this call returns false.`, 'reveal');
          const hl = prop(opts, 'highlight')?.value as AnyNode | undefined;
          if (hl && (hl.type === 'Literal' || hl.type === 'ObjectExpression' || hl.type === 'TemplateLiteral')) {
            warn('reveal-highlight', node, `reveal(…, {highlight}) takes a list of identifiers to mark in the code (highlight: ['wr', 'rd']), not ${hl.type === 'Literal' ? JSON.stringify(hl.value) : 'that'}; this call returns false.`, 'reveal');
          }
        }
        // Navigation from explainer (reveal, goToStep, next/prev) — collected, judged after the walk.
        let navName: string | undefined;
        if (callee.type === 'Identifier' && navLocals.has(callee.name)) navName = callee.name;
        else if (callee.type === 'MemberExpression' && callee.object.type === 'Identifier') {
          const prop = nameOf(callee.property);
          if (explainerNamespaces.has(callee.object.name) && (prop === 'reveal' || prop === 'goToStep')) navName = prop;
          if (stepObjects.has(callee.object.name) && (prop === 'next' || prop === 'prev')) navName = `${callee.object.name}.${prop}`;
        }
        if (navName) navCalls.push({ node, chain: [...(ancestors as AnyNode[])], fn: fns.at(-1), name: navName });
        break;
      }
      case 'VariableDeclarator':
        if (isUseStepCall(node.init)) {
          if (node.id.type === 'Identifier') stepObjects.add(node.id.name);
          else if (node.id.type === 'ObjectPattern') {
            for (const p of node.id.properties as AnyNode[]) {
              const key = p.type === 'Property' ? nameOf(p.key) : undefined;
              if ((key === 'next' || key === 'prev') && p.value.type === 'Identifier') navLocals.add(p.value.name);
            }
          }
        }
        break;
      case 'Identifier':
        if (!isReference(node, parent)) break;
        if (NETWORK_GLOBALS.has(node.name)) warn('network', node, `Widgets can't use the network (${node.name}); import data as ./data.json instead.`, node.name);
        if (STORAGE_GLOBALS.has(node.name)) warn('storage', node, `${node.name} in a widget is kept in memory only; use useWidgetState from 'explainer' to keep what the reader sets.`, node.name);
        if (node.name === 'innerHeight') warn('inner-height', node, 'innerHeight is the panel\'s height, not the widget\'s; size the widget to its content or give it a fixed height.', 'innerHeight');
        break;
      case 'MemberExpression': {
        const prop = node.computed ? undefined : nameOf(node.property);
        const obj = node.object as AnyNode;
        if (!prop || obj.type !== 'Identifier') break;
        if (WINDOW_LIKE.has(obj.name)) {
          if (prop === 'innerHeight') warn('inner-height', node, 'window.innerHeight is the panel\'s height, not the widget\'s; size the widget to its content or give it a fixed height.', 'innerHeight');
          if (NETWORK_GLOBALS.has(prop)) warn('network', node, `Widgets can't use the network (${prop}); import data as ./data.json instead.`, prop);
          if (STORAGE_GLOBALS.has(prop)) warn('storage', node, `${prop} in a widget is kept in memory only; use useWidgetState from 'explainer' to keep what the reader sets.`, prop);
        }
        if (obj.name === 'navigator' && prop === 'sendBeacon') warn('network', node, "Widgets can't use the network (sendBeacon).", 'sendBeacon');
        break;
      }
      case 'Literal':
        if (typeof node.value === 'string') checkString(node.value, node);
        break;
      case 'TemplateElement':
        if (typeof node.value?.cooked === 'string') checkString(node.value.cooked, node);
        break;
    }
  });

  function checkString(s: string, node: AnyNode) {
    if (s.length > 100_000) return;
    let m: RegExpExecArray | null;
    if ((m = RE_FULL_HEIGHT.exec(s))) warn('full-height', node, `${m[0]} sizes to the panel, not the widget; widgets are as tall as their content (use a fixed height like h-80).`, m[0]);
    if (RE_REMOTE_URL.test(s)) warn('remote-url', node, 'Widgets can\'t load remote URLs; put the file in the sidestory folder and import it (./image.png, ./data.json).');
    if (RE_HSL_VAR.test(s)) warn('hsl-var', node, 'hsl(var(--…)) doesn\'t work here: theme variables are complete colors; use var(--primary) or the Tailwind class (bg-primary).');
    if ((m = RE_TW3_OPACITY.exec(s))) warn('tw3-opacity', node, `${m[0]} is Tailwind v3; Tailwind v4 uses a slash: bg-black/50.`, m[0]);
    if ((m = RE_PALETTE_TEXT.exec(s)) && !RE_DARK_TEXT.test(s)) warn('palette-text', node, `${m[0]} is a fixed grey: it nearly vanishes in dark (or light) themes. Use text-foreground or text-muted-foreground, which follow the theme.`, m[0]);
    for (const w of s.matchAll(RE_PX_WIDTH)) {
      if (Number(w[1]) <= NARROW_PX) continue;
      warn('fixed-width', node, `${w[0]} is wider than a narrow panel (about ${NARROW_PX} px beside the code), where it gets clipped. Use w-full max-w-[${w[1]}px]; for content that must be wide (a waveform, a table), wrap it in a div with overflow-x-auto.`, w[0]);
      break;
    }
  }

  for (const call of navCalls) {
    const line = call.node.loc!.start.line;
    // Inside a function passed to an effect, a timer or a promise callback, at any depth?
    const deferred = call.chain.some((f, i) => {
      const p = call.chain[i - 1];
      if (!FUNCTIONS.has(f.type) || p?.type !== 'CallExpression' || !(p.arguments as AnyNode[]).includes(f)) return false;
      const c = p.callee as AnyNode;
      const name = c.type === 'Identifier' ? c.name : c.type === 'MemberExpression' ? nameOf(c.property) : undefined;
      return !!name && EFFECT_OR_TIMER.has(name);
    });
    const afterAwait = awaits.some((a) => a.fn === call.fn && a.node.end <= call.node.start);
    if (deferred || afterAwait) {
      const shown = call.name.includes('.') ? call.name.split('.')[1]! : call.name;
      out.warnings.push({
        file,
        line,
        column: columnOf(line, shown),
        code: 'needs-click',
        message: `${shown}() only works when called directly from a click or key handler in the widget, not ${afterAwait ? 'after an await' : 'from an effect, a timer or a promise callback'}.`,
      });
    }
  }

  out.edits.push(...loopGuardEdits(ast));
  return out;
}

function collectPatternNames(p: AnyNode, out: string[]): void {
  if (p.type === 'Identifier') out.push(p.name);
  else if (p.type === 'ObjectPattern') for (const q of p.properties as AnyNode[]) collectPatternNames(q.type === 'RestElement' ? q.argument : q.value, out);
  else if (p.type === 'ArrayPattern') for (const q of p.elements as (AnyNode | null)[]) q && collectPatternNames(q.type === 'RestElement' ? q.argument : q, out);
  else if (p.type === 'AssignmentPattern') collectPatternNames(p.left, out);
}

/**
 * Applies the analysis edits plus import specifier rewrites (literal range → new specifier), then converts
 * the module to CommonJS. Line numbers stay those of the source.
 */
export function finishModule(file: string, a: ModuleAnalysis, rewrites: Map<number, string>): { code: string } | { error: Diag } {
  const edits: TextEdit[] = [...a.edits];
  for (const [start, spec] of rewrites) {
    const site = a.imports.find((s) => s.start === start);
    if (site) edits.push({ start: site.start, end: site.end, text: JSON.stringify(spec), order: 2 });
  }
  try {
    const esm = applyEdits(a.code, edits);
    return { code: transform(esm, { ...SUCRASE_COMMON, transforms: ['imports'], filePath: file }).code };
  } catch (e) {
    return { error: { file, code: isStackOverflow(e) ? 'too-complex' : 'syntax', message: isStackOverflow(e) ? 'This file is nested too deeply to compile.' : `Can't convert this file: ${(e as Error).message}`, ...errorLocation(e) } };
  }
}

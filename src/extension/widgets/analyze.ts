// One widget source module: Sucrase (TypeScript, JSX) to ES modules, then one acorn pass that finds
// imports and exports, top-level await, the artifact habits worth a warning (docs/WIDGETS-PLAN.md §2),
// and where loop guards and the `autoFocus` rename go. `finishModule` then rewrites import specifiers to
// what the runtime registers and converts the module to CommonJS. Both steps keep line numbers.
// Pure functions of the input text, so results can be cached by a hash of it.
import { parse, type Node, type Program } from 'acorn';
import { fullAncestor } from 'acorn-walk';
import { transform, type Transform } from 'sucrase';
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

/** Line and column (1-based) of a parser error, read from the error or its "(line:col)" suffix. */
function errorLocation(e: unknown): { line?: number; column?: number } {
  const loc = (e as { loc?: { line: number; column: number } }).loc;
  if (loc && typeof loc.line === 'number') return { line: loc.line, column: loc.column + 1 };
  const m = /\((\d+):(\d+)\)\s*$/.exec(String((e as Error)?.message ?? ''));
  return m ? { line: Number(m[1]), column: Number(m[2]) + 1 } : {};
}

function isStackOverflow(e: unknown): boolean {
  return e instanceof RangeError && /call stack/i.test(e.message);
}

function failure(file: string, e: unknown, stage: string): ModuleAnalysis {
  const err: Diag = isStackOverflow(e)
    ? { file, code: 'too-complex', message: 'This file is nested too deeply to compile.' }
    : { file, code: 'syntax', message: `${stage}: ${String((e as Error)?.message ?? e).replace(/\s*\(\d+:\d+\)\s*$/, '')}`, ...errorLocation(e) };
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
    code = transform(source, { ...SUCRASE_COMMON, transforms: transformsFor(file), filePath: file }).code;
  } catch (e) {
    return failure(file, e, 'Syntax error');
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
      }
    }
  }
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
          const tagName = tag?.type === 'Identifier' ? tag.name : tag?.type === 'MemberExpression' ? nameOf(tag.property) : undefined;
          if (tagName === 'ResponsiveContainer') {
            const height = props?.type === 'ObjectExpression' ? (props.properties as AnyNode[]).find((p) => p.type === 'Property' && nameOf(p.key) === 'height') : undefined;
            if (!height || (height.value.type === 'Literal' && height.value.value === '100%')) {
              warn('responsive-height', node, 'ResponsiveContainer with height="100%" needs a parent with a set height, which a widget\'s box doesn\'t have; give it a number (height={300}) or an aspect.', 'ResponsiveContainer');
            }
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
    if (RE_REMOTE_URL.test(s)) warn('remote-url', node, 'Widgets can\'t load remote URLs; put the file in the explainer folder and import it (./image.png, ./data.json).');
    if (RE_HSL_VAR.test(s)) warn('hsl-var', node, 'hsl(var(--…)) doesn\'t work here: theme variables are complete colors; use var(--primary) or the Tailwind class (bg-primary).');
    if ((m = RE_TW3_OPACITY.exec(s))) warn('tw3-opacity', node, `${m[0]} is Tailwind v3; Tailwind v4 uses a slash: bg-black/50.`, m[0]);
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

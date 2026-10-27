// Static placement checks for the standalone widget checker (docs/WIDGETS-PLAN.md §3 "Placement contract"):
// finds CSS that gives a widget's ancestors a geometry transform, a clip/mask/filter, content-visibility,
// fixed or sticky positioning, a geometry animation, or a scrolling box. Best effort: rules are matched
// against the widget's ancestor chain for selectors made of type, class, id and attribute selectors with
// descendant and child combinators; rules with other selectors (state pseudo-classes, sibling combinators,
// :has() …) are skipped rather than guessed. The panel checks the real layout at run time.
import { describeElement, lineIndex, type Element } from './html.ts';

export interface Declaration {
  prop: string;
  /** Lowercased, without !important. */
  value: string;
  /** As written, for messages. */
  raw: string;
}

export interface Rule {
  selectors: string[];
  decls: Declaration[];
  /** 1-based line in the HTML file (or the stylesheet) where the rule starts. */
  line: number;
  /** Enclosing conditional at-rules (@media …), outermost first. */
  conditions: string[];
  /** For linked stylesheets: the file, relative to the explainer folder. */
  file?: string;
}

export interface ParsedCss {
  rules: Rule[];
  /** @keyframes names that animate geometry (transform, position or size). */
  geometryKeyframes: Set<string>;
}

function stripComments(css: string): string {
  // Keep line breaks so line numbers survive.
  return css.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, (c) => c.replace(/[^\r\n]/g, ' '));
}

export function parseDeclarations(block: string): Declaration[] {
  const out: Declaration[] = [];
  for (const part of splitTop(block, ';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const prop = part.slice(0, i).trim().toLowerCase();
    const raw = part.slice(i + 1).replace(/!important\s*$/i, '').trim().replace(/\s+/g, ' ');
    if (prop && raw) out.push({ prop, value: raw.toLowerCase(), raw });
  }
  return out;
}

/** Splits on `sep` outside parentheses, brackets and strings. */
function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
    else if (c === sep && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

/** The matching close brace for the `{` at `open`, or -1. */
function blockEnd(css: string, open: number): number {
  let depth = 0;
  let quote = '';
  for (let i = open; i < css.length; i++) {
    const c = css[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

/** Parses a stylesheet. `firstLine` is the line its text starts on. */
export function parseCss(text: string, firstLine = 1, file?: string, into: ParsedCss = { rules: [], geometryKeyframes: new Set() }): ParsedCss {
  const css = stripComments(text);
  let lines: ((offset: number) => number) | undefined;
  const lineAt = (offset: number) => firstLine - 1 + (lines ??= lineIndex(css))(offset);
  const walk = (from: number, to: number, conditions: string[]) => {
    let i = from;
    while (i < to) {
      const open = css.indexOf('{', i);
      const semi = css.indexOf(';', i);
      if (open < 0 || open >= to) return;
      const prelude = css.slice(i, open);
      // A statement at-rule (@import …;) before the next block.
      if (semi >= 0 && semi < open && /^\s*@/.test(css.slice(i, semi))) {
        i = semi + 1;
        continue;
      }
      const close = blockEnd(css, open);
      if (close < 0 || close > to) return;
      const head = prelude.trim();
      const start = i + prelude.length - prelude.trimStart().length;
      if (head.startsWith('@')) {
        const name = /^@([\w-]+)/.exec(head)?.[1]?.toLowerCase() ?? '';
        if (name === 'media' || name === 'supports' || name === 'container' || name === 'document') {
          walk(open + 1, close, [...conditions, head.replace(/\s+/g, ' ')]);
        } else if (name === 'layer' || name === 'scope') {
          walk(open + 1, close, conditions);
        } else if (name.endsWith('keyframes')) {
          const kf = head.slice(name.length + 1).trim().replace(/^["']|["']$/g, '');
          if (/(^|[;{\s])(transform|translate|rotate|scale|top|left|right|bottom|inset|width|height|margin[\w-]*|offset[\w-]*|zoom)\s*:/i.test(css.slice(open + 1, close))) {
            into.geometryKeyframes.add(kf);
          }
        }
      } else if (head) {
        const body = css.slice(open + 1, close);
        // Nested rules (CSS nesting) aren't matched; only this rule's own declarations.
        const own = body.replace(/[^{};]*\{[^{}]*\}/g, '');
        into.rules.push({ selectors: splitTop(head, ',').map((s) => s.trim()).filter(Boolean), decls: parseDeclarations(own), line: lineAt(start), conditions, file });
      }
      i = close + 1;
    }
  };
  walk(0, css.length, []);
  return into;
}

// ---- selector matching against an ancestor chain ----

interface Compound {
  tag?: string;
  ids: string[];
  classes: string[];
  attrs: { name: string; op?: string; value?: string }[];
}
type Step = { compound: Compound; combinator: ' ' | '>' | null };

/**
 * Parses a selector into compounds, left to right, each with the combinator that joins it to the one
 * before; undefined when the selector uses anything we don't model.
 */
export function parseSelector(sel: string): Step[] | undefined {
  const steps: Step[] = [];
  let i = 0;
  const s = sel.trim();
  let combinator: ' ' | '>' | null = null;
  while (i < s.length) {
    const c: Compound = { ids: [], classes: [], attrs: [] };
    let any = false;
    const tag = /^(\*|[a-zA-Z][\w-]*)/.exec(s.slice(i));
    if (tag) {
      if (tag[1] !== '*') c.tag = tag[1]!.toLowerCase();
      i += tag[0].length;
      any = true;
    }
    for (;;) {
      const rest = s.slice(i);
      let m: RegExpExecArray | null;
      if ((m = /^#(-?[_a-zA-Z][\w-]*)/.exec(rest))) c.ids.push(m[1]!);
      else if ((m = /^\.(-?[_a-zA-Z][\w-]*)/.exec(rest))) c.classes.push(m[1]!);
      else if ((m = /^\[\s*([\w-]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*)?(?:\s[is])?\s*\]/.exec(rest))) {
        c.attrs.push({ name: m[1]!.toLowerCase(), op: m[2], value: m[3] ?? m[4] ?? m[5] });
      } else if ((m = /^:root(?![\w-])/.exec(rest))) c.tag = 'html';
      else break;
      i += m[0].length;
      any = true;
    }
    if (!any) return undefined;
    steps.push({ compound: c, combinator });
    const ws = /^\s*/.exec(s.slice(i))![0];
    i += ws.length;
    if (i >= s.length) break;
    if (s[i] === '>') {
      combinator = '>';
      i++;
      i += /^\s*/.exec(s.slice(i))![0].length;
    } else if (ws.length > 0 && /^[a-zA-Z*#.[:]/.test(s.slice(i))) {
      combinator = ' ';
    } else {
      return undefined; // a sibling combinator, a pseudo-class or pseudo-element, or something unusual
    }
  }
  return steps.length ? steps : undefined;
}

function matchesCompound(c: Compound, el: Element): boolean {
  if (c.tag && c.tag !== el.name) return false;
  if (c.ids.length && !c.ids.every((id) => el.attrs.get('id') === id)) return false;
  const classes = new Set((el.attrs.get('class') ?? '').split(/\s+/).filter(Boolean));
  if (!c.classes.every((k) => classes.has(k))) return false;
  for (const a of c.attrs) {
    const v = el.attrs.get(a.name);
    if (v === undefined) return false;
    if (!a.op) continue;
    const want = a.value ?? '';
    const ok =
      a.op === '=' ? v === want
      : a.op === '~=' ? v.split(/\s+/).includes(want)
      : a.op === '|=' ? v === want || v.startsWith(`${want}-`)
      : a.op === '^=' ? want !== '' && v.startsWith(want)
      : a.op === '$=' ? want !== '' && v.endsWith(want)
      : want !== '' && v.includes(want);
    if (!ok) return false;
  }
  return true;
}

/** Whether the selector matches chain[index], given its ancestors chain[0..index-1]. */
export function matches(steps: Step[], chain: Element[], index: number): boolean {
  if (steps.length === 1) return matchesCompound(steps[0]!.compound, chain[index]!);
  // Memoized by (step, element): without it, descendant combinators over a deep chain backtrack
  // exponentially (C(depth, steps) tries). 0 = not worked out yet, 1 = matches, 2 = doesn't.
  const memo = new Int8Array(steps.length * (index + 1));
  const go = (k: number, at: number): boolean => {
    const slot = k * (index + 1) + at;
    if (memo[slot]) return memo[slot] === 1;
    const ok = matchesCompound(steps[k]!.compound, chain[at]!) && (k === 0 || rest(k, at));
    memo[slot] = ok ? 1 : 2;
    return ok;
  };
  const rest = (k: number, at: number): boolean => {
    if (steps[k]!.combinator === '>') return at > 0 && go(k - 1, at - 1);
    for (let j = at - 1; j >= 0; j--) if (go(k - 1, j)) return true;
    return false;
  };
  return go(steps.length - 1, index);
}

// ---- the placement problems ----

export interface PlacementProblem {
  severity: 'error' | 'warning';
  /** The ancestor (or the widget element itself, at the end of the chain). */
  element: Element;
  property: string;
  value: string;
  /** Where the declaration is: "style attribute", or a rule's line. */
  source: { kind: 'inline' } | { kind: 'rule'; line: number; file?: string; selector: string; conditions: string[] };
}

type Kind = 'error' | 'scroll' | 'transition';

/** What a declaration does to a widget inside the element: an unsupported ancestor, a scroller, or nothing. */
function classify(d: Declaration, keyframes: Set<string>): Kind | undefined {
  const v = d.value;
  const none = /^(none|initial|unset|revert|revert-layer|inherit)$/.test(v);
  switch (d.prop) {
    case 'transform':
    case 'translate':
    case 'rotate':
    case 'scale':
    case 'clip-path':
    case 'mask':
    case 'mask-image':
    case '-webkit-mask':
    case '-webkit-mask-image':
    case 'filter':
      return none || (d.prop === 'scale' && v === '1') ? undefined : 'error';
    case 'content-visibility':
      return v === 'auto' || v === 'hidden' ? 'error' : undefined;
    case 'position':
      return v === 'fixed' || v === 'sticky' ? 'error' : undefined;
    case 'overflow':
    case 'overflow-x':
    case 'overflow-y':
    case 'overflow-block':
    case 'overflow-inline':
      return /\b(auto|scroll)\b/.test(v) ? 'scroll' : undefined;
    case 'animation':
    case 'animation-name':
      return v.split(',').some((part) => part.trim().split(/\s+/).some((w) => keyframes.has(w))) ? 'error' : undefined;
    case 'transition':
    case 'transition-property':
      return /(^|[\s,])(all|transform|translate|rotate|scale|top|left|right|bottom|inset|width|height|margin[\w-]*|zoom)(?=$|[\s,])/.test(v) ? 'transition' : undefined;
    default:
      return undefined;
  }
}

interface RelevantRule {
  rule: Rule;
  /** The rule's selectors this checker can match, parsed. */
  selectors: { sel: string; steps: Step[] }[];
}

/** Per stylesheet: the rules with a declaration that can matter to a widget, and the sizes they were worked out at. */
const relevant = new WeakMap<ParsedCss, { rules: number; keyframes: number; list: RelevantRule[] }>();

/** The rules worth matching against widget ancestors, classified and parsed once per (unchanged) stylesheet. */
function relevantRules(css: ParsedCss): RelevantRule[] {
  const cached = relevant.get(css);
  if (cached && cached.rules === css.rules.length && cached.keyframes === css.geometryKeyframes.size) return cached.list;
  const parsed = new Map<string, Step[] | undefined>();
  const list: RelevantRule[] = [];
  for (const rule of css.rules) {
    if (!rule.decls.some((d) => classify(d, css.geometryKeyframes))) continue;
    const selectors: RelevantRule['selectors'] = [];
    for (const sel of rule.selectors) {
      if (!parsed.has(sel)) parsed.set(sel, parseSelector(sel));
      const steps = parsed.get(sel);
      if (steps) selectors.push({ sel, steps });
    }
    if (selectors.length) list.push({ rule, selectors });
  }
  relevant.set(css, { rules: css.rules.length, keyframes: css.geometryKeyframes.size, list });
  return list;
}

/**
 * Problems for a widget whose ancestor chain is `ancestors` (outermost first) and whose own element is
 * `widget`. Inline styles and unconditional rules give errors (for unsupported ancestors); rules inside
 * @media and the like, scrolling ancestors and geometry transitions give warnings.
 */
export function placementProblems(ancestors: Element[], widget: Element, css: ParsedCss): PlacementProblem[] {
  const chain = [...ancestors, widget];
  const out: PlacementProblem[] = [];
  const rules = relevantRules(css);
  const seen = new Set<string>();
  const add = (p: PlacementProblem) => {
    const key = `${chain.indexOf(p.element)}:${p.property}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(p);
  };
  chain.forEach((el, index) => {
    const isWidget = index === chain.length - 1;
    const consider = (d: Declaration, source: PlacementProblem['source']) => {
      const kind = classify(d, css.geometryKeyframes);
      if (!kind) return;
      // The widget element itself is a block the panel sizes; its own overflow and transitions don't matter.
      if (isWidget && kind !== 'error') return;
      const conditional = source.kind === 'rule' && source.conditions.length > 0;
      const severity = kind === 'error' && !conditional ? 'error' : 'warning';
      add({ severity, element: el, property: d.prop, value: d.raw, source });
    };
    const style = el.attrs.get('style');
    if (style) for (const d of parseDeclarations(style)) consider(d, { kind: 'inline' });
    for (const { rule, selectors } of rules) {
      for (const { sel, steps } of selectors) {
        if (!matches(steps, chain, index)) continue;
        for (const d of rule.decls) consider(d, { kind: 'rule', line: rule.line, file: rule.file, selector: sel, conditions: rule.conditions });
        break;
      }
    }
  });
  return out;
}

export function describeProblem(p: PlacementProblem, isWidget: boolean): string {
  const who = isWidget ? 'the <explain-widget> itself' : `ancestor ${describeElement(p.element)} (line ${p.element.line})`;
  const where = p.source.kind === 'inline'
    ? 'in its style attribute'
    : `from \`${p.source.selector}\` (${p.source.file ?? 'sidestory.html'}:${p.source.line}${p.source.conditions.length ? `, inside ${p.source.conditions.join(' ')}` : ''})`;
  const decl = `${p.property}: ${p.value}`;
  if (/^overflow/.test(p.property)) {
    return `${who} scrolls (${decl}, ${where}). The widget is shown only while that box doesn't actually overflow; when it does, readers get the fallback. Move the widget out of the scrolling box.`;
  }
  if (/^transition/.test(p.property)) {
    return `${who} transitions its geometry (${decl}, ${where}). While a transition runs the widget can't follow it and may be hidden; transition only colors and opacity on widget ancestors.`;
  }
  const conditional = p.source.kind === 'rule' && p.source.conditions.length > 0;
  return `${who} has ${decl} ${where}. Widgets can't be shown inside elements with a transform, clip-path, mask, filter, content-visibility, fixed or sticky position, or a geometry animation; readers get the fallback${conditional ? ' when that condition holds' : ''}. Move the widget out of it, or drop the property.`;
}

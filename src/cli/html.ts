// A small, tolerant HTML scanner for the standalone widget checker (docs/WIDGETS-PLAN.md §2): finds each
// <explain-widget> with its attributes, JSON props child, fallback, ancestors and enclosing anchor, plus
// the sidestory's stylesheets and step anchors. It runs on the shared linear tokenizer and tree builder
// (src/core/html-scan.ts, docs/NAVIGATION-PLAN.md §6.2), so it stays linear on hostile input; lines are
// worked out only for what is reported. Lines are 1-based.
import { HtmlTokenizer, TreeBuilder, type StartTag } from '../core/html-scan.ts';

export interface Element {
  name: string;
  attrs: Map<string, string>;
  line: number;
}

export interface WidgetElement {
  line: number;
  attrs: Map<string, string>;
  /** Open elements around the widget, outermost first (html, body, …). */
  ancestors: Element[];
  /** The nearest ancestor with data-explain-anchor, if any. */
  anchor: string | undefined;
  /** JSON children (<script type="application/json">), in order, with the line their text starts on. */
  jsonChildren: { text: string; line: number }[];
  /** Whether it has content other than whitespace and the JSON child (the fallback). */
  hasFallback: boolean;
  /** Written as <explain-widget …/>, which HTML doesn't close. */
  selfClosing: boolean;
  /** Inside another <explain-widget>. */
  nested: boolean;
}

export interface StyleSource {
  /** Where the CSS came from: a <style> element (line of its text) or a linked stylesheet. */
  kind: 'style' | 'link';
  line: number;
  text?: string;
  href?: string;
}

export interface ScannedHtml {
  widgets: WidgetElement[];
  styles: StyleSource[];
  /** Ids of anchored elements with no anchored ancestor: the steps. */
  steps: string[];
  /** Every data-explain-anchor id in the page. */
  anchors: string[];
  /** Elements with data-explain-ignore, with the lines they span (the checker's element exceptions). */
  ignores: { value: string; line: number; endLine: number; start: number; end: number }[];
  /**
   * Boxes in a diagram that light up per step (data-explain-on, inside an <svg>: a shape and a text label in one
   * part, not a wire or an arrow) with no code link on, in or around them.
   */
  unlinkedBoxes: { line: number; offset: number; el: Element }[];
}

/** 1-based line of each offset, by binary search over line starts. */
export function lineIndex(text: string): (offset: number) => number {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10 || (c === 13 && text.charCodeAt(i + 1) !== 10)) starts.push(i + 1);
  }
  return (offset: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** What makes a lit diagram part a box (with a <text> label), rather than a wire (a path, an arrowhead polygon). */
const BOX_SHAPES = new Set(['rect', 'circle', 'ellipse']);

/** Widgets past this many get no ancestor list (each copy is up to MAX_DEPTH elements); only 24 run anyway. */
const MAX_WIDGETS_WITH_ANCESTORS = 1000;

/** An element whose line is worked out only when asked for (most never are). */
class ScanElement implements Element {
  readonly name: string;
  readonly attrs: Map<string, string>;
  readonly offset: number;
  private readonly lineOf: (offset: number) => number;
  constructor(name: string, attrs: Map<string, string>, offset: number, lineOf: (offset: number) => number) {
    this.name = name;
    this.attrs = attrs;
    this.offset = offset;
    this.lineOf = lineOf;
  }
  get line(): number {
    return this.lineOf(this.offset);
  }
}

function isBlank(s: string, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    const c = s.charCodeAt(i);
    if (!(c === 32 || c === 9 || c === 10 || c === 12 || c === 13)) return false;
  }
  return true;
}

export function scanHtml(html: string): ScannedHtml {
  let lines: ((offset: number) => number) | undefined;
  const lineOf = (offset: number) => (lines ??= lineIndex(html))(offset);
  const widgets: WidgetElement[] = [];
  const styles: StyleSource[] = [];
  const steps: string[] = [];
  const anchors: string[] = [];
  /** Open widgets, innermost last. */
  const openWidgets: { el: Element; widget: WidgetElement }[] = [];
  /** Open anchored elements, innermost last. */
  const openAnchors: Element[] = [];
  const ignores: ScannedHtml['ignores'] = [];
  const openIgnores = new Map<Element, ScannedHtml['ignores'][number]>();
  const unlinkedBoxes: ScannedHtml['unlinkedBoxes'] = [];
  /** Open lit diagram parts, innermost last: whether a code link, a shape and a label were seen in them. */
  const openBoxes: { el: Element; linked: boolean; shape: boolean; label: boolean }[] = [];
  let svgDepth = 0;
  /** Open elements with a code link: a part inside one is linked through it (a click on it opens that code). */
  const openLinks = new Set<Element>();
  /** Where the tokenizer is, and whether that token is an end tag: an element ends where the token that closes it starts. */
  let at = 0;
  let atEnd = false;
  const markContent = () => {
    const w = openWidgets.at(-1);
    if (w) w.widget.hasFallback = true;
  };

  /** Every start tag, after its implied ends; `pushed` when it is now the innermost open element. */
  const start = (el: ScanElement, t: StartTag, pushed: boolean) => {
    const ignore = t.attrs.get('data-explain-ignore');
    if (ignore !== undefined) {
      const entry = { value: ignore, line: el.line, endLine: el.line, start: el.offset, end: el.offset + 1 };
      ignores.push(entry);
      if (pushed) openIgnores.set(el, entry);
    }
    const linked = t.attrs.has('data-explain-code') || t.attrs.has('data-explain-ref');
    if (linked) for (const b of openBoxes) b.linked = true;
    const inLink = linked || openLinks.size > 0;
    if (linked && pushed) openLinks.add(el);
    const shape = BOX_SHAPES.has(t.name);
    const label = t.name === 'text';
    for (const b of openBoxes) {
      b.shape ||= shape;
      b.label ||= label;
    }
    if (svgDepth > 0 && pushed && (t.attrs.get('data-explain-on') ?? '').trim()) openBoxes.push({ el, linked: inLink, shape, label });
    if (t.name === 'svg' && pushed) svgDepth++;
    const stack = tree.stack;
    const below = pushed ? stack.length - 1 : stack.length;
    const anchorId = t.attrs.get('data-explain-anchor');
    if (anchorId !== undefined) {
      anchors.push(anchorId);
      if (openAnchors.length === 0) steps.push(anchorId);
    }
    if (t.name === 'explain-widget') {
      markContent();
      const widget: WidgetElement = {
        line: el.line,
        attrs: t.attrs,
        ancestors: widgets.length < MAX_WIDGETS_WITH_ANCESTORS ? stack.slice(0, below) : [],
        anchor: openAnchors.at(-1)?.attrs.get('data-explain-anchor'),
        jsonChildren: [],
        hasFallback: false,
        selfClosing: t.selfClosing,
        nested: openWidgets.length > 0,
      };
      widgets.push(widget);
      if (pushed) openWidgets.push({ el, widget });
    } else if (t.raw) {
      const w = openWidgets.at(-1);
      const isJson = t.name === 'script' && (t.attrs.get('type') ?? '').trim().toLowerCase() === 'application/json';
      const text = html.slice(t.raw.start, t.raw.end);
      if (isJson && w && stack.at(-1) === w.el) {
        w.widget.jsonChildren.push({ text, line: lineOf(t.raw.start) });
      } else {
        markContent();
        if (t.name === 'style') styles.push({ kind: 'style', line: lineOf(t.raw.start), text });
      }
    } else {
      markContent();
      if (t.name === 'link' && /(^|\s)stylesheet(\s|$)/i.test(t.attrs.get('rel') ?? '') && t.attrs.get('href')) {
        styles.push({ kind: 'link', line: el.line, href: t.attrs.get('href') });
      }
    }
    if (pushed && anchorId !== undefined) openAnchors.push(el);
  };

  const tree: TreeBuilder<ScanElement> = new TreeBuilder<ScanElement>((t) => new ScanElement(t.name, t.attrs, t.offset, lineOf), {
    open: (el, t) => start(el, t, true),
    leaf: (el, t) => start(el, t, false),
    raw: (el, t) => start(el, t, false),
    close: (el) => {
      const ig = openIgnores.get(el);
      if (ig) {
        // Closed by its end tag: that tag's line. Closed by the next element's start (a <p> or <li> without an end
        // tag): the line before it, so the exception doesn't reach into that element.
        ig.end = at;
        ig.endLine = atEnd || at === html.length ? lineOf(at) : lineOf(Math.max(el.offset, at - 1));
        openIgnores.delete(el);
      }
      if (openBoxes.at(-1)?.el === el) {
        const b = openBoxes.pop()!;
        if (!b.linked && b.shape && b.label) unlinkedBoxes.push({ line: el.line, offset: el.offset, el });
      }
      if (el.name === 'svg' && svgDepth > 0) svgDepth--;
      openLinks.delete(el);
      if (openWidgets.at(-1)?.el === el) openWidgets.pop();
      if (openAnchors.at(-1) === el) openAnchors.pop();
    },
    text: (s, e) => {
      if (openWidgets.length && !isBlank(html, s, e)) markContent();
    },
  });

  const tokens = new HtmlTokenizer(html);
  for (let t = tokens.next(); t; t = tokens.next()) {
    if ('offset' in t && typeof t.offset === 'number') {
      at = t.offset;
      atEnd = t.kind === 'end';
    }
    tree.token(t);
  }
  at = html.length;
  tree.finish();
  return { widgets, styles, steps, anchors, ignores, unlinkedBoxes };
}

/** A short description of an element for messages: div#id.class1.class2 */
export function describeElement(el: Element): string {
  const id = el.attrs.get('id');
  const classes = (el.attrs.get('class') ?? '').split(/\s+/).filter(Boolean).slice(0, 3);
  return `${el.name}${id ? `#${id}` : ''}${classes.map((c) => `.${c}`).join('')}`;
}

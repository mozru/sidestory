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
}

/** 1-based line of each offset, by binary search over line starts. A lone `\r` ends a line unless `lfOnly`. */
export function lineIndex(text: string, lfOnly = false): (offset: number) => number {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10 || (!lfOnly && c === 13 && text.charCodeAt(i + 1) !== 10)) starts.push(i + 1);
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
  const markContent = () => {
    const w = openWidgets.at(-1);
    if (w) w.widget.hasFallback = true;
  };

  /** Every start tag, after its implied ends; `pushed` when it is now the innermost open element. */
  const start = (el: ScanElement, t: StartTag, pushed: boolean) => {
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
      if (openWidgets.at(-1)?.el === el) openWidgets.pop();
      if (openAnchors.at(-1) === el) openAnchors.pop();
    },
    text: (s, e) => {
      if (openWidgets.length && !isBlank(html, s, e)) markContent();
    },
  });

  const tokens = new HtmlTokenizer(html);
  for (let t = tokens.next(); t; t = tokens.next()) {
    tree.token(t);
  }
  tree.finish();
  return { widgets, styles, steps, anchors };
}

/** A short description of an element for messages: div#id.class1.class2 */
export function describeElement(el: Element): string {
  const id = el.attrs.get('id');
  const classes = (el.attrs.get('class') ?? '').split(/\s+/).filter(Boolean).slice(0, 3);
  return `${el.name}${id ? `#${id}` : ''}${classes.map((c) => `.${c}`).join('')}`;
}

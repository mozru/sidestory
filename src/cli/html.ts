// A small, tolerant HTML scanner for the standalone widget checker (docs/WIDGETS-PLAN.md §2): finds each
// <explain-widget> with its attributes, JSON props child, fallback, ancestors and enclosing anchor, plus
// the explainer's stylesheets and step anchors. Not a full HTML parser: it follows the parts of the tree
// building rules that matter here (void elements, raw text, implied end tags of lists, tables, options and
// paragraphs) and is otherwise best effort. Lines are 1-based.

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

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'keygen', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext']);
/** Start tags that close an open <p> (the block-level elements of the HTML spec's list). */
const CLOSES_P = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'dialog', 'div', 'dl', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'ul',
]);
/** For an implied end tag: the elements a start tag closes, and the ones that stop the search. */
const IMPLIED: Record<string, { closes: string[]; scope: string[] }> = {
  li: { closes: ['li'], scope: ['ul', 'ol', 'menu'] },
  dt: { closes: ['dt', 'dd'], scope: ['dl'] },
  dd: { closes: ['dt', 'dd'], scope: ['dl'] },
  option: { closes: ['option'], scope: ['select', 'datalist', 'optgroup'] },
  optgroup: { closes: ['optgroup', 'option'], scope: ['select'] },
  tr: { closes: ['tr', 'td', 'th'], scope: ['table', 'thead', 'tbody', 'tfoot'] },
  td: { closes: ['td', 'th'], scope: ['tr', 'table'] },
  th: { closes: ['td', 'th'], scope: ['tr', 'table'] },
  thead: { closes: ['thead', 'tbody', 'tfoot', 'tr', 'td', 'th'], scope: ['table'] },
  tbody: { closes: ['thead', 'tbody', 'tfoot', 'tr', 'td', 'th'], scope: ['table'] },
  tfoot: { closes: ['thead', 'tbody', 'tfoot', 'tr', 'td', 'th'], scope: ['table'] },
};

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
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

const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttrs(s: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const m of s.matchAll(ATTR)) {
    const name = m[1]!.toLowerCase();
    if (!attrs.has(name)) attrs.set(name, decodeEntities(m[2] ?? m[3] ?? m[4] ?? ''));
  }
  return attrs;
}

const TAG = /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\?[^>]*>|<\/([a-zA-Z][^\s/>]*)[^>]*>|<([a-zA-Z][^\s/>]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;

export function scanHtml(html: string): ScannedHtml {
  const lineOf = lineIndex(html);
  const stack: Element[] = [];
  const widgets: WidgetElement[] = [];
  const styles: StyleSource[] = [];
  const steps: string[] = [];
  const anchors: string[] = [];
  /** The widget currently open (innermost), as an index into `widgets`. */
  const openWidgets: { el: Element; widget: WidgetElement }[] = [];

  const popTo = (i: number) => {
    for (const el of stack.splice(i)) {
      if (openWidgets.at(-1)?.el === el) openWidgets.pop();
    }
  };
  const closeTag = (name: string) => {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i]!.name === name) return popTo(i);
  };
  const markContent = () => {
    const w = openWidgets.at(-1);
    if (w) w.widget.hasFallback = true;
  };

  TAG.lastIndex = 0;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG.exec(html))) {
    if (html.slice(last, m.index).trim()) markContent();
    last = TAG.lastIndex;
    const [, endName, startName, rest = ''] = m;
    if (endName) {
      closeTag(endName.toLowerCase());
      continue;
    }
    if (!startName) continue; // comment, doctype, processing instruction
    const name = startName.toLowerCase();
    const line = lineOf(m.index);
    const attrs = parseAttrs(rest);
    const selfClosing = /\/\s*$/.test(rest);

    // Implied end tags.
    if (CLOSES_P.has(name)) {
      for (let i = stack.length - 1; i >= 0; i--) {
        const n = stack[i]!.name;
        if (n === 'p') { popTo(i); break; }
        if (n === 'button' || n === 'td' || n === 'th' || n === 'table' || n === 'explain-widget') break;
      }
    }
    const implied = IMPLIED[name];
    if (implied) {
      for (let i = stack.length - 1; i >= 0; i--) {
        const n = stack[i]!.name;
        if (implied.closes.includes(n)) { popTo(i); break; }
        if (implied.scope.includes(n)) break;
      }
    }

    const el: Element = { name, attrs, line };
    const anchorId = attrs.get('data-explain-anchor');
    if (anchorId !== undefined) {
      anchors.push(anchorId);
      if (!stack.some((a) => a.attrs.has('data-explain-anchor'))) steps.push(anchorId);
    }

    if (name === 'explain-widget') {
      markContent();
      const anchorEl = [...stack].reverse().find((a) => a.attrs.has('data-explain-anchor'));
      const widget: WidgetElement = {
        line, attrs, ancestors: [...stack], anchor: anchorEl?.attrs.get('data-explain-anchor'),
        jsonChildren: [], hasFallback: false, selfClosing, nested: openWidgets.length > 0,
      };
      widgets.push(widget);
      if (!selfClosing) {
        stack.push(el);
        openWidgets.push({ el, widget });
      }
      continue;
    }

    if (RAW_TEXT.has(name)) {
      const close = new RegExp(`</${name}(?![\\w-])[^>]*>`, 'ig');
      close.lastIndex = TAG.lastIndex;
      const end = close.exec(html);
      const textStart = TAG.lastIndex;
      const textEnd = end ? end.index : html.length;
      const text = html.slice(textStart, textEnd);
      const w = openWidgets.at(-1);
      const isJson = name === 'script' && (attrs.get('type') ?? '').trim().toLowerCase() === 'application/json';
      if (isJson && w && stack.at(-1) === w.el) {
        w.widget.jsonChildren.push({ text, line: lineOf(textStart) });
      } else {
        markContent();
        if (name === 'style') styles.push({ kind: 'style', line: lineOf(textStart), text });
      }
      // Skip past the end tag.
      TAG.lastIndex = end ? end.index + end[0].length : html.length;
      last = TAG.lastIndex;
      continue;
    }

    markContent();
    if (name === 'link' && /(^|\s)stylesheet(\s|$)/i.test(attrs.get('rel') ?? '') && attrs.get('href')) {
      styles.push({ kind: 'link', line, href: attrs.get('href') });
    }
    const foreignSelfClosing = selfClosing && (name === 'svg' || name === 'math' || isForeign(stack));
    if (!VOID.has(name) && !foreignSelfClosing) stack.push(el);
  }
  if (html.slice(last).trim()) markContent();
  return { widgets, styles, steps, anchors };
}

/** Inside <svg> or <math>, a trailing "/" does close the element. */
function isForeign(stack: Element[]): boolean {
  return stack.some((e) => e.name === 'svg' || e.name === 'math');
}

/** A short description of an element for messages: div#id.class1.class2 */
export function describeElement(el: Element): string {
  const id = el.attrs.get('id');
  const classes = (el.attrs.get('class') ?? '').split(/\s+/).filter(Boolean).slice(0, 3);
  return `${el.name}${id ? `#${id}` : ''}${classes.map((c) => `.${c}`).join('')}`;
}

// A linear, resumable HTML scanner for untrusted pages (docs/NAVIGATION-PLAN.md §6.2), shared by the workspace
// index's outline (steps, titles, blurbs, detail links) and the standalone checker (src/cli/html.ts).
//
// - The tokenizer is driven by indexOf and character tests; no regex ever runs over an unbounded span, and
//   every character is visited a bounded number of times. An unclosed quote, comment, `<!x` or `</a ` runs to
//   the end of the input once and stops there.
// - The tree builder keeps an element stack capped at MAX_DEPTH (deeper nesting is counted, not tracked), and
//   for each tag name the stack positions of its open elements. An end tag with no open element of its name is
//   ignored in O(1); implied ends (`p`, `li`, `option`, table parts …) look up the nearest open element and the
//   nearest scope boundary in O(1) and only then pop down to it.
// - It never executes, evaluates or resolves anything. Its output is plain strings.
//
// Not a full HTML parser: it follows the tree-building rules that matter for finding steps, headings, detail
// links and widgets, and is otherwise best effort (no foster parenting, no adoption agency).
import { displayText, firstSentence } from './display-text.ts';
import { stepTitle } from './step-title.ts';
import { DROPPED_ELEMENTS } from '../shared/sanitize-lists.ts';

/** A copy of `s` that shares no memory with the string it was cut from. */
export function flat(s: string): string {
  // JSON.parse builds a new sequential string; the one it was cut from can then be collected.
  return s.length === 0 ? '' : (JSON.parse(JSON.stringify(s)) as string);
}

// ---- entities ----

/** Named references matched in any case (as HTML does for these). */
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
/**
 * Common named references (case-sensitive, as in HTML), so the outline's titles read like the panel's text.
 * Not the whole HTML5 table: anything else is kept as written.
 */
const NAMED: Record<string, string> = {
  mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', middot: '\u00b7', bull: '\u2022', deg: '\u00b0',
  rarr: '\u2192', larr: '\u2190', harr: '\u2194', uarr: '\u2191', darr: '\u2193', rArr: '\u21d2', lArr: '\u21d0',
  hArr: '\u21d4', times: '\u00d7', divide: '\u00f7', plusmn: '\u00b1', minus: '\u2212', le: '\u2264', ge: '\u2265',
  ne: '\u2260', asymp: '\u2248', equiv: '\u2261', infin: '\u221e', sum: '\u2211', prod: '\u220f', radic: '\u221a',
  part: '\u2202', isin: '\u2208', notin: '\u2209', and: '\u2227', or: '\u2228', not: '\u00ac', cap: '\u2229',
  cup: '\u222a', sub: '\u2282', sup: '\u2283', forall: '\u2200', exist: '\u2203', lsquo: '\u2018', rsquo: '\u2019',
  ldquo: '\u201c', rdquo: '\u201d', sbquo: '\u201a', bdquo: '\u201e', laquo: '\u00ab', raquo: '\u00bb',
  lsaquo: '\u2039', rsaquo: '\u203a', prime: '\u2032', Prime: '\u2033', dagger: '\u2020', Dagger: '\u2021',
  sect: '\u00a7', para: '\u00b6', copy: '\u00a9', reg: '\u00ae', trade: '\u2122', euro: '\u20ac', pound: '\u00a3',
  yen: '\u00a5', cent: '\u00a2', micro: '\u00b5', frac12: '\u00bd', frac14: '\u00bc', frac34: '\u00be',
  sup1: '\u00b9', sup2: '\u00b2', sup3: '\u00b3', alpha: '\u03b1', beta: '\u03b2', gamma: '\u03b3', delta: '\u03b4',
  epsilon: '\u03b5', lambda: '\u03bb', mu: '\u03bc', pi: '\u03c0', sigma: '\u03c3', tau: '\u03c4', phi: '\u03c6',
  omega: '\u03c9', Delta: '\u0394', Sigma: '\u03a3', Omega: '\u03a9', shy: '\u00ad', zwj: '\u200d', zwnj: '\u200c',
  ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009', iexcl: '\u00a1', iquest: '\u00bf', auml: '\u00e4',
  ouml: '\u00f6', uuml: '\u00fc', Auml: '\u00c4', Ouml: '\u00d6', Uuml: '\u00dc', szlig: '\u00df', eacute: '\u00e9',
  egrave: '\u00e8', aacute: '\u00e1', agrave: '\u00e0', ccedil: '\u00e7', ntilde: '\u00f1', oslash: '\u00f8',
  aring: '\u00e5',
};

/** Decodes numeric references and common named ones; everything else is kept as written. Linear. */
export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]{1,8}|#\d{1,8}|[a-zA-Z]{1,10});/g, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    // Own properties only: "&toString;" must not find Object.prototype.toString.
    if (Object.hasOwn(NAMED, e)) return NAMED[e]!;
    const lower = e.toLowerCase();
    return Object.hasOwn(ENTITIES, lower) ? ENTITIES[lower]! : m;
  });
}

// ---- tokenizer ----

/** Elements whose content is text up to their end tag (never markup). */
export const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext']);
export const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'keygen', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

export interface StartTag {
  kind: 'start';
  /** Lowercased. */
  name: string;
  /** First occurrence wins; names lowercased, values with entities decoded. */
  attrs: Map<string, string>;
  /** Offset of the `<`. */
  offset: number;
  /** A `/` right before the `>`. */
  selfClosing: boolean;
  /** For raw-text elements: where their text is (the end tag is consumed with it). */
  raw?: { start: number; end: number };
}
export interface EndTag {
  kind: 'end';
  name: string;
  offset: number;
}
export interface TextToken {
  kind: 'text';
  start: number;
  end: number;
}
export type Token = StartTag | EndTag | TextToken;

const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
const isAlpha = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);

/** Attributes kept per tag; browsers keep more, but no sidestory needs them. */
export const MAX_ATTRS = 256;

/** Pull tokens one at a time with `next()`; undefined at the end. Linear in the input. */
export class HtmlTokenizer {
  private pos = 0;
  private pending: Token | undefined;
  readonly html: string;
  constructor(html: string) {
    this.html = html;
  }

  /** How far the tokenizer has got. */
  get offset(): number {
    return this.pos;
  }

  next(): Token | undefined {
    if (this.pending) {
      const t = this.pending;
      this.pending = undefined;
      return t;
    }
    const s = this.html;
    const len = s.length;
    while (this.pos < len) {
      const lt = s.indexOf('<', this.pos);
      if (lt < 0) {
        const t: TextToken = { kind: 'text', start: this.pos, end: len };
        this.pos = len;
        return t;
      }
      const textStart = this.pos;
      const tag = this.markup(lt);
      if (tag === null) {
        // A "<" that starts no markup is text: include it and keep going.
        const t: TextToken = { kind: 'text', start: textStart, end: lt + 1 };
        this.pos = lt + 1;
        return t;
      }
      if (lt > textStart) {
        // Text first, then the markup.
        const t: TextToken = { kind: 'text', start: textStart, end: lt };
        this.pending = tag === undefined ? undefined : tag;
        return t;
      }
      if (tag) return tag;
      // A comment, doctype or processing instruction: skipped (this.pos is already past it).
    }
    return undefined;
  }

  /**
   * Reads the markup at `lt`. Returns a token, undefined for markup that yields nothing (comments), or null when
   * the "<" is just text. Always advances `pos` past what it consumed, except for null.
   */
  private markup(lt: number): Token | undefined | null {
    const s = this.html;
    const len = s.length;
    const c = s.charCodeAt(lt + 1);
    if (c === 33 /* ! */) {
      if (s.startsWith('<!--', lt)) {
        // `<!-->` and `<!--->` close at once, as in browsers.
        if (s.startsWith('>', lt + 4)) return this.skipTo(lt + 5);
        if (s.startsWith('->', lt + 4)) return this.skipTo(lt + 6);
        const end = s.indexOf('-->', lt + 4);
        return this.skipTo(end < 0 ? len : end + 3);
      }
      const end = s.indexOf('>', lt + 2);
      return this.skipTo(end < 0 ? len : end + 1);
    }
    if (c === 63 /* ? */) {
      const end = s.indexOf('>', lt + 2);
      return this.skipTo(end < 0 ? len : end + 1);
    }
    if (c === 47 /* / */) {
      const c2 = s.charCodeAt(lt + 2);
      if (!isAlpha(c2)) {
        if (c2 === 62 /* > */) return this.skipTo(lt + 3); // `</>` is ignored
        if (lt + 2 >= len) return null;
        const end = s.indexOf('>', lt + 2); // a bogus comment
        return this.skipTo(end < 0 ? len : end + 1);
      }
      let i = lt + 2;
      while (i < len) {
        const ch = s.charCodeAt(i);
        if (isSpace(ch) || ch === 47 || ch === 62) break;
        i++;
      }
      const name = s.slice(lt + 2, i).toLowerCase();
      const end = s.indexOf('>', i);
      if (end < 0) {
        this.pos = len; // an end tag cut off by the end of the input is dropped
        return undefined;
      }
      this.pos = end + 1;
      return { kind: 'end', name, offset: lt };
    }
    if (!isAlpha(c)) return null;
    return this.startTag(lt);
  }

  private skipTo(p: number): undefined {
    this.pos = p;
    return undefined;
  }

  private startTag(lt: number): StartTag | undefined {
    const s = this.html;
    const len = s.length;
    let i = lt + 1;
    while (i < len) {
      const ch = s.charCodeAt(i);
      if (isSpace(ch) || ch === 47 || ch === 62) break;
      i++;
    }
    const name = s.slice(lt + 1, i).toLowerCase();
    const attrs = new Map<string, string>();
    let slash = false;
    for (;;) {
      while (i < len && isSpace(s.charCodeAt(i))) i++;
      if (i >= len) {
        this.pos = len; // a tag cut off by the end of the input is dropped
        return undefined;
      }
      const ch = s.charCodeAt(i);
      if (ch === 62 /* > */) {
        i++;
        break;
      }
      if (ch === 47 /* / */) {
        slash = true;
        i++;
        continue;
      }
      slash = false;
      // Attribute name: up to whitespace, "/", ">" or "=" (a leading "=" belongs to the name).
      const nameStart = i;
      i++;
      while (i < len) {
        const d = s.charCodeAt(i);
        if (isSpace(d) || d === 47 || d === 62 || d === 61) break;
        i++;
      }
      const attrName = s.slice(nameStart, i).toLowerCase();
      let value = '';
      let j = i;
      while (j < len && isSpace(s.charCodeAt(j))) j++;
      if (j < len && s.charCodeAt(j) === 61 /* = */) {
        j++;
        while (j < len && isSpace(s.charCodeAt(j))) j++;
        const q = s.charCodeAt(j);
        if (q === 34 || q === 39) {
          const close = s.indexOf(q === 34 ? '"' : "'", j + 1);
          if (close < 0) {
            this.pos = len; // an unclosed quote runs to the end, once
            return undefined;
          }
          value = s.slice(j + 1, close);
          i = close + 1;
        } else {
          let k = j;
          while (k < len) {
            const d = s.charCodeAt(k);
            if (isSpace(d) || d === 62) break;
            k++;
          }
          value = s.slice(j, k);
          i = k;
        }
      }
      // Past MAX_ATTRS, later attributes are scanned but not kept: one tag with a million of them stays cheap.
      if (attrs.size < MAX_ATTRS && !attrs.has(attrName)) attrs.set(attrName, decodeEntities(value));
    }
    const tag: StartTag = { kind: 'start', name, attrs, offset: lt, selfClosing: slash };
    if (RAW_TEXT.has(name)) {
      const textEnd = name === 'plaintext' ? len : this.findEndTag(name, i);
      tag.raw = { start: i, end: textEnd };
      if (textEnd >= len) this.pos = len;
      else {
        const gt = s.indexOf('>', textEnd);
        this.pos = gt < 0 ? len : gt + 1;
      }
      return tag;
    }
    this.pos = i;
    return tag;
  }

  /** Where `</name` (any case, followed by a non-name character) starts at or after `from`; the input's length if nowhere. */
  private findEndTag(name: string, from: number): number {
    const s = this.html;
    let p = from;
    for (;;) {
      const at = s.indexOf('</', p);
      if (at < 0) return s.length;
      const after = at + 2 + name.length;
      if (s.slice(at + 2, after).toLowerCase() === name) {
        const d = s.charCodeAt(after);
        if (Number.isNaN(d) || isSpace(d) || d === 47 || d === 62) return at;
      }
      p = at + 2;
    }
  }
}

// ---- tree builder ----

/** Deeper elements are counted, not tracked. */
export const MAX_DEPTH = 512;

/** Start tags that close an open <p> (the block-level elements of the HTML spec's list). */
const CLOSES_P = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'dialog', 'div', 'dl', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'ul',
]);
/** For an implied end tag: the elements a start tag closes, and the ones that stop the search. */
const IMPLIED: Record<string, { closes: string[]; scope: string[] }> = {
  p: { closes: ['p'], scope: ['button', 'td', 'th', 'table', 'explain-widget'] },
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

export interface Frame {
  name: string;
  attrs: Map<string, string>;
  offset: number;
}

export interface TreeEvents<F extends Frame> {
  /** An element was pushed on the stack (it can have content). */
  open?(frame: F, tag: StartTag): void;
  /** An element was popped (closed by its end tag, an implied end or the end of input). */
  close?(frame: F): void;
  /** An element that takes no content: void, self-closing in SVG/MathML, or beyond MAX_DEPTH. */
  leaf?(frame: F, tag: StartTag): void;
  /** A raw-text element (script, style …), with its text range; never pushed. */
  raw?(frame: F, tag: StartTag): void;
  /** Text between tags. */
  text?(start: number, end: number): void;
}

/**
 * Builds the element tree from tokens, as events. `make` creates each element's frame (callers keep their own
 * per-element state on it). Every operation is O(1) amortized: popping is paid for by pushing.
 */
export class TreeBuilder<F extends Frame> {
  readonly stack: F[] = [];
  /** Elements opened beyond MAX_DEPTH and not yet closed (approximate: any end tag closes one). */
  overflow = 0;
  /** Stack indexes of the open elements of each name, innermost last. */
  private readonly open = new Map<string, number[]>();
  /** Open <svg> and <math> elements: inside them a trailing "/" closes an element. */
  private foreign = 0;

  private readonly make: (tag: StartTag) => F;
  private readonly events: TreeEvents<F>;

  constructor(make: (tag: StartTag) => F, events: TreeEvents<F>) {
    this.make = make;
    this.events = events;
  }

  /** The innermost open element of this name, or -1. */
  innermost(name: string): number {
    const list = this.open.get(name);
    return list && list.length ? list[list.length - 1]! : -1;
  }

  /** How many elements of this name are open (tracked ones). */
  count(name: string): number {
    return this.open.get(name)?.length ?? 0;
  }

  token(t: Token): void {
    if (t.kind === 'text') this.events.text?.(t.start, t.end);
    else if (t.kind === 'end') this.endTag(t.name);
    else this.startTag(t);
  }

  /** Closes everything still open (the end of the input). */
  finish(): void {
    this.popTo(0);
  }

  private nearest(names: readonly string[]): number {
    let best = -1;
    for (const n of names) best = Math.max(best, this.innermost(n));
    return best;
  }

  private startTag(t: StartTag): void {
    if (this.overflow === 0) {
      if (CLOSES_P.has(t.name)) this.implied(IMPLIED.p!);
      const rule = IMPLIED[t.name];
      if (rule && t.name !== 'p') this.implied(rule);
    }
    const frame = this.make(t);
    if (t.raw) {
      this.events.raw?.(frame, t);
      return;
    }
    const selfClosed = t.selfClosing && (t.name === 'svg' || t.name === 'math' || t.name === 'explain-widget' || this.foreign > 0);
    if (VOID.has(t.name) || selfClosed) {
      this.events.leaf?.(frame, t);
      return;
    }
    if (this.stack.length >= MAX_DEPTH) {
      this.overflow++;
      this.events.leaf?.(frame, t);
      return;
    }
    const depth = this.stack.length;
    this.stack.push(frame);
    let list = this.open.get(t.name);
    if (!list) this.open.set(t.name, (list = []));
    list.push(depth);
    if (t.name === 'svg' || t.name === 'math') this.foreign++;
    this.events.open?.(frame, t);
  }

  private implied(rule: { closes: string[]; scope: string[] }): void {
    const at = this.nearest(rule.closes);
    if (at >= 0 && at > this.nearest(rule.scope)) this.popTo(at);
  }

  private endTag(name: string): void {
    if (this.overflow > 0) {
      this.overflow--;
      return;
    }
    const at = this.innermost(name);
    if (at >= 0) this.popTo(at);
  }

  private popTo(index: number): void {
    while (this.stack.length > index) {
      const f = this.stack.pop()!;
      this.open.get(f.name)!.pop();
      if (f.name === 'svg' || f.name === 'math') this.foreign--;
      this.events.close?.(f);
    }
  }
}

// ---- outline ----

export const OUTLINE_LIMITS = {
  steps: 500,
  details: 200,
  /** Characters collected per title or blurb before cleaning. */
  collect: 2048,
  titleChars: 120,
  blurbChars: 140,
  /** Characters of a detail name kept (valid names are at most 64). */
  detailNameChars: 100,
  /** Total scanning time per page, across slices; past it the outline is `truncated`. */
  backstopMs: 500,
} as const;

export interface OutlineStep {
  id: string;
  title: string;
  blurb: string;
}

export interface Outline {
  /** Elements with data-explain-anchor and no anchored ancestor, in document order. */
  steps: OutlineStep[];
  /** Every anchor id in the page → the step it is in (a step maps to itself). First occurrence wins. */
  anchorStep: Map<string, string>;
  /** Each data-explain-detail value in document order, as written (not validated), with its step and the offset of its element. */
  details: { name: string; stepId?: string; offset: number }[];
  /** Scanning stopped early (the time backstop); what was found is kept. */
  truncated: boolean;
}

interface OFrame extends Frame {
  /** Has data-explain-anchor. */
  anchored: boolean;
  /** Removed by the panel's sanitizer, with its contents. */
  dropped: boolean;
}

const DROPPED = new Set<string>(DROPPED_ELEMENTS.map((n) => n.toLowerCase()));
const HEADING = new Set(['h1', 'h2', 'h3', 'h4']);

interface StepState {
  id: string;
  explainTitle: string | undefined;
  heading: string | undefined;
  blurb: string | undefined;
  /** The frame the step's element is; undefined when it wasn't tracked (beyond MAX_DEPTH). */
  frame: OFrame | undefined;
}

/**
 * The outline of a page, built a slice at a time: `feed(ms)` returns true when done. The time backstop
 * (OUTLINE_LIMITS.backstopMs in total) stops it with `truncated` set.
 */
export class OutlineScanner {
  private readonly tokens: HtmlTokenizer;
  private readonly tree: TreeBuilder<OFrame>;
  private readonly steps: StepState[] = [];
  private readonly anchorStep = new Map<string, string>();
  private readonly details: { name: string; stepId?: string; offset: number }[] = [];
  private anchoredOpen = 0;
  private droppedOpen = 0;
  private step: StepState | undefined;
  /** Collecting text into the current step's heading or blurb, until this frame closes. */
  private headingFrame: OFrame | undefined;
  private headingText = '';
  private blurbFrame: OFrame | undefined;
  private blurbText = '';
  private done = false;
  private truncated = false;
  /** Milliseconds spent scanning so far. */
  elapsed = 0;

  private readonly html: string;
  private readonly now: () => number;

  constructor(html: string, now: () => number = Date.now) {
    this.html = html;
    this.now = now;
    this.tokens = new HtmlTokenizer(html);
    this.tree = new TreeBuilder<OFrame>(
      (t) => {
        const dropped = DROPPED.has(t.name);
        const anchored = !dropped && this.droppedOpen === 0 && t.attrs.has('data-explain-anchor');
        return { name: t.name, attrs: t.attrs, offset: t.offset, anchored, dropped };
      },
      {
        open: (f) => this.onElement(f, true),
        leaf: (f) => this.onElement(f, false),
        close: (f) => this.onClose(f),
        text: (start, end) => this.onText(start, end),
      },
    );
  }

  /** Scans for up to `budgetMs`; true once the whole page is outlined (or the backstop stopped it). */
  feed(budgetMs: number): boolean {
    if (this.done) return true;
    const start = this.now();
    const stopAt = start + Math.min(budgetMs, Math.max(0, OUTLINE_LIMITS.backstopMs - this.elapsed));
    let n = 0;
    for (;;) {
      const t = this.tokens.next();
      if (!t) {
        this.tree.finish();
        this.done = true;
        break;
      }
      this.tree.token(t);
      if ((++n & 127) === 0 && this.now() >= stopAt) break;
    }
    this.elapsed += this.now() - start;
    if (!this.done && this.elapsed >= OUTLINE_LIMITS.backstopMs) {
      this.truncated = true;
      this.tree.finish();
      this.done = true;
    }
    return this.done;
  }

  result(): Outline {
    // Every string is flattened: slices of the page would otherwise keep the whole page source alive for as long
    // as the index keeps the outline (V8 sliced strings).
    return {
      steps: this.steps.map((s) => ({
        id: flat(s.id),
        title: flat(displayText(stepTitle(s.explainTitle, s.heading, s.id), OUTLINE_LIMITS.titleChars)),
        blurb: s.blurb ? flat(firstSentence(s.blurb, OUTLINE_LIMITS.blurbChars)) : '',
      })),
      anchorStep: new Map([...this.anchorStep].map(([k, v]) => [flat(k), flat(v)])),
      details: this.details.map((d) => ({ ...d, name: flat(d.name), ...(d.stepId !== undefined ? { stepId: flat(d.stepId) } : {}) })),
      truncated: this.truncated,
    };
  }

  private onElement(f: OFrame, tracked: boolean): void {
    if (f.dropped) {
      if (tracked) this.droppedOpen++;
      return;
    }
    if (this.droppedOpen > 0) return;
    if (f.anchored) {
      const id = f.attrs.get('data-explain-anchor')!;
      if (this.anchoredOpen === 0) {
        if (this.steps.length < OUTLINE_LIMITS.steps) {
          this.step = { id, explainTitle: f.attrs.get('data-explain-title'), heading: undefined, blurb: undefined, frame: tracked ? f : undefined };
          this.steps.push(this.step);
        } else this.step = undefined;
      }
      if (this.step && !this.anchorStep.has(id)) this.anchorStep.set(id, this.step.id);
      if (tracked) this.anchoredOpen++;
    }
    const detail = f.attrs.get('data-explain-detail');
    if (detail !== undefined && this.details.length < OUTLINE_LIMITS.details) {
      const inStep = this.anchoredOpen > 0 && this.step;
      const name = detail.slice(0, OUTLINE_LIMITS.detailNameChars);
      this.details.push(inStep ? { name, stepId: this.step!.id, offset: f.offset } : { name, offset: f.offset });
    }
    if (!tracked || this.anchoredOpen === 0 || !this.step) return;
    if (this.step.heading === undefined && !this.headingFrame && HEADING.has(f.name)) {
      this.headingFrame = f;
      this.headingText = '';
    }
    if (this.step.blurb === undefined && !this.blurbFrame && f.name === 'p') {
      this.blurbFrame = f;
      this.blurbText = '';
    }
  }

  private onClose(f: OFrame): void {
    if (f.dropped) {
      this.droppedOpen--;
      return;
    }
    if (f === this.headingFrame) {
      if (this.step) this.step.heading = this.headingText;
      this.headingFrame = undefined;
    }
    if (f === this.blurbFrame) {
      if (this.step) this.step.blurb = this.blurbText;
      this.blurbFrame = undefined;
    }
    if (f.anchored && this.droppedOpen === 0) {
      this.anchoredOpen--;
      if (this.anchoredOpen === 0) {
        // The step ended: a heading or paragraph left open inside it ends with it.
        if (this.step && this.headingFrame) this.step.heading = this.headingText;
        if (this.step && this.blurbFrame) this.step.blurb = this.blurbText;
        this.headingFrame = undefined;
        this.blurbFrame = undefined;
        this.step = undefined;
      }
    }
  }

  private onText(start: number, end: number): void {
    if (this.droppedOpen > 0 || (!this.headingFrame && !this.blurbFrame)) return;
    const take = (have: string) => {
      const room = OUTLINE_LIMITS.collect - have.length;
      if (room <= 0) return have;
      // A few extra characters, so an entity cut at the edge still decodes.
      return have + decodeEntities(this.html.slice(start, Math.min(end, start + room + 12))).slice(0, room);
    };
    if (this.headingFrame) this.headingText = take(this.headingText);
    if (this.blurbFrame) this.blurbText = take(this.blurbText);
  }
}

/** The whole outline at once (tests, the checker). Still bounded by the time backstop. */
export function outlineHtml(html: string): Outline {
  const s = new OutlineScanner(html);
  while (!s.feed(OUTLINE_LIMITS.backstopMs));
  return s.result();
}

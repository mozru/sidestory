// Code block colors in the panel (docs/HIGHLIGHT-PLAN.md §2). The extension host tokenizes; this module only
// ever gets lengths and palette indexes back, slices its own text with them, and builds spans with textContent
// and CSSOM. Nothing here turns a string into HTML or CSS text.
import { HEX_COLOR, type HighlightStyle, langFromClass, MAX_BLOCK_CHARS, MAX_BLOCK_LINES, MAX_REQUEST_BLOCKS, MAX_REQUEST_CHARS } from '../shared/highlight-languages.ts';
import type { FromWebview, ToWebview } from '../shared/protocol.ts';
import { randomToken } from './trusted.ts';

/** Marks blocks this module colored. Its value is a random token per panel, so author HTML can't pass for one. */
export const HL_ATTR = 'data-cx-hl';
/** Spans made per pass at most; blocks past it stay plain. */
export const MAX_SPANS = 100_000;
/** The runs cache holds results for this much code text (UTF-16 units). */
const CACHE_CHARS = 1_000_000;
const MAX_PENDING_IDS = 2_000;
/** A request the host never answered (no reply at all) is asked again after this long. */
const PENDING_MS = 30_000;

interface Colored {
  /** The text the block was colored from (compared with incoming text, never the live textContent). */
  text: string;
  lang: string;
  theme: string;
  /** False: colors carried over an edit, for the lines above it; the rest is plain until the reply comes. */
  complete: boolean;
  /** The runs applied (a partial block's last run is the plain rest). */
  runs: number[];
}

type Highlighted = Extract<ToWebview, { type: 'highlighted' }>;

/** Values keyed by code text (and theme, language): an LRU bounded by the total length of the keys. */
class TextLru<V> {
  private readonly map = new Map<string, V>();
  private chars = 0;

  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  set(key: string, value: V): void {
    if (key.length > CACHE_CHARS) return;
    const old = this.map.get(key);
    if (old) {
      this.map.delete(key);
      this.chars -= key.length;
    }
    this.map.set(key, value);
    this.chars += key.length;
    for (const k of this.map.keys()) {
      if (this.chars <= CACHE_CHARS) break;
      this.map.delete(k);
      this.chars -= k.length;
    }
  }
}

/** Validated palette: unknown or malformed entries become "no style" (index 0's meaning). */
function validPalette(p: unknown): HighlightStyle[] | undefined {
  if (!Array.isArray(p) || p.length === 0 || p.length > 4096) return undefined;
  return p.map((s: unknown) => {
    if (!s || typeof s !== 'object') return {};
    const { color, font } = s as { color?: unknown; font?: unknown };
    const out: HighlightStyle = {};
    if (typeof color === 'string' && HEX_COLOR.test(color)) out.color = color;
    if (typeof font === 'number' && Number.isInteger(font) && font > 0 && font < 16) out.font = font;
    return out;
  });
}

/** Runs are used only if they are whole, positive lengths and known styles adding up to exactly the text's length. */
export function validRuns(runs: unknown, length: number, paletteSize: number): runs is number[] {
  if (!Array.isArray(runs) || runs.length % 2 !== 0 || runs.length > 2 * length) return false;
  let sum = 0;
  for (let i = 0; i < runs.length; i += 2) {
    const len = runs[i];
    const style = runs[i + 1];
    if (!Number.isInteger(len) || len < 1 || !Number.isInteger(style) || style < 0 || style >= paletteSize) return false;
    sum += len;
  }
  return sum === length;
}

const lineCount = (s: string) => {
  let n = 1;
  for (let i = s.indexOf('\n'); i >= 0 && n <= MAX_BLOCK_LINES; i = s.indexOf('\n', i + 1)) n++;
  return n;
};

export interface HighlighterHost {
  post(m: FromWebview): void;
  /** The live content root. */
  root(): Element;
}

export class CodeHighlighter {
  /** The marker's value: unguessable by explainer content. */
  readonly token = randomToken();
  private theme: string | undefined;
  private readonly palettes = new Map<string, HighlightStyle[]>();
  private readonly cache = new TextLru<number[]>();
  /** Keys the host answered with "stays plain". */
  private readonly plain = new TextLru<true>();
  /**
   * Blocks the host answered "plain" for, by element (the key they were answered for). Unlike the LRUs, this
   * doesn't forget while the block is on the page, so a page with more code than the caches hold isn't asked
   * for again and again.
   */
  private readonly plainFor = new WeakMap<Element, string>();
  /** The answers of the reply being applied, whatever the caches keep of them. */
  private fresh: Map<string, number[] | null> | undefined;
  private readonly colored = new WeakMap<Element, Colored>();
  /** A colored block the morph is changing: its old colors, for the lines above the edit. */
  private readonly previous = new WeakMap<Element, Colored>();
  /** Blocks asked for, by request id (ids grow), and the ids by `lang\ntext`, so a block is asked for once at a time. */
  private readonly pending = new Map<number, { lang: string; text: string; at: number }>();
  private readonly pendingKeys = new Map<string, number>();
  private nextId = 1;
  private selectionPass = 0;
  /** A patch was put off because the reader's selection was in the block. */
  private deferred = false;
  private spans = 0;
  /** The last pass stopped at the span budget: the next frame goes on. */
  private spanCapped = false;
  private readonly host: HighlighterHost;

  constructor(host: HighlighterHost) {
    this.host = host;
  }

  private key(lang: string, text: string, theme = this.theme): string | undefined {
    return theme === undefined ? undefined : `${theme}\n${lang}\n${text}`;
  }

  /** Ours: marked with this panel's token and known to this module. */
  private info(el: Element): Colored | undefined {
    return el.getAttribute(HL_ATTR) === this.token ? this.colored.get(el) : undefined;
  }

  /** The content frame's document changed (rebuilt): its selection is watched for deferred patches. */
  bind(doc: Document): void {
    doc.addEventListener('selectionchange', () => {
      if (!this.deferred || this.selectionPass) return;
      this.selectionPass = requestAnimationFrame(() => {
        this.selectionPass = 0;
        if (this.deferred) this.pass(false);
      });
    });
  }

  /**
   * For idiomorph's beforeNodeMorphed: false keeps a colored block (spans and all) when the incoming block has the
   * same text and attributes, so unchanged blocks cost one comparison. Otherwise its colors are kept aside for
   * `afterRender`, which reuses them for the lines above the edit.
   */
  morph(old: Node, next: Node): boolean {
    if (old.nodeType !== 1) return true;
    const o = old as Element;
    const info = this.info(o);
    if (!info) return true;
    const n = next as Element;
    if (next.nodeType === 1 && n.localName === o.localName && n.childElementCount === 0 && sameAttributes(o, n) && langOf(n) === info.lang && n.textContent === info.text) return false;
    this.colored.delete(o);
    this.previous.set(o, info);
    return true;
  }

  /** After a render: colors what the cache has, carries colors over edits, and asks for the rest. */
  afterRender(): void {
    this.pass(true);
  }

  /**
   * A deep copy of `root` whose colored blocks are plain text again, so comparing two renders sees only what the
   * author wrote. Their spans are never copied: a live update compares every section before and after, and copying
   * thousands of spans twice per keystroke made colored pages several times slower to update than plain ones.
   */
  plainClone<T extends Element>(root: T): T {
    const blocks = new Set(root.querySelectorAll(`[${HL_ATTR}="${this.token}"]`));
    if (blocks.size === 0) return root.cloneNode(true) as T;
    // The blocks' ancestors are copied one level at a time; everything else whole.
    const above = new Set<Node>();
    for (const b of blocks) for (let n = b.parentNode; n && n !== root && !above.has(n); n = n.parentNode) above.add(n);
    const copy = (n: Node): Node => {
      if (blocks.has(n as Element)) {
        const c = n.cloneNode(false) as Element;
        c.textContent = n.textContent;
        c.removeAttribute(HL_ATTR);
        return c;
      }
      if (n !== root && !above.has(n)) return n.cloneNode(true);
      const c = n.cloneNode(false);
      for (let k = n.firstChild; k; k = k.nextSibling) c.appendChild(copy(k));
      return c;
    };
    return copy(root) as T;
  }

  onMessage(m: ToWebview): void {
    if (m.type === 'highlightTheme') {
      if (typeof m.theme !== 'string' || m.theme.length > 64) return;
      this.theme = m.theme;
      this.pass(true);
      return;
    }
    if (m.type === 'highlighted') this.onResult(m);
  }

  private onResult(m: Highlighted): void {
    const palette = validPalette(m.palette);
    if (typeof m.theme !== 'string' || m.theme.length > 64 || !palette || !Array.isArray(m.blocks)) return;
    this.theme = m.theme;
    this.palettes.delete(m.theme); // least recently used first
    this.palettes.set(m.theme, palette);
    if (this.palettes.size > 4) this.palettes.delete(this.palettes.keys().next().value!);
    let first = Infinity;
    let answered = false;
    const fresh = new Map<string, number[] | null>();
    for (const b of m.blocks) {
      if (b && typeof b.id === 'number') first = Math.min(first, b.id);
      const req = b && typeof b.id === 'number' ? this.pending.get(b.id) : undefined;
      if (!req) continue;
      answered = true;
      this.unpend(b.id);
      const key = this.key(req.lang, req.text)!;
      const ok = b.runs !== null && validRuns(b.runs, req.text.length, palette.length);
      if (ok) this.cache.set(key, b.runs as number[]);
      else this.plain.set(key, true);
      fresh.set(key, ok ? (b.runs as number[]) : null);
    }
    // One panel's requests are answered in order, and a newer one replaces a waiting one: earlier ids still
    // pending were dropped, never to be answered.
    // A stale reply (its blocks asked for again since, or the previous explainer's) changes nothing.
    if (!answered) return;
    for (const id of [...this.pending.keys()]) if (id < first) this.unpend(id);
    // Blocks left out (the caps) or dropped are asked for now; the rest are colored from this reply.
    this.fresh = fresh;
    try {
      this.pass(true);
    } finally {
      this.fresh = undefined;
    }
  }

  private unpend(id: number): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    const k = `${p.lang}\n${p.text}`;
    if (this.pendingKeys.get(k) === id) this.pendingKeys.delete(k);
  }

  /** Colors every block it can; with `request`, asks the host for the blocks that aren't fully colored yet. */
  private pass(request: boolean): void {
    this.deferred = false;
    this.spans = 0;
    const misses: { id: number; lang: string; code: string }[] = [];
    let chars = 0;
    const now = Date.now();
    const root = this.host.root();
    const selection = root.ownerDocument.getSelection();
    const seen = new Set<Element>();
    for (const { el, lang } of targets(root, (e) => this.info(e) !== undefined)) {
      seen.add(el);
      let info = this.info(el);
      if (info && info.lang !== lang) {
        // Its language changed (the class on <pre>): start over from its text.
        el.textContent = info.text;
        el.removeAttribute(HL_ATTR);
        this.colored.delete(el);
        info = undefined;
      }
      if (!info && el.childElementCount > 0) continue; // the author's own markup inside the code: left as written
      if (info?.complete && info.theme === this.theme) continue;
      const text = info?.text ?? el.textContent ?? '';
      if (text.length === 0 || text.length > MAX_BLOCK_CHARS || lineCount(text) > MAX_BLOCK_LINES) continue;
      const key = this.key(lang, text);
      const answer = key === undefined ? undefined : this.fresh?.get(key);
      const runs = key === undefined ? undefined : (answer ?? (answer === null ? undefined : this.cache.get(key)));
      if (key !== undefined && (answer === null || (!runs && this.plain.has(key)))) this.plainFor.set(el, key);
      if (runs) {
        if (selection && !selection.isCollapsed && selection.containsNode(el, true)) {
          this.deferred = true; // don't take the reader's selection away: patched once it leaves
        } else if (this.apply(el, { text, lang, theme: this.theme!, complete: true, runs })) {
          continue;
        }
      }
      if (!info && !runs) this.carryOver(el, text, lang);
      if ((key !== undefined && this.plainFor.get(el) === key) || !request || (runs && this.palettes.has(this.theme!))) continue;
      const pk = `${lang}\n${text}`;
      const asked = this.pendingKeys.get(pk);
      if (asked !== undefined && now - this.pending.get(asked)!.at < PENDING_MS) continue; // already asked for
      // Over the caps: asked for after the reply to this request.
      if (misses.length >= MAX_REQUEST_BLOCKS || chars + text.length > MAX_REQUEST_CHARS) continue;
      const id = this.nextId++;
      if (asked !== undefined) this.unpend(asked);
      this.pending.set(id, { lang, text, at: now });
      this.pendingKeys.set(pk, id);
      misses.push({ id, lang, code: text });
      chars += text.length;
    }
    // Blocks colored before that are no longer code blocks (their language removed, text put beside them): plain again.
    for (const el of root.querySelectorAll(`[${HL_ATTR}="${this.token}"]`)) {
      const info = this.colored.get(el);
      if (seen.has(el) || !info) continue;
      el.textContent = info.text;
      el.removeAttribute(HL_ATTR);
      this.colored.delete(el);
    }
    while (this.pending.size > MAX_PENDING_IDS) this.unpend(this.pending.keys().next().value!);
    if (misses.length) this.host.post({ type: 'highlight', blocks: misses });
    if (this.spanCapped) {
      this.spanCapped = false;
      requestAnimationFrame(() => this.pass(false));
    }
  }

  /** The block was colored before this edit: keep the colors of the lines above the first changed line. */
  private carryOver(el: Element, text: string, lang: string): void {
    const old = this.previous.get(el);
    this.previous.delete(el);
    if (!old || old.lang !== lang) return;
    let p = 0;
    const max = Math.min(old.text.length, text.length);
    while (p < max && old.text.charCodeAt(p) === text.charCodeAt(p)) p++;
    const cut = text.lastIndexOf('\n', p - 1) + 1; // the end of the last unchanged line, newline included
    if (cut <= 0) return;
    const runs: number[] = [];
    let pos = 0;
    for (let i = 0; i < old.runs.length && pos < cut; i += 2) {
      const len = Math.min(old.runs[i]!, cut - pos);
      runs.push(len, old.runs[i + 1]!);
      pos += len;
    }
    if (text.length > cut) runs.push(text.length - cut, 0);
    this.apply(el, { text, lang, theme: old.theme, complete: false, runs });
  }

  /** Builds the block's spans; false (nothing done) when the theme's palette is gone. */
  private apply(el: Element, info: Colored): boolean {
    const palette = this.palettes.get(info.theme);
    // Past the span budget of this pass: left as it is, for a later pass (it isn't asked for again).
    if (!palette) return false;
    if (this.spans + info.runs.length / 2 > MAX_SPANS) {
      this.spanCapped = true;
      return false;
    }
    const doc = el.ownerDocument;
    const frag = doc.createDocumentFragment();
    let pos = 0;
    for (let i = 0; i < info.runs.length; i += 2) {
      const len = info.runs[i]!;
      const piece = info.text.slice(pos, pos + len);
      pos += len;
      const style = palette[info.runs[i + 1]!];
      if (!style || (!style.color && !style.font)) {
        frag.append(doc.createTextNode(piece));
        continue;
      }
      this.spans++;
      const span = doc.createElement('span');
      span.textContent = piece;
      if (style.color) span.style.color = style.color;
      const f = style.font ?? 0;
      if (f & 1) span.style.fontStyle = 'italic';
      if (f & 2) span.style.fontWeight = 'bold';
      if (f & 12) span.style.textDecorationLine = [f & 4 ? 'underline' : '', f & 8 ? 'line-through' : ''].join(' ').trim();
      frag.append(span);
    }
    el.replaceChildren(frag);
    el.setAttribute(HL_ATTR, this.token);
    this.colored.set(el, info);
    return true;
  }
}

/** The language of a block element as `targets` sees it: its own class, then (for a `<code>`) its `<pre>`'s. */
function langOf(el: Element): string | undefined {
  if (el.localName === 'pre') return langFromClass(el.getAttribute('class'));
  return langFromClass(el.getAttribute('class')) ?? langFromClass(el.parentElement?.getAttribute('class'));
}

/** Attributes equal, leaving out the marker (the incoming tree never has it). */
function sameAttributes(a: Element, b: Element): boolean {
  const own = a.hasAttribute(HL_ATTR) ? 1 : 0;
  if (a.attributes.length - own !== b.attributes.length) return false;
  for (const attr of b.attributes) if (attr.name === HL_ATTR || a.getAttribute(attr.name) !== attr.value) return false;
  return true;
}

/**
 * Code blocks: a `<code>` that is the only element in its `<pre>` (with nothing but whitespace beside it), or a
 * `<pre>` with no elements in it. The language comes from the code's class, else the pre's. `ours` says whether
 * an element holds spans this module made (otherwise elements inside mean author markup).
 */
export function* targets(root: Element, ours: (el: Element) => boolean): Generator<{ el: Element; lang: string }> {
  for (const pre of root.querySelectorAll('pre')) {
    let el: Element | undefined;
    const only = pre.firstElementChild;
    if (only && only === pre.lastElementChild && only.localName === 'code' && !ours(pre)) {
      let textBeside = false;
      for (const n of pre.childNodes) if (n.nodeType === 3 && /\S/.test(n.textContent ?? '')) textBeside = true;
      if (!textBeside) el = only;
    } else if (!only || ours(pre)) el = pre;
    if (!el) continue;
    const lang = langFromClass(el === pre ? null : el.getAttribute('class')) ?? langFromClass(pre.getAttribute('class'));
    if (lang) yield { el, lang };
  }
}

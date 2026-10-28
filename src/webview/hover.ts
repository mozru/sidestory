// The hover preview (`sidestory.hoverPreview`): resting the pointer on a linked element, or tabbing to one, shows a
// small card with the first lines of its code. The card is panel chrome over the content frame, never inside it, and
// takes no pointer input. Nothing here moves the editor, focus, scroll, the cursor or the step: the host only reads.
import type { FromWebview, HoverPreview, ToWebview } from '../shared/protocol.ts';
import { validPalette, validRuns } from './highlight.ts';

/** How long the pointer rests (or focus stays) before the card shows. */
const SHOW_MS = 500;
/** The host is asked a little earlier, so the card is ready on time; sweeping across a diagram asks nothing. */
const ASK_MS = 250;
/** Leaving the link for this long hides the card: moving between its nested elements (an SVG box's parts) doesn't. */
const GRACE_MS = 120;
/** Space kept between the card and the link, and the panel's edges. */
const GAP = 4;

type Ask = { type: 'previewRef'; anchorId: string } | { type: 'previewCode'; path: string; target?: string };
type Reply = Extract<ToWebview, { type: 'codePreview' }>;

export interface HoverHost {
  post(m: FromWebview): void;
  /** What a linked element points at, as `previewRef` / `previewCode` asks (without the id); undefined: nothing valid. */
  ask(el: HTMLElement): Ask | undefined;
  /** The element's box, in the panel's coordinates. */
  rect(el: HTMLElement): DOMRect;
  /** A hidden element in the content frame that mirrors the card's text, for the link's aria-describedby. */
  describer(): HTMLElement | undefined;
}

export class HoverCard {
  readonly el: HTMLElement;
  private mode: HoverPreview = 'off';
  /** The link pointed at or focused, from the first moment (before the card shows). */
  private target: HTMLElement | undefined;
  /** The target came by keyboard focus: the pointer moving elsewhere doesn't hide it, a blur does. */
  private byFocus = false;
  private askTimer: ReturnType<typeof setTimeout> | undefined;
  private showTimer: ReturnType<typeof setTimeout> | undefined;
  private leaveTimer: ReturnType<typeof setTimeout> | undefined;
  /** The latest request's id: replies to older ones are stale. */
  private id = 0;
  /** A request is out for the target: the host gets `previewEnd` when it goes (its editor mark goes with it). */
  private asked = false;
  private reply: Reply | undefined;
  /** SHOW_MS passed: the card shows as soon as the reply is here. */
  private due = false;
  /** The link's own aria-describedby while the card describes it (null: it had none). */
  private described: { el: HTMLElement; had: string | null } | undefined;
  private readonly host: HoverHost;

  constructor(parent: HTMLElement, host: HoverHost) {
    this.host = host;
    this.el = document.createElement('div');
    this.el.className = 'cx-hovercard';
    this.el.id = 'cx-hovercard';
    this.el.setAttribute('role', 'tooltip');
    this.el.hidden = true;
    parent.append(this.el);
  }

  setMode(mode: HoverPreview): void {
    if (mode === this.mode) return;
    this.hide();
    this.mode = mode;
  }

  /** The pointer is over a linked element, or keyboard focus arrived on one. */
  enter(link: HTMLElement, byFocus: boolean): void {
    if (this.mode === 'off') return;
    if (link === this.target) {
      clearTimeout(this.leaveTimer);
      this.byFocus ||= byFocus;
      return;
    }
    this.hide();
    this.target = link;
    this.byFocus = byFocus;
    this.askTimer = setTimeout(() => this.send(), ASK_MS);
    this.showTimer = setTimeout(() => {
      this.due = true;
      this.render();
    }, SHOW_MS);
  }

  /** The pointer moved off every linked element (or out of the content). Focus keeps a card the keyboard brought. */
  pointerAway(): void {
    if (!this.target || this.byFocus) return;
    clearTimeout(this.leaveTimer);
    this.leaveTimer = setTimeout(() => this.hide(), GRACE_MS);
  }

  /** Focus left an element: the card it brought goes. */
  blur(el: Element): void {
    if (el === this.target) this.hide();
  }

  /**
   * The panel scrolled: a card showing would no longer sit by its link. One still waiting stays: it is placed when it
   * shows, and the pointer landing elsewhere moves it on.
   */
  scrolled(): void {
    if (!this.el.hidden) this.hide();
  }

  /** Hides the card and forgets the link; true when a card was showing (Escape is then spent). */
  hide(): boolean {
    clearTimeout(this.askTimer);
    clearTimeout(this.showTimer);
    clearTimeout(this.leaveTimer);
    const shown = !this.el.hidden;
    if (shown) {
      this.el.classList.remove('cx-shown');
      this.el.hidden = true;
      this.el.replaceChildren();
    }
    this.undescribe();
    if (this.asked) this.host.post({ type: 'previewEnd' });
    this.asked = false;
    this.target = undefined;
    this.byFocus = false;
    this.reply = undefined;
    this.due = false;
    return shown;
  }

  onReply(m: Reply): void {
    if (m.id !== this.id || !this.target || !this.asked) return;
    this.reply = m;
    this.render();
  }

  private send(): void {
    const ask = this.target && this.host.ask(this.target);
    if (!ask) return;
    this.id++;
    this.asked = true;
    this.host.post({ ...ask, id: this.id });
  }

  private render(): void {
    const target = this.target;
    const r = this.reply;
    if (!target || !r || !this.due || (this.mode !== 'card' && this.mode !== 'both') || !target.isConnected) return;
    const p = r.preview;
    const head = div('cx-hovercard-head');
    const rows: HTMLElement[] = [];
    let summary: string;
    if (p) {
      head.textContent = `${p.path} · ${p.end > p.start ? `L${p.start}–${p.end}` : `L${p.start}`}`;
      const code = div('cx-hovercard-code');
      code.append(...codeLines(p.lines, p.palette, p.runs));
      rows.push(head, code);
      summary = `${head.textContent}: ${p.lines.join('\n')}`;
      if (p.more > 0) {
        const more = div('cx-hovercard-more');
        more.textContent = `… ${p.more} more line${p.more === 1 ? '' : 's'}`;
        rows.push(more);
        summary += `\n${more.textContent}`;
      }
    } else {
      head.textContent = r.note ?? 'Code not found';
      rows.push(head);
      summary = head.textContent;
    }
    this.el.replaceChildren(...rows);
    this.el.hidden = false;
    this.place(target);
    // A frame later, so the fade (none with reduced motion, see main.css) starts from transparent.
    requestAnimationFrame(() => {
      if (!this.el.hidden) this.el.classList.add('cx-shown');
    });
    if (this.byFocus) this.describe(target, summary);
  }

  /** Below the link, or above it when there's no room below; inside the panel either way. */
  private place(target: HTMLElement): void {
    const link = this.host.rect(target);
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    let top = link.bottom + GAP;
    if (top + h > vh - GAP && link.top - GAP - h >= GAP) top = link.top - GAP - h;
    top = Math.max(GAP, Math.min(top, vh - h - GAP));
    const left = Math.max(GAP, Math.min(link.left, vw - w - GAP));
    this.el.style.top = `${Math.round(top)}px`;
    this.el.style.left = `${Math.round(left)}px`;
  }

  /**
   * The focused link's description. The card is in the panel's document and the link in the content frame's, and an
   * IDREF can't cross documents: the link points at a hidden copy of the card's text inside the frame.
   */
  private describe(link: HTMLElement, text: string): void {
    const d = this.host.describer();
    if (!d) return;
    d.textContent = text;
    const had = link.getAttribute('aria-describedby');
    this.described = { el: link, had };
    link.setAttribute('aria-describedby', had ? `${had} ${d.id}` : d.id);
  }

  private undescribe(): void {
    const d = this.described;
    if (!d) return;
    this.described = undefined;
    if (d.had === null) d.el.removeAttribute('aria-describedby');
    else d.el.setAttribute('aria-describedby', d.had);
    const mirror = this.host.describer();
    if (mirror) mirror.textContent = '';
  }
}

function div(className: string): HTMLElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

/** One row per line; colored as code blocks are when the runs check out (src/webview/highlight.ts), plain otherwise. */
function codeLines(lines: string[], palette: unknown, runs: unknown): HTMLElement[] {
  const rows = lines.map(() => div('cx-hovercard-line'));
  const text = lines.join('\n');
  const styles = validPalette(palette);
  if (!styles || !validRuns(runs, text.length, styles.length)) {
    lines.forEach((l, i) => (rows[i]!.textContent = l));
    return rows;
  }
  let row = 0;
  let pos = 0;
  for (let i = 0; i < runs.length; i += 2) {
    const piece = text.slice(pos, pos + runs[i]!);
    pos += runs[i]!;
    const style = styles[runs[i + 1]!];
    piece.split('\n').forEach((part, k) => {
      if (k > 0) row++;
      if (!part) return;
      if (!style?.color && !style?.font) return rows[row]!.append(part);
      const span = document.createElement('span');
      span.textContent = part;
      if (style.color) span.style.color = style.color;
      const f = style.font ?? 0;
      if (f & 1) span.style.fontStyle = 'italic';
      if (f & 2) span.style.fontWeight = 'bold';
      if (f & 12) span.style.textDecorationLine = [f & 4 ? 'underline' : '', f & 8 ? 'line-through' : ''].join(' ').trim();
      rows[row]!.append(span);
    });
  }
  return rows;
}

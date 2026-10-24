// Comment threads in the panel (docs/COMMENTS-PLAN.md §6): step chip counts, section badges in a host overlay,
// and the docked Comments pane with thread cards and the composer. Everything here is host chrome, outside the
// content frame, so a sidestory can't restyle, cover or fake it. Bodies are untrusted text: rendered from the
// subset parser's tree with textContent only. Messages are posted only from handlers for trusted input.
import { parseBody, type Block, type Inline } from '../core/threads/markdown.ts';
import type { CommentItemView, CommentsContext, CommentsFromWebview, CommentsToWebview, DeliveryAction, ThreadView } from '../shared/comments-protocol.ts';

export interface CommentsHooks {
  post(m: CommentsFromWebview | { type: 'openCode'; path: string; target?: string }): void;
  steps(): { id: string; el: HTMLElement; label: string }[];
  activeStep(): string | undefined;
  goToStep(id: string): void;
  stepButton(id: string): HTMLElement | null;
  /** The content frame element (the badge layer lies over it). */
  contentFrame(): HTMLElement;
  announce(text: string): void;
  /** Keeps the reading position while the pane opens, closes or grows. */
  keepPlace(f: () => void): void;
  reducedMotion(): boolean;
  /** Per-panel saved state for drafts and the pane's height. */
  load(): { drafts?: Record<string, string>; height?: number; all?: boolean } | undefined;
  save(s: { drafts: Record<string, string>; height: number; all: boolean }): void;
}

type Mode = 'comment' | 'ask';
const ACTION_TEXT: Record<DeliveryAction, string> = {
  copyPrompt: 'Copy Prompt',
  sendAgain: 'Send Again',
  chooseSession: 'Choose a Session…',
  howTo: 'How to Turn It On',
  sendElsewhere: 'Send to Another Session',
  markAnswered: 'Mark as Answered',
  stopWaiting: 'Stop Waiting',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(cls: string, text: string, onClick: () => void, label?: string): HTMLButtonElement {
  const b = el('button', cls, text);
  b.type = 'button';
  if (label) b.setAttribute('aria-label', label);
  b.addEventListener('click', (e) => {
    if (!e.isTrusted) return; // only the reader's own clicks act
    e.stopPropagation();
    onClick();
  });
  return b;
}

function icon(name: string): HTMLSpanElement {
  const s = el('span', `codicon codicon-${name}`);
  s.setAttribute('aria-hidden', 'true');
  return s;
}

export function ago(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** Builds DOM for a comment body from the subset's tree: text nodes and our own elements only. */
export function renderBody(body: string, onRef: (path: string, start?: number, end?: number) => void): DocumentFragment {
  const frag = document.createDocumentFragment();
  const inline = (parent: HTMLElement, nodes: Inline[]) => {
    for (const n of nodes) {
      if (n.t === 'text') parent.append(document.createTextNode(n.text));
      else if (n.t === 'br') parent.append(el('br'));
      else if (n.t === 'strong' || n.t === 'em') {
        const e = el(n.t === 'strong' ? 'strong' : 'em');
        inline(e, n.children);
        parent.append(e);
      } else if (n.t === 'code') parent.append(el('code', 'cx-c-code', n.text));
      else {
        const b = button('cx-c-ref', n.text, () => onRef(n.path, n.start, n.end));
        b.dataset.cxRef = '';
        b.setAttribute('aria-label', `Show code ${n.text}`);
        parent.append(b);
      }
    }
  };
  const block = (b: Block) => {
    if (b.t === 'p') {
      const p = el('p');
      inline(p, b.children);
      frag.append(p);
    } else if (b.t === 'pre') {
      const pre = el('pre', 'cx-c-pre');
      pre.append(el('code', undefined, b.text));
      frag.append(pre);
    } else if (b.t === 'list') {
      const l = el(b.ordered ? 'ol' : 'ul');
      for (const it of b.items) {
        const li = el('li');
        inline(li, it);
        l.append(li);
      }
      frag.append(l);
    } else {
      const q = el('blockquote');
      for (const p of b.children) {
        const pe = el('p');
        inline(pe, p);
        q.append(pe);
      }
      frag.append(q);
    }
  };
  for (const b of parseBody(body)) block(b);
  return frag;
}

interface Composer {
  key: string;
  thread?: string;
  step?: string;
  mode: Mode;
  intent: 'answer' | 'edit';
  root: HTMLElement;
  text: HTMLTextAreaElement;
}

export class CommentsPane {
  private readonly hooks: CommentsHooks;
  readonly pane: HTMLElement;
  readonly layer: HTMLElement;
  private dir = '';
  private threads: ThreadView[] = [];
  private context: CommentsContext = { push: true, manySessions: false, defaultTier: 'local', restricted: false };
  private open = false;
  private all = false;
  private following = true;
  private pinnedStep: string | undefined;
  private composer: Composer | undefined;
  private drafts: Record<string, string> = {};
  private editing: string | undefined;
  /** The edit box, kept across re-renders so a half-typed edit survives a host update. */
  private editBox: HTMLTextAreaElement | undefined;
  private height = 260;
  private readTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly seen = new Set<string>();
  private readonly observer: IntersectionObserver;
  private composing = false;
  private renderAfterComposition = false;

  constructor(pane: HTMLElement, layer: HTMLElement, hooks: CommentsHooks) {
    this.pane = pane;
    this.layer = layer;
    this.hooks = hooks;
    const saved = hooks.load();
    this.drafts = { ...(saved?.drafts ?? {}) };
    this.height = saved?.height ?? 260;
    this.all = !!saved?.all;
    this.observer = new IntersectionObserver((entries) => this.onVisible(entries), { threshold: 0.6 });
    pane.addEventListener('compositionstart', () => (this.composing = true));
    pane.addEventListener('compositionend', () => {
      this.composing = false;
      if (this.renderAfterComposition) {
        this.renderAfterComposition = false;
        this.render();
      }
    });
  }

  /** Messages from the host; true when handled. */
  onMessage(m: CommentsToWebview): boolean {
    if (m.type === 'threads') {
      if (m.dir !== this.dir) {
        this.dir = m.dir;
        this.composer = undefined;
        this.editing = undefined;
        this.editBox = undefined;
      }
      this.threads = m.threads;
      this.context = m.context;
      this.render();
      this.decorate();
      return true;
    }
    if (m.type === 'commentsShow') {
      if (m.step) this.hooks.goToStep(m.step);
      this.show(m.step);
      if (m.compose) this.compose(m.compose === 'ask' ? 'ask' : 'comment');
      if (m.thread) requestAnimationFrame(() => this.pane.querySelector<HTMLElement>(`[data-thread="${CSS.escape(m.thread!)}"]`)?.focus());
      return true;
    }
    return false;
  }

  private persist() {
    this.hooks.save({ drafts: this.drafts, height: this.height, all: this.all });
  }

  private stepLabel(id: string | undefined): string {
    const steps = this.hooks.steps();
    const i = steps.findIndex((s) => s.id === id);
    return i < 0 ? 'A step no longer in this sidestory' : `Step ${i + 1} · ${steps[i]!.label}`;
  }

  private shownStep(): string | undefined {
    return this.following ? this.hooks.activeStep() : this.pinnedStep;
  }

  /** The step changed: the pane follows unless the reader is composing. */
  onActive(): void {
    if (this.composer && (document.activeElement === this.composer.text || this.composer.text.value)) {
      if (this.following) {
        this.following = false;
        this.pinnedStep = this.composer.step ?? this.threads.find((t) => t.id === this.composer!.thread)?.target.step ?? this.pinnedStep;
      }
    }
    if (this.open && !this.all) this.render();
  }

  /** Steps were re-rendered: counts on chips and badges. */
  decorate(): void {
    const byStep = new Map<string, { n: number; unread: boolean }>();
    for (const t of this.threads) {
      if (t.state !== 'open' || !t.target.step) continue;
      const c = byStep.get(t.target.step) ?? { n: 0, unread: false };
      c.n++;
      c.unread ||= t.unread;
      byStep.set(t.target.step, c);
    }
    for (const s of this.hooks.steps()) {
      const b = this.hooks.stepButton(s.id);
      if (!b) continue;
      let badge = b.querySelector<HTMLElement>('.cx-step-comments');
      const c = byStep.get(s.id);
      if (!c) {
        badge?.remove();
        continue;
      }
      if (!badge) {
        badge = el('span', 'cx-step-comments');
        b.append(badge);
      }
      badge.replaceChildren(icon('comment'), document.createTextNode(String(c.n)));
      badge.classList.toggle('cx-unread', c.unread);
      badge.setAttribute('aria-label', `${c.n} comment thread${c.n === 1 ? '' : 's'}${c.unread ? ', unread' : ''}`);
    }
    this.placeBadges(byStep);
  }

  /** Section badges in the overlay layer, positioned from each section's rect after layout. */
  placeBadges(byStep?: Map<string, { n: number; unread: boolean }>): void {
    if (!byStep) {
      byStep = new Map();
      for (const t of this.threads) if (t.state === 'open' && t.target.step) byStep.set(t.target.step, { n: (byStep.get(t.target.step)?.n ?? 0) + 1, unread: (byStep.get(t.target.step)?.unread ?? false) || t.unread });
    }
    const have = new Map([...this.layer.querySelectorAll<HTMLElement>('.cx-badge')].map((b) => [b.dataset.step!, b]));
    const width = this.hooks.contentFrame().clientWidth;
    for (const s of this.hooks.steps()) {
      let b = have.get(s.id);
      have.delete(s.id);
      const c = byStep.get(s.id);
      if (!b) {
        b = button('cx-badge', '', () => {
          this.hooks.goToStep(s.id);
          this.show(s.id);
          if (!this.threads.some((t) => t.target.step === s.id && t.state === 'open')) this.compose('comment', s.id);
        });
        b.dataset.step = s.id;
        this.layer.append(b);
      }
      b.replaceChildren(icon(c ? 'comment' : 'add'), ...(c ? [document.createTextNode(String(c.n))] : []));
      b.classList.toggle('cx-has', !!c);
      b.classList.toggle('cx-unread', !!c?.unread);
      b.setAttribute('aria-label', c ? `${c.n} comment thread${c.n === 1 ? '' : 's'} on ${s.label}` : `Comment on ${s.label}`);
      const r = s.el.getBoundingClientRect();
      b.style.top = `${Math.max(0, r.top + 4)}px`;
      b.style.left = `${Math.max(0, Math.min(width - 40, r.right - 40))}px`;
    }
    for (const stale of have.values()) stale.remove();
  }

  show(step?: string): void {
    if (step) {
      this.following = step === this.hooks.activeStep();
      this.pinnedStep = step;
    }
    if (!this.open) this.hooks.keepPlace(() => {
      this.open = true;
      this.pane.hidden = false;
      this.render();
    });
    else this.render();
  }

  hide(): void {
    if (!this.open) return;
    this.hooks.keepPlace(() => {
      this.open = false;
      this.pane.hidden = true;
    });
  }

  toggle(): void {
    if (this.open) this.hide();
    else this.show();
  }

  /** Esc: close the composer (keeping its draft), else collapse the pane. True when it did something. */
  escape(): boolean {
    if (this.editing) {
      this.editing = undefined;
      this.editBox = undefined;
      this.render();
      return true;
    }
    if (this.composer) {
      this.saveDraft();
      this.composer = undefined;
      this.following = true;
      this.render();
      return true;
    }
    if (this.open) {
      this.hide();
      return true;
    }
    return false;
  }

  /** C / A: a composer on the active step (a new thread). */
  compose(mode: Mode, step = this.hooks.activeStep()): void {
    if (!step) return;
    this.show(step);
    this.composer = undefined;
    this.render();
    this.openComposer({ key: `new:${step}`, step, mode });
  }

  /** N / Shift+N: the next thread with something for the reader. */
  next(delta: 1 | -1): void {
    const order = this.hooks.steps().map((s) => s.id);
    const list = this.threads.filter((t) => t.state === 'open' && (t.unread || t.suggestsResolve)).sort((a, b) => order.indexOf(a.target.step ?? '') - order.indexOf(b.target.step ?? ''));
    if (!list.length) {
      this.hooks.announce('No comments for you');
      return;
    }
    const cur = order.indexOf(this.hooks.activeStep() ?? '');
    const t = (delta === 1 ? list.find((x) => order.indexOf(x.target.step ?? '') > cur) : [...list].reverse().find((x) => order.indexOf(x.target.step ?? '') < cur)) ?? list[delta === 1 ? 0 : list.length - 1]!;
    if (t.target.step) this.hooks.goToStep(t.target.step);
    this.show(t.target.step);
    requestAnimationFrame(() => this.pane.querySelector<HTMLElement>(`[data-thread="${CSS.escape(t.id)}"]`)?.focus());
  }

  private saveDraft() {
    if (!this.composer) return;
    const v = this.composer.text.value;
    if (v) this.drafts[this.composer.key] = v;
    else delete this.drafts[this.composer.key];
    const keys = Object.keys(this.drafts);
    for (const k of keys.slice(0, Math.max(0, keys.length - 50))) delete this.drafts[k];
    this.persist();
  }

  private visibleThreads(): ThreadView[] {
    if (this.all) {
      const order = this.hooks.steps().map((s) => s.id);
      return [...this.threads].sort((a, b) => {
        const ia = a.target.step ? order.indexOf(a.target.step) : 9999;
        const ib = b.target.step ? order.indexOf(b.target.step) : 9999;
        return (ia < 0 ? 9998 : ia) - (ib < 0 ? 9998 : ib) || (a.target.kind === b.target.kind ? 0 : a.target.kind === 'step' ? -1 : 1);
      });
    }
    const step = this.shownStep();
    return this.threads.filter((t) => t.target.step === step);
  }

  render(): void {
    if (!this.open) return;
    // Never while an IME is composing in one of our boxes: moving the textarea would cancel the composition.
    // Only while one of our boxes still has focus: a missed compositionend (box removed, pane hidden) can't freeze the pane.
    if (this.composing && !(document.activeElement instanceof HTMLTextAreaElement && this.pane.contains(document.activeElement))) this.composing = false;
    if (this.composing) {
      this.renderAfterComposition = true;
      return;
    }
    const step = this.shownStep();
    const visible = this.visibleThreads();
    const openN = visible.filter((t) => t.state === 'open').length;
    const doneN = visible.length - openN;
    const activeEl = document.activeElement as HTMLElement | null;
    const focusKey = activeEl && this.pane.contains(activeEl) ? activeEl.dataset.focusKey : undefined;
    // A focused text box survives the re-render (it is moved, not rebuilt): remember its caret to restore it.
    const typing = activeEl instanceof HTMLTextAreaElement && this.pane.contains(activeEl) ? { el: activeEl, start: activeEl.selectionStart, end: activeEl.selectionEnd } : undefined;
    if (this.composer) this.saveDraft();

    const head = el('div', 'cx-c-head');
    const resize = el('div', 'cx-c-resize');
    resize.setAttribute('role', 'separator');
    resize.setAttribute('aria-label', 'Resize the Comments pane');
    resize.addEventListener('pointerdown', (e) => this.startResize(e));
    const title = el('span', 'cx-c-title', this.all ? 'Comments · All steps' : `Comments · ${this.stepLabel(step)}`);
    const counts = el('span', 'cx-c-counts', `${openN} open${doneN ? ` · ${doneN} resolved` : ''}`);
    head.append(resize, title, counts);
    if (!this.following && !this.all) head.append(button('cx-c-link', 'Follow', () => {
      this.following = true;
      this.render();
    }));
    const scope = button('cx-c-scope', this.all ? 'All steps' : 'This step', () => {
      this.all = !this.all;
      this.persist();
      this.render();
    }, this.all ? 'Showing all steps; show this step only' : 'Showing this step; show all steps');
    scope.setAttribute('aria-pressed', String(this.all));
    const plus = button('cx-c-icon', '', () => this.compose('comment', step), 'New comment on this step');
    plus.append(icon('add'));
    const close = button('cx-c-icon', '', () => this.hide(), 'Collapse the Comments pane');
    close.append(icon('chevron-down'));
    head.append(scope, plus, close);

    const body = el('div', 'cx-c-body');
    if (this.context.restricted) body.append(el('p', 'cx-c-note', "This folder is in Restricted Mode; Claude Code applies its own trust."));
    if (this.context.localBlocked) body.append(el('p', 'cx-c-note cx-c-warn', this.context.localBlocked));
    if (!visible.length && !this.composer) body.append(el('p', 'cx-c-empty', 'No comments here yet. Press C to comment, A to ask Claude.'));
    let lastGroup = '';
    for (const t of visible) {
      if (this.all) {
        const g = t.target.kind === 'code' && !t.target.step ? 'Code comments here' : t.target.gone ? 'Steps no longer in this sidestory' : this.stepLabel(t.target.step);
        if (g !== lastGroup) body.append(el('h3', 'cx-c-group', g));
        lastGroup = g;
      }
      body.append(this.card(t));
    }
    if (this.composer && !this.composer.thread) body.append(this.composer.root);

    this.pane.style.height = `${this.height}px`;
    this.observer.disconnect();
    this.pane.replaceChildren(head, body);
    for (const c of body.querySelectorAll<HTMLElement>('.cx-c-card')) this.observer.observe(c);
    if (this.composer) {
      const d = this.drafts[this.composer.key];
      if (d !== undefined && !this.composer.text.value) this.composer.text.value = d;
    }
    if (typing && typing.el.isConnected) {
      typing.el.focus();
      typing.el.setSelectionRange(typing.start, typing.end);
    } else if (focusKey) this.pane.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus();
  }

  private card(t: ThreadView): HTMLElement {
    const card = el('section', `cx-c-card${t.state === 'resolved' ? ' cx-resolved' : ''}${t.unread ? ' cx-unread' : ''}`);
    card.tabIndex = -1;
    card.dataset.thread = t.id;
    const label = t.target.kind === 'code' ? `${t.target.label}${t.target.step ? ` · in ${this.stepLabel(t.target.step).replace(/ · .*/, '')}` : ''}` : this.stepLabel(t.target.step);
    card.setAttribute('aria-label', `Thread on ${label}`);
    const top = el('div', 'cx-c-cardhead');
    top.append(el('span', 'cx-c-target', label));
    if (t.target.kind === 'code') top.append(button('cx-c-link', 'Show Code', () => this.hooks.post({ type: 'threadAction', thread: t.id, action: 'showCode' })));
    top.append(el('span', `cx-c-tier cx-${t.tier}`, t.tier));
    if (t.tracked) top.append(el('span', 'cx-c-tier', 'tracked by git'));
    top.append(button('cx-c-link', t.state === 'open' ? 'Resolve' : 'Reopen', () => this.hooks.post({ type: 'threadAction', thread: t.id, action: t.state === 'open' ? 'resolve' : 'reopen' })));
    top.append(this.menu(`thread:${t.id}`, [
      [t.tier === 'local' ? 'Share' : 'Make Local', () => this.hooks.post({ type: 'threadAction', thread: t.id, action: t.tier === 'local' ? 'share' : 'local' })],
      ['Copy Prompt', () => this.hooks.post({ type: 'threadAction', thread: t.id, action: 'copyPrompt' })],
      ['Copy Thread as Markdown', () => this.hooks.post({ type: 'threadAction', thread: t.id, action: 'copyMarkdown' })],
      ...(t.canDelete ? ([['Delete Thread', () => this.hooks.post({ type: 'threadAction', thread: t.id, action: 'delete' })]] as [string, () => void][]) : []),
    ]));
    card.append(top);
    if (t.stateText) card.append(el('p', 'cx-c-state', t.stateText));
    for (const c of t.comments) if (!c.retracted) card.append(this.comment(t, c));
    if (t.suggestsResolve) {
      const s = el('p', 'cx-c-suggest', 'Claude thinks this is done · ');
      s.append(button('cx-c-link', 'Resolve', () => this.hooks.post({ type: 'threadAction', thread: t.id, action: 'resolve' })));
      card.append(s);
    }
    if (t.canReply) {
      if (this.composer?.thread === t.id) card.append(this.composer.root);
      else {
        const lastClaude = [...t.comments].reverse().find((c) => !c.retracted)?.claude;
        card.append(button('cx-c-replybtn', 'Reply…', () => this.openComposer({ key: `reply:${t.id}`, thread: t.id, mode: lastClaude ? 'ask' : 'comment' })));
      }
    }
    return card;
  }

  private comment(t: ThreadView, c: CommentItemView): HTMLElement {
    const row = el('div', `cx-c-comment${c.claude ? ' cx-claude' : ''}${c.trust === 'repository' ? ' cx-repo' : ''}`);
    const meta = el('div', 'cx-c-meta');
    if (c.claude) meta.append(icon('sparkle'));
    meta.append(el('span', 'cx-c-author', c.author), el('span', 'cx-c-ago', ago(c.at)));
    if (c.changed) meta.append(el('span', 'cx-c-ago', 'edited'));
    if (c.editedAfterSend) meta.append(el('span', 'cx-c-ago', 'edited after sending'));
    if (c.mine) {
      meta.append(this.menu(`comment:${c.id}`, [
        ['Edit', () => {
          this.editing = c.id;
          this.render();
        }],
        ['Delete', () => this.hooks.post({ type: 'commentRetract', event: c.id })],
        ...(c.toClaude ? ([['Send to Claude Again', () => this.hooks.post({ type: 'deliveryAction', event: c.id, action: 'sendAgain' })]] as [string, () => void][]) : []),
      ]));
    }
    row.append(meta);
    if (this.editing === c.id) {
      // The same box across re-renders: what the reader typed survives host updates.
      const fresh = !this.editBox || this.editBox.dataset.event !== c.id;
      const ta = fresh ? el('textarea', 'cx-c-text') : this.editBox!;
      if (fresh) {
        ta.value = c.body;
        ta.dataset.event = c.id;
        ta.setAttribute('aria-label', 'Edit comment');
        this.editBox = ta;
        requestAnimationFrame(() => ta.focus());
      }
      const save = () => {
        const v = ta.value.trim();
        if (v) this.hooks.post({ type: 'commentEdit', event: c.id, body: v });
        this.editing = undefined;
        this.editBox = undefined;
        this.render();
      };
      ta.onkeydown = (e) => {
        if (!e.isTrusted) return;
        e.stopPropagation();
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save();
        else if (e.key === 'Escape') this.escape();
      };
      const actions = el('div', 'cx-c-actions');
      actions.append(button('cx-c-send', 'Save', save), button('cx-c-link', 'Cancel', () => this.escape()));
      row.append(ta, actions);
    } else {
      const b = el('div', 'cx-c-text-view');
      b.append(renderBody(c.body, (path, start, end) => this.hooks.post({ type: 'openCode', path, ...(start ? { target: `L${start}-L${end ?? start}` } : {}) })));
      row.append(b);
    }
    if (c.editedChips?.length) {
      const chips = el('div', 'cx-c-chips');
      chips.append(el('span', 'cx-c-chiplabel', 'Edited:'));
      for (const ch of c.editedChips) {
        if (ch.startsWith('step:')) chips.append(button('cx-c-chip', `Step ${this.stepLabel(ch.slice(5)).replace(/^Step /, '')}`, () => this.hooks.goToStep(ch.slice(5))));
        else chips.append(button('cx-c-chip', ch, () => this.hooks.post({ type: 'openCode', path: ch })));
      }
      row.append(chips);
    }
    if (c.delivery) {
      const d = el('div', `cx-c-delivery cx-${c.delivery.state}`);
      d.setAttribute('role', 'status');
      // Elapsed time right after "Claude is on it", before any longer hint.
      const text = c.delivery.since !== undefined ? c.delivery.text.replace(/^Claude is on it/, `Claude is on it · ${Math.round(c.delivery.since / 1000)}s`) : c.delivery.text;
      d.append(el('span', undefined, `${c.delivery.state === 'pushed' ? '✓ ' : ''}${text}`));
      for (const a of c.delivery.actions) {
        const b = button('cx-c-link', ACTION_TEXT[a], () => this.hooks.post({ type: 'deliveryAction', event: c.id, action: a }));
        if (a === 'sendElsewhere') b.title = 'If the first session comes back, it may answer too';
        d.append(b);
      }
      row.append(d);
    }
    void t;
    return row;
  }

  private menu(key: string, items: [string, () => void][]): HTMLElement {
    const wrap = el('span', 'cx-c-menu');
    const b = button('cx-c-icon', '', () => {
      const open = list.hidden;
      for (const other of this.pane.querySelectorAll<HTMLElement>('.cx-c-menulist')) other.hidden = true;
      list.hidden = !open;
      b.setAttribute('aria-expanded', String(open));
      if (open) list.querySelector<HTMLElement>('button')?.focus();
    }, 'More actions');
    b.dataset.focusKey = key;
    b.setAttribute('aria-haspopup', 'menu');
    b.setAttribute('aria-expanded', 'false');
    b.append(icon('ellipsis'));
    const list = el('div', 'cx-c-menulist');
    list.setAttribute('role', 'menu');
    list.hidden = true;
    for (const [text, f] of items) {
      const item = button('cx-c-menuitem', text, () => {
        list.hidden = true;
        f();
      });
      item.setAttribute('role', 'menuitem');
      list.append(item);
    }
    list.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        list.hidden = true;
        b.focus();
      }
    });
    wrap.append(b, list);
    return wrap;
  }

  private openComposer(o: { key: string; thread?: string; step?: string; mode: Mode }) {
    const root = el('div', 'cx-c-composer');
    const c: Composer = { ...o, intent: 'answer', root, text: el('textarea', 'cx-c-text') };
    this.composer = c;
    const seg = el('div', 'cx-c-seg');
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-label', 'Send as');
    const intent = el('select', 'cx-c-intent');
    intent.setAttribute('aria-label', 'What Claude may do');
    for (const [v, t] of [['answer', 'Answer only'], ['edit', 'Let Claude edit']] as const) {
      const op = el('option', undefined, t);
      op.value = v;
      intent.append(op);
    }
    intent.addEventListener('change', (e) => {
      void e;
      c.intent = intent.value === 'edit' ? 'edit' : 'answer';
    });
    const send = el('button', 'cx-c-send');
    send.type = 'button';
    const pick = button('cx-c-pick', '', () => this.hooks.post({ type: 'pickSession' }), 'Choose the Claude session');
    pick.append(icon('chevron-down'));
    const setMode = (m: Mode) => {
      c.mode = m;
      for (const b of seg.querySelectorAll<HTMLButtonElement>('button')) b.setAttribute('aria-checked', String(b.dataset.mode === m));
      intent.hidden = m !== 'ask';
      const session = thread?.session ?? this.context.session;
      const label = m === 'ask' ? (session ? `Ask Claude · ${session}` : 'Ask Claude') : 'Comment';
      send.replaceChildren(el('span', 'cx-c-sendlabel', label));
      send.title = label;
      pick.hidden = m !== 'ask' || !this.context.manySessions;
      hint.textContent = `${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+Enter ${m === 'ask' ? 'Ask Claude' : 'Comment'}`;
    };
    for (const [m, t] of [['comment', 'Comment'], ['ask', 'Ask Claude']] as const) {
      const b = button('cx-c-segbtn', t, () => setMode(m));
      b.dataset.mode = m;
      b.setAttribute('role', 'radio');
      seg.append(b);
    }
    const chips = el('div', 'cx-c-chips');
    const thread = o.thread ? this.threads.find((t) => t.id === o.thread) : undefined;
    chips.append(el('span', 'cx-c-chip', thread ? (thread.target.kind === 'code' ? thread.target.label : this.stepLabel(thread.target.step)) : this.stepLabel(o.step)));
    chips.append(el('span', `cx-c-tier cx-${thread?.tier ?? this.context.defaultTier}`, thread?.tier ?? this.context.defaultTier));
    c.text.setAttribute('aria-label', o.thread ? 'Reply' : 'New comment');
    c.text.placeholder = o.thread ? 'Reply…' : 'Comment on this step…';
    c.text.value = this.drafts[o.key] ?? '';
    const hint = el('span', 'cx-c-hint');
    const fmt = el('span', 'cx-c-hint', '**bold** *italic* `code` - lists · links show as text');
    const doSend = () => {
      const body = c.text.value.trim();
      if (!body) return;
      const toClaude = c.mode === 'ask';
      c.intent = intent.value === 'edit' ? 'edit' : 'answer'; // the select is host chrome; content can't reach it
      if (c.thread) this.hooks.post({ type: 'commentReply', thread: c.thread, body, toClaude, ...(toClaude ? { intent: c.intent } : {}) });
      else if (c.step) this.hooks.post({ type: 'commentCreate', step: c.step, body, toClaude, ...(toClaude ? { intent: c.intent } : {}) });
      delete this.drafts[c.key];
      this.persist();
      this.composer = undefined;
      this.following = true;
      this.hooks.announce(toClaude ? 'Sent to Claude' : 'Comment added');
      this.render();
    };
    send.addEventListener('click', (e) => {
      if (e.isTrusted) doSend();
    });
    // On the whole composer, so Ctrl/Cmd+Enter also sends from the intent picker or the mode buttons.
    root.addEventListener('keydown', (e) => {
      if (!e.isTrusted) return;
      e.stopPropagation(); // the panel's J/K/C/A keys don't apply while typing
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        doSend();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.escape();
      }
    });
    c.text.addEventListener('input', () => this.saveDraft());
    const row = el('div', 'cx-c-actions');
    const split = el('span', 'cx-c-split');
    split.append(send, pick);
    row.append(seg, intent, el('span', 'cx-c-spacer'), hint, split, button('cx-c-link', 'Discard', () => {
      delete this.drafts[c.key];
      this.persist();
      this.composer = undefined;
      this.following = true;
      this.render();
    }));
    root.append(chips, c.text, row, fmt);
    setMode(o.mode);
    this.render();
    requestAnimationFrame(() => c.text.focus());
  }

  private onVisible(entries: IntersectionObserverEntry[]) {
    for (const e of entries) {
      const id = (e.target as HTMLElement).dataset.thread!;
      if (e.isIntersecting && document.visibilityState === 'visible') {
        if (this.seen.has(id) || this.readTimers.has(id)) continue;
        this.readTimers.set(id, setTimeout(() => {
          this.readTimers.delete(id);
          const t = this.threads.find((x) => x.id === id);
          if (t?.unread) this.hooks.post({ type: 'threadRead', threads: [id] });
        }, 1000));
      } else {
        clearTimeout(this.readTimers.get(id));
        this.readTimers.delete(id);
      }
    }
  }

  private startResize(e: PointerEvent) {
    if (!e.isTrusted) return;
    const startY = e.clientY;
    const start = this.height;
    const move = (m: PointerEvent) => {
      this.height = Math.max(120, Math.min(window.innerHeight - 120, start + (startY - m.clientY)));
      this.pane.style.height = `${this.height}px`;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.persist();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
}

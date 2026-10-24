// Comment threads in the sidestory panel (docs/COMMENTS-PLAN.md §6): the host side. Builds the thread views for
// the sidestory a panel shows, and carries out what the panel's host-chrome controls ask for, after checking it.
import * as vscode from 'vscode';
import { authorLabel } from '../../core/threads/reduce.ts';
import { manifestId, type ThreadAnchor } from '../../core/threads/schema.ts';
import type { Location } from '../../comments/storage.ts';
import type { CommentsContext, CommentsFromWebview, CommentsToWebview, CommentItemView, ThreadView } from '../../shared/comments-protocol.ts';
import type { ExplainerRef } from '../explainers.ts';
import { claudeCommandText, copyThreadMarkdown, showHowTo } from './commands-text.ts';
import { codeAnchorLabel, type CommentService, type Entry } from './service.ts';

/** What the panel host needs from a session (src/extension/session.ts). */
export interface CommentsSession {
  readonly ref: ExplainerRef;
  postMessage(m: CommentsToWebview): boolean;
  /** Step anchor ids of the sidestory shown. */
  stepIds(): string[];
  /** Where each anchor's code is now (for placing code threads under steps). */
  anchorSpans(): { id: string; file: string; range: { start: number; end: number } | null }[];
  /** The manifest as parsed (raw), for the stable sidestory id. */
  manifestRaw(): Record<string, unknown> | undefined;
  readonly panel: vscode.WebviewPanel;
}

export interface PanelDeps {
  openCode(root: vscode.Uri, file: string, lines?: [number, number]): Promise<void>;
}

export class CommentsPanels implements vscode.Disposable {
  private readonly service: CommentService;
  private readonly deps: PanelDeps;
  private readonly sessions = new Set<CommentsSession>();
  private readonly views = new Map<CommentsSession, Map<string, Entry>>();
  private readonly timers = new Map<CommentsSession, ReturnType<typeof setTimeout>>();
  private readonly lastSent = new Map<CommentsSession, string>();
  private readonly sub: vscode.Disposable;

  constructor(service: CommentService, deps: PanelDeps) {
    this.service = service;
    this.deps = deps;
    this.sub = service.onDidChange(() => {
      for (const s of this.sessions) this.schedule(s);
    });
  }

  dispose(): void {
    this.sub.dispose();
    for (const t of this.timers.values()) clearTimeout(t);
  }

  attach(s: CommentsSession): vscode.Disposable {
    this.sessions.add(s);
    return {
      dispose: () => {
        this.sessions.delete(s);
        this.views.delete(s);
        this.lastSent.delete(s);
        clearTimeout(this.timers.get(s));
      },
    };
  }

  /** The page was (re)built or switched sidestories: send it the threads. */
  onInit(s: CommentsSession): void {
    this.lastSent.delete(s); // a rebuilt page has nothing
    this.schedule(s, 0);
  }

  show(s: CommentsSession, m: Extract<CommentsToWebview, { type: 'commentsShow' }>): void {
    s.postMessage(m);
  }

  private schedule(s: CommentsSession, ms = 50) {
    clearTimeout(this.timers.get(s));
    this.timers.set(
      s,
      setTimeout(() => void this.refresh(s).catch((e: unknown) => this.service.report(e, 'show the comments')), ms),
    );
  }

  /** Threads that belong in this panel: the sidestory's own (local and shared) and `_code` threads its steps cover. */
  async entriesFor(s: CommentsSession): Promise<{ entry: Entry; step?: string }[]> {
    const id = manifestId(s.manifestRaw());
    const spans = s.anchorSpans();
    const out: { entry: Entry; step?: string }[] = [];
    for (const e of await this.service.entries(s.ref.root)) {
      const sc = e.location.scope;
      if (sc.kind === 'sidestory' && sc.name === s.ref.name) {
        // A local thread written on another sidestory that reused this folder name goes to Elsewhere (§3.1).
        if (e.location.tier === 'local' && id && e.thread.origin?.sidestory && e.thread.origin.sidestory !== id) continue;
        out.push({ entry: e, step: stepOf(e.thread.anchor, spans) });
      } else if (sc.kind === 'code' && e.thread.anchor.kind === 'code') {
        const step = stepOf(e.thread.anchor, spans);
        if (step) out.push({ entry: e, step });
      }
    }
    return out;
  }

  async refresh(s: CommentsSession): Promise<void> {
    if (!this.sessions.has(s)) return;
    const list = await this.entriesFor(s);
    const steps = new Set(s.stepIds());
    const map = new Map<string, Entry>();
    const threads: ThreadView[] = [];
    for (const { entry, step } of list) {
      map.set(entry.thread.id, entry);
      threads.push(await this.view(entry, step, steps));
    }
    this.views.set(s, map);
    const route = await this.service.routeFor(s.ref.root).catch(() => ({ route: undefined, eligible: [], undetected: [] }));
    const tier = vscode.workspace.getConfiguration('sidestory.comments').get<string>('defaultLocation') === 'shared' ? 'shared' : 'local';
    const local = await this.service.repo(s.ref.root).files.checkLocalTier(false);
    const context: CommentsContext = {
      push: true,
      ...(route.route ? { session: this.service.sessionLabel(route.route) } : {}),
      manySessions: route.eligible.length + route.undetected.length > 1,
      defaultTier: tier,
      restricted: !vscode.workspace.isTrusted,
      ...(local.ok ? {} : { localBlocked: local.why }),
    };
    // Skip a post that would change nothing (the backstop polls while a send is in flight).
    const json = JSON.stringify({ threads, context });
    if (this.lastSent.get(s) === json) return;
    this.lastSent.set(s, json);
    s.postMessage({ type: 'threads', dir: s.ref.dir.toString(), threads, context });
  }

  private async view(e: Entry, step: string | undefined, steps: Set<string>): Promise<ThreadView> {
    const a = e.thread.anchor;
    const comments: CommentItemView[] = [];
    for (const c of e.thread.comments) {
      comments.push({
        id: c.id,
        author: authorLabel(c),
        trust: c.trust,
        claude: c.trust === 'claude',
        at: c.at,
        body: c.retracted ? '' : c.body,
        mine: c.trust === 'local_user',
        changed: c.changed,
        retracted: c.retracted,
        toClaude: c.to === 'claude',
        ...(c.trust === 'claude' && c.edited ? { editedChips: c.edited } : {}),
        ...(c.trust === 'local_user' && c.to === 'claude' && c.changed && this.service.wasSent(c.id) ? { editedAfterSend: true } : {}),
        ...(c.trust === 'local_user' && c.to === 'claude' ? { delivery: await this.service.delivery(e, c.id) } : {}),
      });
    }
    const target =
      a.kind === 'code'
        ? { kind: 'code' as const, file: a.file, lines: a.range, label: codeAnchorLabel(a), ...(step ? { step } : {}) }
        : { kind: 'step' as const, step: a.step, label: '', ...(steps.has(a.step) ? {} : { gone: true }) };
    const by = e.thread.stateBy;
    return {
      id: e.thread.id,
      tier: e.location.tier,
      target,
      state: e.thread.state,
      ...(by ? { stateText: `${by.type === 'resolve' ? 'Resolved' : 'Reopened'} by ${authorLabel({ by: by.by, trust: by.trust })}` } : {}),
      comments,
      unread: this.service.isUnread(e),
      suggestsResolve: e.thread.claudeSuggestsResolve,
      waiting: this.service.isWaiting(e),
      canReply: true,
      canDelete: e.location.tier === 'local',
      ...(await this.threadSession(e)),
    };
  }

  /** The session a send in this thread would go to (the send button names it). */
  private async threadSession(e: Entry): Promise<{ session?: string }> {
    const r = await this.service.routeFor(e.root, e.thread.id).catch(() => undefined);
    return r?.route ? { session: this.service.sessionLabel(r.route) } : {};
  }

  /** Handles a comments message from the panel; true when it was one. */
  handle(s: CommentsSession, m: CommentsFromWebview): boolean {
    void this.run(s, m).catch((e: unknown) => this.service.report(e, 'update the comment'));
    return true;
  }

  private entry(s: CommentsSession, thread: string): Entry | undefined {
    return this.views.get(s)?.get(thread);
  }

  private entryOfEvent(s: CommentsSession, event: string): Entry | undefined {
    for (const e of this.views.get(s)?.values() ?? []) if (e.thread.comments.some((c) => c.id === event)) return e;
    return undefined;
  }

  private async run(s: CommentsSession, m: CommentsFromWebview): Promise<void> {
    const svc = this.service;
    switch (m.type) {
      case 'commentCreate': {
        if (!s.stepIds().includes(m.step)) return;
        const tier = vscode.workspace.getConfiguration('sidestory.comments').get<string>('defaultLocation') === 'shared' ? 'shared' : 'local';
        const location: Location = { tier, scope: { kind: 'sidestory', name: s.ref.name } };
        if (m.toClaude && tier === 'shared' && !(await svc.warnSharedAsk(`new:${s.ref.name}`))) return;
        const { thread, event } = await svc.createThread(s.ref.root, location, { kind: 'step', step: m.step }, m.body, { toClaude: m.toClaude, sidestoryId: manifestId(s.manifestRaw()) });
        if (m.toClaude) {
          const e = await svc.findEntry(s.ref.root, thread);
          if (e) await svc.ask(e, event, m.body, m.intent ?? 'answer');
        }
        break;
      }
      case 'commentReply': {
        const e = this.entry(s, m.thread);
        if (!e) return;
        if (m.toClaude && e.location.tier === 'shared' && !(await this.confirmShared(e))) return;
        const event = await svc.reply(e, m.body, m.toClaude);
        if (m.toClaude) {
          const fresh = (await svc.findEntry(s.ref.root, m.thread)) ?? e;
          await svc.ask(fresh, event, m.body, m.intent ?? 'answer');
        }
        break;
      }
      case 'commentEdit':
      case 'commentRetract': {
        const e = this.entryOfEvent(s, m.event);
        if (!e) return;
        if (m.type === 'commentRetract') {
          const del = 'Delete';
          if ((await vscode.window.showWarningMessage('Delete this comment?', { modal: true }, del)) !== del) return;
        }
        await svc.change(e, m.event, m.type === 'commentEdit' ? m.body : undefined);
        break;
      }
      case 'threadAction': {
        const e = this.entry(s, m.thread);
        if (!e) return;
        await threadAction(svc, e, m.action, this.deps);
        break;
      }
      case 'threadRead': {
        const map = this.views.get(s);
        if (map) await svc.markRead(m.threads.map((t) => map.get(t)).filter((x): x is Entry => !!x));
        break;
      }
      case 'deliveryAction': {
        const e = this.entryOfEvent(s, m.event);
        if (e) await deliveryAction(svc, e, m.event, m.action);
        break;
      }
      case 'pickSession':
        await svc.pickSession(s.ref.root, false);
        this.schedule(s, 0);
        break;
      case 'sendCancel':
        break;
    }
  }

  private confirmShared(e: Entry): Promise<boolean> {
    return this.service.warnSharedAsk(e.thread.id);
  }
}

/** The tightest step whose anchor covers a code thread's lines. */
export function stepOf(a: ThreadAnchor, spans: { id: string; file: string; range: { start: number; end: number } | null }[]): string | undefined {
  if (a.kind !== 'code') return a.step;
  let best: { id: string; size: number } | undefined;
  for (const s of spans) {
    if (s.file !== a.file || !s.range) continue;
    if (s.range.start <= a.range[1] && s.range.end >= a.range[0]) {
      const size = s.range.end - s.range.start;
      if (!best || size < best.size) best = { id: s.id, size };
    }
  }
  return best?.id;
}

export async function threadAction(svc: CommentService, e: Entry, action: 'resolve' | 'reopen' | 'share' | 'local' | 'delete' | 'copyPrompt' | 'copyMarkdown' | 'showCode', deps: PanelDeps): Promise<void> {
  switch (action) {
    case 'resolve':
    case 'reopen':
      await svc.setState(e, action);
      break;
    case 'share':
      await svc.move(e, 'shared');
      break;
    case 'local':
      await svc.move(e, 'local');
      break;
    case 'delete':
      await svc.deleteThread(e);
      break;
    case 'copyPrompt': {
      await vscode.env.clipboard.writeText(svc.promptFor(e));
      const ask = [...e.thread.comments].reverse().find((c) => c.trust === 'local_user' && c.to === 'claude');
      if (ask) await svc.markCopied(ask.id);
      vscode.window.setStatusBarMessage('Prompt copied: paste it into Claude Code', 4000);
      break;
    }
    case 'copyMarkdown':
      await vscode.env.clipboard.writeText(copyThreadMarkdown(e));
      vscode.window.setStatusBarMessage('Thread copied as Markdown', 3000);
      break;
    case 'showCode':
      if (e.thread.anchor.kind === 'code') await deps.openCode(e.root, e.thread.anchor.file, e.thread.anchor.range);
      break;
  }
}

export async function deliveryAction(svc: CommentService, e: Entry, event: string, action: import('../../shared/comments-protocol.ts').DeliveryAction): Promise<void> {
  const c = e.thread.comments.find((x) => x.id === event);
  if (!c || c.trust !== 'local_user') return;
  switch (action) {
    case 'copyPrompt':
      await vscode.env.clipboard.writeText(svc.promptFor(e));
      await svc.markCopied(event);
      vscode.window.setStatusBarMessage('Prompt copied: paste it into Claude Code', 4000);
      break;
    case 'sendAgain':
      // A new send for the same comment; the old one is retired through the arbiter first.
      await svc.retire(event);
      await svc.ask(e, event, c.body, svc.intentOf(event));
      break;
    case 'chooseSession':
    case 'sendElsewhere': {
      if (!(await svc.retire(event))) {
        void vscode.window.showInformationMessage('That session already has the comment and is still running; it may still answer.');
        return;
      }
      const p = await svc.pickSession(e.root, action === 'chooseSession');
      if (p) await svc.ask(e, event, c.body, svc.intentOf(event), p);
      break;
    }
    case 'howTo':
      await showHowTo();
      break;
    case 'markAnswered':
    case 'stopWaiting':
      await svc.stopWaiting(e);
      break;
  }
}

export { claudeCommandText };

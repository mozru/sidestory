// Code comment threads in the editor through VS Code's Comments API (docs/COMMENTS-PLAN.md §7): the gutter +,
// inline thread widgets, the Comments panel and keyboard navigation, as reviewers know them.
import * as vscode from 'vscode';
import { join } from 'node:path';
import { pinQuote, trimBlankLines } from '../../core/pin.ts';
import { toEditorMarkdown } from '../../core/threads/markdown.ts';
import { authorLabel } from '../../core/threads/reduce.ts';
import { isPlainPath, type CodeAnchor } from '../../core/threads/schema.ts';
import { splitLines } from '../../core/text.ts';
import { resolveCode } from '../../comments/query.ts';
import type { Location } from '../../comments/storage.ts';
import { uriKey } from '../explainers.ts';
import { localPath } from '../local-path.ts';
import type { SidestoryIndex } from '../nav/index.ts';
import { deliveryAction, threadAction } from './panel.ts';
import { codeAnchorLabel, type CommentService, type Entry } from './service.ts';

interface OurThread extends vscode.CommentThread {
  sidestoryId?: string;
  root?: vscode.Uri;
  askOnly?: boolean;
}

class OurComment implements vscode.Comment {
  body: vscode.MarkdownString | string;
  mode: vscode.CommentMode;
  author: vscode.CommentAuthorInformation;
  label?: string;
  contextValue?: string;
  timestamp?: Date;
  readonly id: string;
  readonly thread: OurThread;
  readonly raw: string;
  constructor(id: string, thread: OurThread, raw: string, author: vscode.CommentAuthorInformation, label: string, contextValue: string, at: string) {
    this.id = id;
    this.thread = thread;
    this.raw = raw;
    this.body = editorMarkdown(raw);
    this.mode = vscode.CommentMode.Preview;
    this.author = author;
    this.label = label;
    this.contextValue = contextValue;
    const t = Date.parse(at);
    if (Number.isFinite(t)) this.timestamp = new Date(t);
  }
}

/** A MarkdownString that can't run commands, render HTML or icons, and whose autolinks are broken (§12.4). */
export function editorMarkdown(body: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString(toEditorMarkdown(body), false);
  md.isTrusted = false;
  md.supportHtml = false;
  md.supportThemeIcons = false;
  return md;
}

export class CommentsController implements vscode.Disposable {
  private readonly service: CommentService;
  private readonly index: SidestoryIndex;
  private readonly controller: vscode.CommentController;
  private readonly threads = new Map<string, OurThread>();
  private readonly subs: vscode.Disposable[] = [];
  private readonly icon: vscode.Uri;
  private refreshing: Promise<void> | undefined;
  private again = false;
  /** Lines the user selected for Comment on Selection: commentable even outside steps. */
  private expandNext: string | undefined;
  private selection: { key: string; range: vscode.Range } | undefined;

  constructor(service: CommentService, index: SidestoryIndex, extensionUri: vscode.Uri) {
    this.service = service;
    this.index = index;
    this.icon = vscode.Uri.joinPath(extensionUri, 'media', 'assistant.svg');
    this.controller = vscode.comments.createCommentController('sidestory', 'Sidestory');
    this.controller.options = { prompt: 'Comment, or Ask Claude…', placeHolder: 'Formatting: **bold**, *italic*, `code`, lists. Links show as text.' };
    this.controller.commentingRangeProvider = { provideCommentingRanges: (doc) => this.ranges(doc) };
    this.subs.push(this.controller, service.onDidChange(() => void this.refresh()));
    void this.refresh();
  }

  dispose(): void {
    for (const d of this.subs) d.dispose();
  }

  private rootFor(uri: vscode.Uri): vscode.Uri | undefined {
    if (uri.scheme !== 'file') return undefined;
    // The folder holding .sidestory/ that contains this file, from the index's sidestories, else the workspace folder.
    let best: vscode.Uri | undefined;
    for (const e of this.index.all()) {
      const r = e.ref.root;
      if ((uri.path + '/').startsWith(r.path.replace(/\/?$/, '/')) && (!best || r.path.length > best.path.length)) best = r;
    }
    return best ?? vscode.workspace.getWorkspaceFolder(uri)?.uri;
  }

  private ranges(doc: vscode.TextDocument): vscode.Range[] {
    const mode = vscode.workspace.getConfiguration('sidestory.comments').get<string>('ranges') ?? 'steps';
    if (doc.uri.scheme !== 'file') return [];
    if (mode === 'everywhere') return [new vscode.Range(0, 0, Math.max(0, doc.lineCount - 1), 0)];
    const out: vscode.Range[] = [];
    for (const s of this.index.anchorsIn(uriKey(doc.uri))) {
      const a = s.entry.start[s.index]!;
      const b = s.entry.end[s.index]!;
      if (a >= 1 && b >= a) out.push(new vscode.Range(Math.min(a, doc.lineCount) - 1, 0, Math.min(b, doc.lineCount) - 1, 0));
    }
    if (this.selection && this.selection.key === uriKey(doc.uri)) out.push(this.selection.range);
    return out;
  }

  /** Comment on Selection / Ask Claude About Selection: makes the selection commentable and opens a thread there. */
  async commentOnSelection(ask: boolean): Promise<void> {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.uri.scheme !== 'file') {
      // A diff's old side (and HEAD's, with includeUncommitted off) is a read-only version from git: no comments there.
      void vscode.window.showInformationMessage(ed?.document.uri.scheme === 'sidestory-git' ? "This is a read-only version from git. Comments go on the file as it is in your working tree: select the lines there." : 'Select lines in a file first.');
      return;
    }
    const sel = ed.selection;
    const range = new vscode.Range(sel.start.line, 0, sel.end.line, 0);
    this.selection = { key: uriKey(ed.document.uri), range };
    // Re-register the provider so VS Code asks for ranges again, then open a new thread on the selection.
    this.controller.commentingRangeProvider = { provideCommentingRanges: (doc) => this.ranges(doc) };
    const t = this.controller.createCommentThread(ed.document.uri, range, []) as OurThread;
    t.canReply = true;
    t.askOnly = ask;
    t.contextValue = ask ? 'sidestory:new:askOnly' : 'sidestory:new';
    t.label = ask ? 'Ask Claude about these lines' : 'New comment';
    t.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  }

  async refresh(): Promise<void> {
    if (this.refreshing) {
      this.again = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      do {
        this.again = false;
        await this.sync().catch((e: unknown) => this.service.report(e, 'show code comments'));
      } while (this.again);
    })().finally(() => (this.refreshing = undefined));
    return this.refreshing;
  }

  private roots(): vscode.Uri[] {
    const seen = new Map<string, vscode.Uri>();
    for (const e of this.index.all()) seen.set(e.ref.root.toString(), e.ref.root);
    for (const f of vscode.workspace.workspaceFolders ?? []) seen.set(f.uri.toString(), f.uri);
    return [...seen.values()];
  }

  private async sync() {
    const live = new Set<string>();
    for (const e of await this.service.allEntries(this.roots())) {
      const a = e.thread.anchor;
      if (a.kind !== 'code' || e.location.scope.kind === 'review') continue;
      live.add(e.thread.id);
      const uri = vscode.Uri.file(join(localPath(e.root), ...a.file.split('/')));
      const pos = await this.position(e.root, a);
      let t = this.threads.get(e.thread.id);
      if (t && t.uri.toString() !== uri.toString()) {
        t.dispose();
        t = undefined;
      }
      if (!t) {
        t = this.controller.createCommentThread(uri, pos.range, []) as OurThread;
        t.collapsibleState = this.expandNext === e.thread.id ? vscode.CommentThreadCollapsibleState.Expanded : vscode.CommentThreadCollapsibleState.Collapsed;
        if (this.expandNext === e.thread.id) this.expandNext = undefined;
        this.threads.set(e.thread.id, t);
      } else if (!t.range || !t.range.isEqual(pos.range)) t.range = pos.range;
      t.root = e.root;
      await this.fill(t, e, pos.state);
    }
    for (const [id, t] of this.threads) {
      if (!live.has(id)) {
        t.dispose();
        this.threads.delete(id);
      }
    }
  }

  private async position(root: vscode.Uri, a: CodeAnchor): Promise<{ range: vscode.Range; state: string }> {
    const r = await resolveCode(localPath(root), a).catch(() => ({ state: 'lost' as const }));
    const lines = 'lines' in r && r.lines ? r.lines : a.range;
    return { range: new vscode.Range(lines[0] - 1, 0, lines[1] - 1, 0), state: r.state };
  }

  private async fill(t: OurThread, e: Entry, codeState: string) {
    // A comment being edited keeps its editor: refreshes wait until it is saved or cancelled.
    if (t.comments.some((c) => c.mode === vscode.CommentMode.Editing)) return;
    const ask = [...e.thread.comments].reverse().find((c) => c.trust === 'local_user' && c.to === 'claude' && !c.retracted);
    const d = ask ? await this.service.delivery(e, ask.id) : undefined;
    const lost = codeState === 'lost' ? ' · Code not found' : codeState === 'changed' || codeState === 'stale' ? ' · Code changed' : '';
    const answered = e.thread.comments.some((c) => c.trust === 'claude');
    t.label = `${codeAnchorLabel(e.thread.anchor as CodeAnchor)}${lost}${d ? ` · ${d.text}` : answered ? ' · Claude replied' : ''}${e.location.tier === 'local' ? ' · local' : ''}`;
    t.state = e.thread.state === 'resolved' ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
    const flags = ['sidestory', e.thread.state, e.location.tier, ...(d ? ['waiting'] : []), ...(e.location.scope.kind === 'sidestory' ? ['shareable'] : [])];
    t.contextValue = flags.join(':');
    t.canReply = true;
    t.comments = e.thread.comments
      .filter((c) => !c.retracted)
      .map((c) => {
        const tier = c.trust === 'repository' ? 'from the repository' : e.location.tier;
        const author: vscode.CommentAuthorInformation = { name: authorLabel(c), ...(c.trust === 'claude' ? { iconPath: this.icon } : {}) };
        const ctx = [c.trust === 'local_user' ? 'mine' : 'other', ...(c.trust === 'local_user' && c.to === 'claude' ? ['sent'] : [])].join(':');
        return new OurComment(c.id, t, c.body, author, `${tier}${c.changed ? ' · edited' : ''}`, ctx, c.at);
      });
    (t as OurThread & { entryId?: string }).entryId = e.thread.id;
  }

  private entryIdOf(t: vscode.CommentThread): string | undefined {
    return (t as OurThread & { entryId?: string }).entryId;
  }

  private async entryOf(t: vscode.CommentThread): Promise<Entry | undefined> {
    const id = this.entryIdOf(t);
    const root = (t as OurThread).root ?? this.rootFor(t.uri);
    return id && root ? this.service.findEntry(root, id) : undefined;
  }

  /** The reply box's Comment and Ask Claude buttons. A thread VS Code made from the gutter + is new: create it. */
  async reply(r: vscode.CommentReply, toClaude: boolean, intent: 'answer' | 'edit' = 'answer'): Promise<void> {
    const text = r.text.trim();
    if (!text) return;
    const existing = await this.entryOf(r.thread);
    if (existing) {
      if (toClaude && existing.location.tier === 'shared' && !(await this.service.warnSharedAsk(existing.thread.id))) return;
      const ev = await this.service.reply(existing, text, toClaude);
      if (toClaude) {
        const fresh = (await this.service.findEntry(existing.root, existing.thread.id)) ?? existing;
        await this.service.ask(fresh, ev, text, intent);
      }
      return;
    }
    const created = await this.createFrom(r.thread, text, toClaude);
    if (!created) return; // keep the reader's text in the widget
    r.thread.dispose();
    this.selection = undefined;
    this.expandNext = created.thread; // the thread just written opens expanded, to show delivery and the reply
    void this.refresh();
    if (toClaude) {
      const e = await this.service.findEntry(created.root, created.thread);
      if (e) await this.service.ask(e, created.event, text, intent);
    }
  }

  private async createFrom(t: vscode.CommentThread, text: string, toClaude: boolean): Promise<{ root: vscode.Uri; thread: string; event: string } | undefined> {
    const root = this.rootFor(t.uri);
    if (!root || !t.range) return undefined;
    const rel = vscode.workspace.asRelativePath(t.uri, false);
    const relToRoot = t.uri.path.slice(root.path.replace(/\/?$/, '/').length);
    const file = relToRoot || rel;
    if (!isPlainPath(file)) {
      void vscode.window.showWarningMessage("Can't comment on a file with an unusual name.");
      return undefined;
    }
    const doc = await vscode.workspace.openTextDocument(t.uri);
    const lines = splitLines(doc.getText());
    const want = { start: t.range.start.line + 1, end: t.range.end.line + 1 };
    const trimmed = trimBlankLines(lines, want) ?? want;
    const quote = pinQuote(lines, trimmed);
    if (!quote) {
      void vscode.window.showWarningMessage('Select some code to comment on.');
      return undefined;
    }
    const anchor: CodeAnchor = { kind: 'code', file, side: 'head', quote: { exact: quote.exact, prefix: quote.prefix, suffix: quote.suffix }, range: [trimmed.start, trimmed.end] };
    // Stored with the tightest sidestory covering it, else in `_code` (§3.1).
    const covering = this.index.anchorsCovering(uriKey(t.uri), trimmed.start, trimmed.end).sort((a, b) => a.entry.end[a.index]! - a.entry.start[a.index]! - (b.entry.end[b.index]! - b.entry.start[b.index]!))[0];
    const tier = vscode.workspace.getConfiguration('sidestory.comments').get<string>('defaultLocation') === 'shared' && covering ? 'shared' : 'local';
    if (toClaude && tier === 'shared' && !(await this.service.warnSharedAsk(`new:${covering!.entry.ref.name}`))) return undefined;
    const location: Location = covering ? { tier, scope: { kind: 'sidestory', name: covering.entry.ref.name } } : { tier: 'local', scope: { kind: 'code' } };
    const sidestoryId = covering?.entry.id;
    const created = await this.service.createThread(root, location, anchor, text, { toClaude, ...(sidestoryId ? { sidestoryId } : {}) });
    return { root, ...created };
  }

  // ---- menu commands ----

  async threadCommand(t: vscode.CommentThread | undefined, action: 'resolve' | 'reopen' | 'share' | 'local' | 'copyPrompt' | 'delete', deps: { openCode(root: vscode.Uri, file: string, lines?: [number, number]): Promise<void> }): Promise<void> {
    if (!t) return;
    const e = await this.entryOf(t);
    if (e) await threadAction(this.service, e, action, deps);
  }

  /** Choose a Session… for the thread's latest ask (the editor's "No session" state has no buttons). */
  async chooseSession(t: vscode.CommentThread | undefined): Promise<void> {
    const e = t && (await this.entryOf(t));
    const ask = e && [...e.thread.comments].reverse().find((c) => c.trust === 'local_user' && c.to === 'claude' && !c.retracted);
    if (e && ask) await deliveryAction(this.service, e, ask.id, 'chooseSession');
    else if (e) void vscode.window.showInformationMessage('Nothing in this thread was sent to Claude yet: reply with Ask Claude.');
  }

  /** The step whose anchor covers a code thread, for Show in Sidestory. */
  async sidestoryOf(t: vscode.CommentThread | undefined): Promise<{ dir: string; anchor?: string } | undefined> {
    const e = t && (await this.entryOf(t));
    if (!e || !t?.range) return undefined;
    const covering = this.index.anchorsCovering(uriKey(t.uri), t.range.start.line + 1, t.range.end.line + 1).sort((a, b) => a.entry.end[a.index]! - a.entry.start[a.index]! - (b.entry.end[b.index]! - b.entry.start[b.index]!))[0];
    if (covering) return { dir: covering.entry.ref.dir.toString(), anchor: covering.entry.ids[covering.index] };
    if (e.location.scope.kind === 'sidestory') return { dir: vscode.Uri.joinPath(e.root, '.sidestory', e.location.scope.name).toString() };
    return undefined;
  }

  async commentCommand(c: vscode.Comment | undefined, action: 'edit' | 'delete' | 'sendAgain' | 'save' | 'cancel'): Promise<void> {
    if (!(c instanceof OurComment)) return;
    const e = await this.entryOf(c.thread);
    if (!e) return;
    switch (action) {
      case 'edit':
        c.mode = vscode.CommentMode.Editing;
        c.body = c.raw;
        c.thread.comments = [...c.thread.comments];
        break;
      case 'cancel':
        c.mode = vscode.CommentMode.Preview;
        c.body = editorMarkdown(c.raw);
        c.thread.comments = [...c.thread.comments];
        void this.refresh(); // changes that arrived while editing
        break;
      case 'save': {
        const text = typeof c.body === 'string' ? c.body : c.body.value;
        c.mode = vscode.CommentMode.Preview;
        if (text.trim()) await this.service.change(e, c.id, text.trim());
        else void this.refresh();
        break;
      }
      case 'delete': {
        const del = 'Delete';
        if ((await vscode.window.showWarningMessage('Delete this comment?', { modal: true }, del)) === del) await this.service.change(e, c.id, undefined);
        break;
      }
      case 'sendAgain':
        await deliveryAction(this.service, e, c.id, 'sendAgain');
        break;
    }
  }

  /** Opens a code thread's widget (from the Comments view). */
  async reveal(root: vscode.Uri, thread: string): Promise<void> {
    await this.refresh();
    const t = this.threads.get(thread);
    if (!t) return;
    await vscode.window.showTextDocument(t.uri, { selection: t.range, preserveFocus: false });
    t.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    void root;
  }
}

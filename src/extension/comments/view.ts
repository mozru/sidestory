// The Comments view in the Sidestory container (docs/COMMENTS-PLAN.md §11.1): For you, Waiting for Claude, Open,
// Resolved, Elsewhere. Labels are repository text cleaned once (displayText) and shown with icons escaped.
import * as vscode from 'vscode';
import { displayText, escapeIcons } from '../../core/display-text.ts';
import { authorLabel, latestAsk } from '../../core/threads/reduce.ts';
import type { CodeAnchor } from '../../core/threads/schema.ts';
import type { SidestoryIndex } from '../nav/index.ts';
import { codeAnchorLabel, threadRoots, type CommentService, type Entry } from './service.ts';

type Group = 'forYou' | 'waiting' | 'open' | 'resolved' | 'elsewhere';
const GROUPS: { id: Group; label: string; collapsed?: boolean }[] = [
  { id: 'forYou', label: 'For you' },
  { id: 'waiting', label: 'Waiting for Claude' },
  { id: 'open', label: 'Open' },
  { id: 'resolved', label: 'Resolved', collapsed: true },
  { id: 'elsewhere', label: 'Elsewhere', collapsed: true },
];

export type CommentNode = { kind: 'group'; group: Group; count: number } | { kind: 'thread'; group: Group; entry: Entry; label: string; description: string; tooltip: string };

export interface SidestoryComments {
  open: number;
  forYou: number;
}

export class CommentsView implements vscode.TreeDataProvider<CommentNode>, vscode.Disposable {
  private readonly service: CommentService;
  private readonly index: SidestoryIndex;
  private readonly emitter = new vscode.EventEmitter<CommentNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  view: vscode.TreeView<CommentNode> | undefined;
  private groups = new Map<Group, CommentNode[]>();
  /** Open threads per sidestory (its index key), and how many have something for the reader: for the Sidestories view. */
  private perSidestory = new Map<string, SidestoryComments>();
  private readonly countsEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCounts = this.countsEmitter.event;
  private readonly subs: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  filter = '';
  showResolved = true;

  constructor(service: CommentService, index: SidestoryIndex) {
    this.service = service;
    this.index = index;
    this.subs.push(this.emitter, this.countsEmitter, service.onDidChange(() => this.schedule()), index.onDidChangeState(() => this.schedule()));
    this.schedule();
  }

  /** Open comment threads on a sidestory (by index key). */
  commentsOn(key: string): SidestoryComments | undefined {
    return this.perSidestory.get(key);
  }

  dispose(): void {
    clearTimeout(this.timer);
    for (const d of this.subs) d.dispose();
  }

  private schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.rebuild().catch((e: unknown) => this.service.report(e, 'list comments')), 150);
  }

  /** Every thread, grouped. */
  async rebuild(): Promise<void> {
    const entries = await this.service.allEntries(threadRoots(this.index));
    const known = new Map<string, { title: string; id?: string; key: string }>();
    for (const e of this.index.all()) known.set(`${e.ref.root.toString()}|${e.ref.name}`, { title: e.title, id: e.id, key: e.key });
    const counts = new Map<string, SidestoryComments>();
    const groups = new Map<Group, CommentNode[]>(GROUPS.map((g) => [g.id, []]));
    const f = this.filter.toLowerCase();
    for (const e of entries) {
      const sc = e.location.scope;
      const ss = sc.kind === 'sidestory' ? known.get(`${e.root.toString()}|${sc.name}`) : undefined;
      const a = e.thread.anchor;
      const where = a.kind === 'code' ? codeAnchorLabel(a as CodeAnchor) : `${displayText(ss?.title || (sc.kind === 'sidestory' ? sc.name : ''), 60)} › ${a.step}`;
      const last = [...e.thread.comments].reverse().find((c) => !c.retracted);
      const excerpt = last ? `${authorLabel(last)}: “${displayText(last.body, 80)}”` : '';
      const node = (group: Group): CommentNode => ({
        kind: 'thread',
        group,
        entry: e,
        label: escapeIcons(where),
        description: escapeIcons(excerpt),
        tooltip: `${displayText(e.thread.comments[0]?.body ?? '', 300)}\n\n${e.location.tier === 'local' ? 'Local: only on this machine' : 'Shared: committed with the sidestory'}`,
      });
      const elsewhere = (sc.kind === 'sidestory' && !ss) || (sc.kind === 'sidestory' && e.location.tier === 'local' && ss?.id && e.thread.origin?.sidestory && e.thread.origin.sidestory !== ss.id);
      const forReader = e.thread.state === 'open' && !elsewhere && ((this.service.tookPart(e) && this.service.isUnread(e)) || e.thread.claudeSuggestsResolve);
      if (ss && !elsewhere && e.thread.state === 'open') {
        const c = counts.get(ss.key) ?? { open: 0, forYou: 0 };
        c.open++;
        if (forReader && !this.service.isWaiting(e)) c.forYou++;
        counts.set(ss.key, c);
      }
      if (f && !`${where} ${excerpt}`.toLowerCase().includes(f)) continue;
      if (elsewhere) groups.get('elsewhere')!.push(node('elsewhere'));
      else if (e.thread.state === 'resolved') {
        if (this.showResolved) groups.get('resolved')!.push(node('resolved'));
      } else {
        if (this.service.isWaiting(e)) {
          const n = node('waiting') as Extract<CommentNode, { kind: 'thread' }>;
          const ask = latestAsk(e.thread);
          const d = ask ? await this.service.delivery(e, ask.id) : undefined;
          if (d) n.description = escapeIcons(d.text);
          groups.get('waiting')!.push(n);
        }
        else if ((this.service.tookPart(e) && this.service.isUnread(e)) || e.thread.claudeSuggestsResolve) groups.get('forYou')!.push(node('forYou'));
        else groups.get('open')!.push(node('open'));
      }
    }
    this.groups = groups;
    if (JSON.stringify([...counts]) !== JSON.stringify([...this.perSidestory])) {
      this.perSidestory = counts;
      this.countsEmitter.fire();
    }
    const forYou = groups.get('forYou')!.length;
    const waiting = groups.get('waiting')!.length;
    if (this.view) {
      this.view.badge = forYou ? { value: forYou, tooltip: `${forYou} comment thread${forYou === 1 ? '' : 's'} for you` } : undefined;
      this.view.description = [forYou ? `${forYou} for you` : '', waiting ? `${waiting} waiting for Claude` : ''].filter(Boolean).join(' · ') || undefined;
    }
    void vscode.commands.executeCommand('setContext', 'sidestory.comments.any', entries.length > 0);
    this.emitter.fire(undefined);
  }

  getChildren(node?: CommentNode): CommentNode[] {
    if (!node) return GROUPS.filter((g) => (this.groups.get(g.id)?.length ?? 0) > 0).map((g) => ({ kind: 'group', group: g.id, count: this.groups.get(g.id)!.length }));
    if (node.kind === 'group') return this.groups.get(node.group) ?? [];
    return [];
  }

  getTreeItem(node: CommentNode): vscode.TreeItem {
    if (node.kind === 'group') {
      const g = GROUPS.find((x) => x.id === node.group)!;
      const item = new vscode.TreeItem(`${g.label} (${node.count})`, g.collapsed ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded);
      item.contextValue = `sidestory.commentGroup.${node.group}`;
      item.id = `group:${node.group}`;
      return item;
    }
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    item.description = node.description;
    item.tooltip = node.tooltip;
    item.id = `thread:${node.entry.root.toString()}:${node.entry.thread.id}`;
    item.iconPath = new vscode.ThemeIcon(node.entry.thread.state === 'resolved' ? 'pass' : this.service.isUnread(node.entry) ? 'comment-unresolved' : 'comment');
    item.contextValue = `sidestory.commentThread.${node.group}.${node.entry.location.tier}`;
    item.command = { command: 'sidestory.comments.openThread', title: 'Open Thread', arguments: [node] };
    return item;
  }

  /** Thread nodes in a group (for Copy Prompt: Answer Waiting Comments, Mark All Read). */
  nodes(group?: Group): CommentNode[] {
    return group ? (this.groups.get(group) ?? []) : [...this.groups.values()].flat();
  }
}

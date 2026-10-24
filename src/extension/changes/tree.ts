// The Changes view's rows (docs/CHANGES-PLAN.md §9.2): compact folders with counts, files with their status letter
// (a decoration on a `sidestory-change:` resource), `+/−` counts and renames, or a flat list in the chosen sort.
// Every node is built once per render (about 100 B each), so `getParent` and `reveal` work on any file whatever is
// expanded. Paths are repository text: cleaned with displayText, tooltips are plain strings.
import * as vscode from 'vscode';
import { displayText } from '../../core/display-text.ts';
import { changeUri } from './git-fs.ts';
import type { ChangeEntry, FolderNode, SortKey } from './model.ts';
import { baseName, buildTree, countsLabel, dirName, EXPAND_ALL_UP_TO, folderLabel, sortEntries, STATUS_NAMES, treeOrder } from './model.ts';

export type ChangesNode =
  | { readonly kind: 'repo'; readonly id: string; readonly label: string; readonly parent?: undefined }
  | { readonly kind: 'folder'; readonly id: string; readonly folder: FolderNode; readonly parent?: ChangesNode }
  | { readonly kind: 'file'; readonly id: string; readonly entry: ChangeEntry; readonly parent?: ChangesNode };

export interface Render {
  /** Files after the filter. */
  readonly entries: readonly ChangeEntry[];
  readonly listMode: boolean;
  readonly sort: SortKey;
  /** Working tree mode: the right side is the file on disk. */
  readonly onDisk: boolean;
  /** With several repositories, the repository row's label. */
  readonly repoLabel?: string;
}

const clean = (s: string) => displayText(s, 300);

export class ChangesTree implements vscode.TreeDataProvider<ChangesNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<ChangesNode | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private render: Render | undefined;
  private top: ChangesNode[] = [];
  private readonly children = new Map<ChangesNode, ChangesNode[]>();
  private readonly byPath = new Map<string, ChangesNode>();
  /** Files in the order the view shows them (tree order or the list's sort): what Next Changed File walks. */
  order: ChangeEntry[] = [];
  /** Bumped by Collapse All: new ids make VS Code forget the expansion. */
  private generation = 0;
  private expandAll = true;

  set(render: Render | undefined): void {
    this.render = render;
    this.build();
    this.emitter.fire();
  }

  /** Repaints the rows (counts that arrived later) without rebuilding ids or expansion. */
  repaint(): void {
    if (this.render) this.build();
    this.emitter.fire();
  }

  collapseAll(): void {
    this.generation++;
    this.expandAll = false;
    this.build();
    this.emitter.fire();
  }

  nodeFor(path: string): ChangesNode | undefined {
    return this.byPath.get(path);
  }

  private build(): void {
    this.children.clear();
    this.byPath.clear();
    this.top = [];
    this.order = [];
    const r = this.render;
    if (!r) return;
    const g = this.generation;
    if (r.repoLabel) this.top.push({ kind: 'repo', id: `repo:${g}`, label: r.repoLabel });
    const fileNode = (entry: ChangeEntry, parent: ChangesNode | undefined): ChangesNode => {
      const n: ChangesNode = { kind: 'file', id: `f${g}:${entry.path}`, entry, parent };
      this.byPath.set(entry.path, n);
      return n;
    };
    if (r.listMode) {
      this.order = sortEntries(r.entries, r.sort);
      for (const e of this.order) this.top.push(fileNode(e, undefined));
      return;
    }
    const root = buildTree(r.entries, r.sort);
    this.order = treeOrder(root);
    const make = (f: FolderNode, parent: ChangesNode | undefined): ChangesNode => {
      const n: ChangesNode = { kind: 'folder', id: `d${g}:${f.path}`, folder: f, parent };
      this.children.set(n, [...f.folders.map((c) => make(c, n)), ...f.files.map((e) => fileNode(e, n))]);
      return n;
    };
    this.top.push(...root.folders.map((f) => make(f, undefined)), ...root.files.map((e) => fileNode(e, undefined)));
  }

  getChildren(node?: ChangesNode): ChangesNode[] {
    if (!node) return this.top;
    return this.children.get(node) ?? [];
  }

  getParent(node: ChangesNode): ChangesNode | undefined {
    return node.parent;
  }

  getTreeItem(node: ChangesNode): vscode.TreeItem {
    if (node.kind === 'repo') {
      const item = new vscode.TreeItem(`Repository: ${clean(node.label)}`, vscode.TreeItemCollapsibleState.None);
      item.id = node.id;
      item.iconPath = new vscode.ThemeIcon('repo');
      item.tooltip = 'Several repositories are open: pick the one to compare';
      item.command = { command: 'sidestory.changes.pickRepository', title: 'Change Repository…' };
      item.contextValue = 'repo';
      return item;
    }
    if (node.kind === 'folder') {
      const f = node.folder;
      const many = (this.render?.entries.length ?? 0) > EXPAND_ALL_UP_TO;
      const expanded = this.expandAll && (!many || f.depth === 0);
      const item = new vscode.TreeItem(clean(f.label), expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      item.id = node.id;
      item.resourceUri = changeUri(f.path, 'folder');
      item.iconPath = vscode.ThemeIcon.Folder;
      item.description = folderLabel(f);
      item.tooltip = `${clean(f.path)}\n${folderLabel(f)}`;
      item.contextValue = 'folder';
      return item;
    }
    const e = node.entry;
    const name = baseName(e.path);
    const item = new vscode.TreeItem(clean(name), vscode.TreeItemCollapsibleState.None);
    item.id = node.id;
    item.resourceUri = changeUri(e.path, e.status);
    item.iconPath = vscode.ThemeIcon.File;
    item.description = this.describe(e);
    item.tooltip = this.tooltip(e);
    item.accessibilityInformation = { label: `${clean(name)}, ${STATUS_NAMES[e.status]}${e.untracked ? ', untracked' : ''}, ${item.description}` };
    item.command = { command: 'sidestory.changes.open', title: 'Open Diff', arguments: [{ path: e.path }] };
    const onDisk = this.render?.onDisk && e.status !== 'D';
    item.contextValue = `file:${e.status}${e.status === 'D' ? ':deleted' : ''}${onDisk ? ':onDisk' : ''}`;
    return item;
  }

  private describe(e: ChangeEntry): string {
    const parts: string[] = [];
    if (this.render?.listMode) {
      const dir = dirName(e.path);
      if (dir) parts.push(clean(dir));
    }
    if (e.oldPath) parts.push(`← ${clean(e.oldPath)}`);
    const counts = countsLabel(e);
    if (counts) parts.push(counts);
    if (e.untracked) parts.push('untracked');
    if (e.unsaved) parts.push('unsaved');
    return parts.join(' · ');
  }

  private tooltip(e: ChangeEntry): string {
    const lines = [`${clean(e.path)}`, e.oldPath ? `${STATUS_NAMES[e.status]} from ${clean(e.oldPath)}` : STATUS_NAMES[e.status]];
    if (e.untracked) lines[1] += ' (untracked)';
    const counts = countsLabel(e);
    if (counts) lines.push(counts === 'no line changes' ? 'No line changes: binary, a mode change or an empty file' : `${counts} lines`);
    if (e.unsaved) lines.push('Has unsaved edits: counts are of the file on disk');
    if (clean(e.path) !== e.path || (e.oldPath && clean(e.oldPath) !== e.oldPath)) lines.push(`⚠ The path has unusual characters: ${JSON.stringify(e.path)}`);
    return lines.join('\n');
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

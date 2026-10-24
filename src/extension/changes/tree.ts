// The Changes view's rows (docs/CHANGES-PLAN.md §9.2): compact folders with counts, files with their status letter
// (a decoration on a `sidestory-change:` resource), `+/−` counts and renames, or a flat list in the chosen sort.
// Every node is built once per render (about 100 B each), so `getParent` and `reveal` work on any file whatever is
// expanded. Paths are repository text: cleaned with displayText, tooltips are plain strings.
import * as vscode from 'vscode';
import { displayText } from '../../core/display-text.ts';
import { changeUri } from './git-fs.ts';
import type { ChangeCoverage, FileCoverage } from '../../core/coverage.ts';
import type { ChangeBlock } from '../../core/hunks.ts';
import { changeCounts, changeIcon, changeLabel, fileMark, fileMarkLabel, folderLeft, hunkLines, isDone, stateWords } from './coverage-labels.ts';
import type { ChangeEntry, FolderNode, SortKey } from './model.ts';
import { baseName, buildTree, countsLabel, dirName, EXPAND_ALL_UP_TO, folderLabel, sortEntries, STATUS_NAMES, treeOrder } from './model.ts';

export type ChangesNode =
  | { readonly kind: 'repo'; readonly id: string; readonly label: string; readonly parent?: undefined }
  | { readonly kind: 'folder'; readonly id: string; readonly folder: FolderNode; readonly parent?: ChangesNode }
  | { readonly kind: 'file'; readonly id: string; readonly entry: ChangeEntry; readonly parent?: ChangesNode }
  | { readonly kind: 'row'; readonly id: string; readonly row: LayerRow; readonly parent?: undefined }
  | { readonly kind: 'change'; readonly id: string; readonly path: string; readonly change: ChangeCoverage; readonly block: ChangeBlock; readonly parent: ChangesNode }
  | { readonly kind: 'more'; readonly id: string; readonly path: string; readonly count: number; readonly parent: ChangesNode };

/** A row above the files (§9.6): a belonging sidestory, or a "Copy Prompt" action. */
export interface LayerRow {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly tooltip?: string;
  readonly icon: string;
  readonly command: { command: string; title: string; arguments?: unknown[] };
  readonly contextValue: string;
}

/** The coverage layer (§9.6): rows above the files, and coverage per file when a sidestory belongs. */
export interface Layer {
  readonly rows: readonly LayerRow[];
  /** Coverage per file path, with its change blocks. */
  readonly files: ReadonlyMap<string, { coverage: FileCoverage | undefined; blocks: ReadonlyMap<string, ChangeBlock> }>;
  /** Show only changes that aren't done. */
  readonly onlyUnexplained: boolean;
  /** "Retry › Delay" for what explains a change. */
  stepName(sidestory: string, anchor: string): string;
}

/** Change items per file (§4.6), then "+N more", which opens the diff. */
export const MAX_CHANGE_ITEMS = 200;

export interface Render {
  /** Files after the filter. */
  readonly entries: readonly ChangeEntry[];
  readonly listMode: boolean;
  readonly sort: SortKey;
  /** Working tree mode: the right side is the file on disk. */
  readonly onDisk: boolean;
  /** With several repositories, the repository row's label. */
  readonly repoLabel?: string;
  readonly layer?: Layer;
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

  /** Repaints the rows (counts that arrived later): folder totals are summed again, the order doesn't move. */
  repaint(): void {
    const sum = (n: ChangesNode): void => {
      if (n.kind !== 'folder') return;
      const f = n.folder;
      f.added = f.removed = f.uncounted = 0;
      for (const c of this.children.get(n) ?? []) {
        if (c.kind === 'folder') {
          sum(c);
          f.added += c.folder.added;
          f.removed += c.folder.removed;
          f.uncounted += c.folder.uncounted;
        } else if (c.kind === 'file') {
          f.added += c.entry.added ?? 0;
          f.removed += c.entry.removed ?? 0;
          if (c.entry.added === undefined && c.entry.removed === undefined && !c.entry.noText) f.uncounted++;
        }
      }
    };
    this.top.forEach(sum);
    this.emitter.fire();
  }

  /** A new comparison starts expanded again after Collapse All. */
  resetExpansion(): void {
    if (this.expandAll) return;
    this.expandAll = true;
    this.generation++; // new ids: VS Code forgets the collapsed state
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
    for (const row of r.layer?.rows ?? []) this.top.push({ kind: 'row', id: `row:${row.id}`, row });
    const fileNode = (entry: ChangeEntry, parent: ChangesNode | undefined): ChangesNode => {
      const n: ChangesNode = { kind: 'file', id: `f${g}:${entry.path}`, entry, parent };
      this.byPath.set(entry.path, n);
      const cov = r.layer?.files.get(entry.path);
      if (cov?.coverage) {
        const shown = cov.coverage.changes.filter((c) => !r.layer!.onlyUnexplained || !isDone(c.state));
        const kids: ChangesNode[] = [];
        for (const c of shown.slice(0, MAX_CHANGE_ITEMS)) {
          const block = cov.blocks.get(c.key);
          if (block) kids.push({ kind: 'change', id: `c${g}:${entry.path}:${c.key}`, path: entry.path, change: c, block, parent: n });
        }
        if (shown.length > MAX_CHANGE_ITEMS) kids.push({ kind: 'more', id: `m${g}:${entry.path}`, path: entry.path, count: shown.length - MAX_CHANGE_ITEMS, parent: n });
        if (kids.length) this.children.set(n, kids);
      }
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

  /** The node of a change, by file path and change key. */
  changeNode(path: string, key: string): ChangesNode | undefined {
    const f = this.byPath.get(path);
    return f ? this.children.get(f)?.find((c) => c.kind === 'change' && c.change.key === key) : undefined;
  }

  getTreeItem(node: ChangesNode): vscode.TreeItem {
    if (node.kind === 'row') {
      const r = node.row;
      const item = new vscode.TreeItem(r.label, vscode.TreeItemCollapsibleState.None);
      item.id = node.id;
      item.iconPath = new vscode.ThemeIcon(r.icon);
      item.description = r.description;
      item.tooltip = r.tooltip;
      item.command = r.command;
      item.contextValue = r.contextValue;
      return item;
    }
    if (node.kind === 'more') {
      const item = new vscode.TreeItem(`+${node.count} more`, vscode.TreeItemCollapsibleState.None);
      item.id = node.id;
      item.command = { command: 'sidestory.changes.open', title: 'Open Diff', arguments: [{ path: node.path }] };
      item.contextValue = 'more';
      return item;
    }
    if (node.kind === 'change') {
      const c = node.change;
      const b = node.block;
      const item = new vscode.TreeItem(changeLabel(b), vscode.TreeItemCollapsibleState.None);
      item.id = node.id;
      const icon = changeIcon(c);
      item.iconPath = new vscode.ThemeIcon(icon.id, icon.colored ? new vscode.ThemeColor('sidestory.unexplainedForeground') : undefined);
      const by = c.state === 'trivial' ? [] : [...new Map(c.by.map((x) => [`${x.sidestory}\0${x.anchor}`, x])).values()];
      const names = by.map((x) => this.render?.layer?.stepName(x.sidestory, x.anchor) ?? x.anchor);
      item.description = [changeCounts(b), c.state === 'explained' && names[0] ? clean(names[0]) : ''].filter(Boolean).join(' · ');
      const lines = [`${changeLabel(b)} ${changeCounts(b)}`.trim(), stateWords(c)];
      if (c.state === 'partly') lines.push(`${c.coveredLines} of ${c.changedLines} lines covered`);
      if (names.length) lines.push(`By ${names.map(clean).join(', ')}`);
      if (c.broad) lines.push('Explained by a broad step (more than 40 lines, several times the change)');
      item.tooltip = lines.join('\n');
      item.accessibilityInformation = { label: `${changeLabel(b)}, ${changeCounts(b)}, ${stateWords(c)}` };
      item.command = { command: 'sidestory.changes.openChange', title: 'Open Change', arguments: [{ path: node.path, key: c.key }] };
      item.contextValue = `change:${c.state}${by.length ? ':explained' : ''}`;
      return item;
    }
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
      const left = this.render?.layer ? folderLeft(this.filesUnder(node).map((p) => this.render!.layer!.files.get(p)?.coverage)) : 0;
      item.description = `${folderLabel(f)}${left ? ` · ${left} left` : ''}`;
      item.tooltip = `${clean(f.path)}\n${item.description}`;
      item.contextValue = 'folder';
      return item;
    }
    const e = node.entry;
    const name = baseName(e.path);
    const hasKids = (this.children.get(node)?.length ?? 0) > 0;
    const item = new vscode.TreeItem(clean(name), hasKids ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.id = node.id;
    item.resourceUri = changeUri(e.path, e.status);
    item.iconPath = vscode.ThemeIcon.File;
    item.description = this.describe(e);
    item.tooltip = this.tooltip(e);
    const cov = this.render?.layer?.files.get(e.path)?.coverage;
    const covered = cov ? `, ${fileMarkLabel(cov)}` : '';
    item.accessibilityInformation = { label: `${clean(name)}, ${STATUS_NAMES[e.status]}${e.untracked ? ', untracked' : ''}, ${this.describe(e, false)}${covered}` };
    item.command = { command: 'sidestory.changes.open', title: 'Open Diff', arguments: [{ path: e.path }] };
    const onDisk = this.render?.onDisk && e.status !== 'D';
    const open = cov ? cov.left > 0 : false;
    const explained = cov ? cov.changes.some((c) => c.by.length > 0 && c.state !== 'trivial') : false;
    item.contextValue = `file:${e.status}${e.status === 'D' ? ':deleted' : ''}${onDisk ? ':onDisk' : ''}${open ? ':unexplained' : ''}${explained ? ':explained' : ''}`;
    return item;
  }

  /** File paths below a folder node. */
  private filesUnder(n: ChangesNode): string[] {
    const out: string[] = [];
    for (const c of this.children.get(n) ?? []) {
      if (c.kind === 'file') out.push(c.entry.path);
      else if (c.kind === 'folder') out.push(...this.filesUnder(c));
    }
    return out;
  }

  private describe(e: ChangeEntry, withMark = true): string {
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
    const cov = withMark ? this.render?.layer?.files.get(e.path)?.coverage : undefined;
    const mark = cov && fileMark(cov);
    if (mark) parts.push(mark);
    return parts.join(' · ');
  }

  private tooltip(e: ChangeEntry): string {
    const lines = [`${clean(e.path)}`, e.oldPath ? `${STATUS_NAMES[e.status]} from ${clean(e.oldPath)}` : STATUS_NAMES[e.status]];
    if (e.untracked) lines[1] += ' (untracked)';
    const counts = countsLabel(e);
    if (counts) lines.push(counts === 'no line changes' ? 'No line changes: binary, a mode change or an empty file' : `${counts} lines`);
    if (e.unsaved) lines.push('Has unsaved edits: counts are of the file on disk');
    const layer = this.render?.layer?.files.get(e.path);
    if (layer?.coverage) {
      const by = new Map<string, string>();
      for (const c of layer.coverage.changes) if (c.state !== 'trivial') for (const x of c.by) by.set(`${x.sidestory}\0${x.anchor}`, this.render!.layer!.stepName(x.sidestory, x.anchor));
      lines.push(fileMarkLabel(layer.coverage));
      if (by.size) lines.push(`Explained by ${[...by.values()].slice(0, 5).map(clean).join(', ')}${by.size > 5 ? ` and ${by.size - 5} more` : ''}`);
      lines.push(...hunkLines(layer.coverage, layer.blocks));
    }

    if (clean(e.path) !== e.path || (e.oldPath && clean(e.oldPath) !== e.oldPath)) lines.push(`⚠ The path has unusual characters: ${JSON.stringify(e.path)}`);
    return lines.join('\n');
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

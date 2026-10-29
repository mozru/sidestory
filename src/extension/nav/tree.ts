// The Sidestory sidebar (docs/NAVIGATION-PLAN.md §8): packages, groups, tops and the details reachable from
// them, rendered lazily child by child (shared details appear under every parent; the tree never enumerates
// paths). A filter shows each match once, under its primary path. Labels are repository text: cleaned when
// indexed, never escaped here (tree items render no icon syntax), and tooltips are plain strings.
//
// On a branch, a "This branch" group comes first (docs/CHANGES-PLAN.md §9.6): the sidestories that explain the
// branch with their coverage, and the copied prompts (update one, or explain the branch when none does).
import * as vscode from 'vscode';
import { displayText } from '../../core/display-text.ts';
import { MAX_TRAIL } from '../../shared/protocol.ts';
import type { BranchRow } from '../changes/coverage-labels.ts';
import type { ExplainerSession } from '../session.ts';
import type { Drift, DriftQueue } from './drift.ts';
import type { IndexEntry, IndexPackage, SidestoryIndex } from './index.ts';

export const TREE_LIMITS = { filteredNodes: 2000, expandPackages: 3 } as const;
export const FILTER_KEY = 'sidestory.treeFilter';

export type TreeNode =
  | { kind: 'package'; id: string; pkg: IndexPackage; parent?: undefined }
  | { kind: 'group'; id: string; pkg: IndexPackage; key: string; label: string; members: string[]; parent?: TreeNode }
  | { kind: 'sidestory'; id: string; entry: IndexEntry; path: string[]; startHere: boolean; parent?: TreeNode }
  | { kind: 'leaf'; id: string; entry: IndexEntry; path: string[]; reason: 'back' | 'deep'; parent?: TreeNode }
  | { kind: 'branch'; id: string; description: string | undefined; rows: BranchRow[]; nested: Map<string, BranchRow[]>; parent?: undefined }
  | { kind: 'branchRow'; id: string; row: BranchRow; nested: Map<string, BranchRow[]>; parent: TreeNode };

/** What the "This branch" group shows (the changes service). */
export interface BranchSource {
  branchGroup(): { description: string | undefined; rows: BranchRow[] };
}

/** Ids encode each part, so package paths and group names containing `/` stay unique; never parsed back. */
const idOf = (...parts: string[]) => parts.map(encodeURIComponent).join('/');


export class SidestoryTree implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly index: SidestoryIndex;
  private readonly drift: DriftQueue;
  private readonly memento: vscode.Memento;
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;
  /** Node id → node, filled as nodes are created and cleared on refresh (for `getParent` and `reveal`). */
  private readonly nodes = new Map<string, TreeNode>();
  /** Nodes per sidestory key, for repainting one sidestory's nodes when its drift arrives. */
  private readonly byEntry = new Map<string, TreeNode[]>();
  private filterText: string;
  private filtered: { matches: Set<string>; needed: Set<string>; shown: number; total: number } | undefined;
  view: vscode.TreeView<TreeNode> | undefined;
  /** The "This branch" group's rows; none on a branch without changes or outside git. */
  branch: BranchSource | undefined;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(index: SidestoryIndex, drift: DriftQueue, memento: vscode.Memento) {
    this.index = index;
    this.drift = drift;
    this.memento = memento;
    this.filterText = memento.get<string>(FILTER_KEY, '') ?? '';
    this.subscriptions.push(
      this.emitter,
      index.onDidChange(() => this.refresh()),
      drift.onDidChange((key) => {
        for (const n of this.byEntry.get(key) ?? []) this.emitter.fire(n);
      }),
    );
  }

  get filter(): string {
    return this.filterText;
  }

  /** Sets (or clears, with '') the filter, remembered per workspace. */
  setFilter(text: string): void {
    this.filterText = text.trim().slice(0, 200);
    void this.memento.update(FILTER_KEY, this.filterText);
    void vscode.commands.executeCommand('setContext', 'sidestory.treeFiltered', !!this.filterText);
    this.refresh();
  }

  refresh(): void {
    this.nodes.clear();
    this.byEntry.clear();
    this.filtered = this.filterText ? this.computeFilter(this.filterText) : undefined;
    this.updateMessage();
    this.emitter.fire();
  }

  private updateMessage(): void {
    if (!this.view) return;
    const cut = this.index.discoveryCut;
    const parts: string[] = [];
    if (this.filtered) {
      const f = this.filtered;
      parts.push(
        f.total > f.shown
          ? `Showing ${f.shown.toLocaleString('en-US')} of ${f.total.toLocaleString('en-US')} matches; refine the filter.`
          : `Filtered by "${displayText(this.filterText, 60)}": ${f.total} sidestor${f.total === 1 ? 'y' : 'ies'}`,
      );
    }
    if (cut) parts.push(`Showing the first ${this.index.size.toLocaleString('en-US')} sidestories${cut.atLeast ? ` (at least ${cut.found.toLocaleString('en-US')} found)` : ''}.`);
    if (this.index.capped) parts.push('Some sidestories are only partly indexed (too many anchors, steps or links).');
    this.view.message = parts.join(' ') || undefined;
  }

  // ---- the filter ----

  /** Matches on title, name, summary and group, over the index's flat list; each shown once, under its primary path. */
  private computeFilter(text: string) {
    const q = text.toLowerCase();
    const matches = new Set<string>();
    const needed = new Set<string>();
    let total = 0;
    let shown = 0;
    for (const e of this.index.all()) {
      const hay = `${e.title}\n${e.ref.name}\n${e.summary}\n${e.group ?? ''}`.toLowerCase();
      if (!hay.includes(q)) continue;
      total++;
      // Top-anchored and cut at the depth the tree shows (a leaf "nested too deep" at MAX_TRAIL + 1): a deeper
      // match is shown by the path down to there.
      const path = this.index.primaryPath(e, MAX_TRAIL + 1);
      if (shown + path.length > TREE_LIMITS.filteredNodes) continue;
      shown += path.length;
      matches.add(e.key);
      // Every sidestory on the primary path is needed, by path prefix.
      for (let i = 1; i <= path.length; i++) needed.add(`${e.pkg}\u0000${path.slice(0, i).join('/')}`);
    }
    return { matches, needed, shown: matches.size, total };
  }

  // ---- structure ----

  getChildren(node?: TreeNode): TreeNode[] {
    if (!node) {
      const pkgs = this.index.packages().filter((p) => !this.filtered || [...p.entries.keys()].some((k) => this.filtered!.matches.has(k)));
      const branch = this.branchNode();
      const top = branch ? [branch] : [];
      if (this.index.packageCount > 1) return [...top, ...pkgs.map((p) => this.make({ kind: 'package', id: this.id('p', p.key), pkg: p }))];
      const only = pkgs[0];
      return [...top, ...(only ? this.packageChildren(only, undefined) : [])];
    }
    switch (node.kind) {
      case 'branch':
      case 'branchRow':
        return (node.kind === 'branch' ? node.rows : (node.nested.get(node.row.id) ?? [])).map((row) =>
          this.make({ kind: 'branchRow', id: `branch/${encodeURIComponent(row.id)}`, row, nested: node.nested, parent: node }),
        );
      case 'package':
        return this.packageChildren(node.pkg, node);
      case 'group':
        return this.sortedTops(node.pkg, node.members.filter((n) => node.pkg.graph.isTop(n) && n !== this.startHere(node.pkg)))
          .filter((e) => this.wanted(e, [e.ref.name]))
          .map((e) => this.sidestoryNode(e, [e.ref.name], node, false));
      case 'sidestory':
        return this.detailChildren(node);
      case 'leaf':
        return [];
    }
  }

  /** The "This branch" group, when it has rows. Not filtered: it is about the branch, not a match. */
  private branchNode(): TreeNode | undefined {
    const g = this.branch?.branchGroup();
    if (!g?.rows.length) return undefined;
    // Not through `make`: its rows change with coverage, and a cached node would keep the old ones.
    const { rows, nested } = this.nestBranchRows(g.rows);
    const node: TreeNode = { kind: 'branch', id: 'branch', description: g.description, rows, nested };
    this.nodes.set(node.id, node);
    return node;
  }

  /**
   * The branch's sidestories as the hierarchy they form: each under the nearest sidestory on its trail (the near
   * end of its primary path) that also explains the branch (an overview with its details), the rest at the top.
   * Other rows stay where they are.
   */
  private nestBranchRows(all: BranchRow[]): { rows: BranchRow[]; nested: Map<string, BranchRow[]> } {
    const entryOf = (r: BranchRow) => {
      const dir = r.contextValue === 'branchSidestory' ? (r.command.arguments?.[0] as { dir?: unknown } | undefined)?.dir : undefined;
      return typeof dir === 'string' ? this.index.entry(vscode.Uri.parse(dir)) : undefined;
    };
    const byKey = new Map<string, BranchRow>();
    for (const r of all) {
      const e = entryOf(r);
      if (e) byKey.set(e.key, r);
    }
    const nested = new Map<string, BranchRow[]>();
    const rows: BranchRow[] = [];
    for (const r of all) {
      const e = entryOf(r);
      let parent: BranchRow | undefined;
      if (e) {
        const path = this.index.trail(e);
        for (let i = path.length - 1; i >= 0 && !parent; i--) {
          const up = this.index.sibling(e, path[i]!);
          if (up && up.key !== e.key) parent = byKey.get(up.key);
        }
      }
      if (!parent) rows.push(r);
      else if (nested.has(parent.id)) nested.get(parent.id)!.push(r);
      else nested.set(parent.id, [r]);
    }
    return { rows, nested };
  }

  private startHere(pkg: IndexPackage): string | undefined {
    return pkg.graph.startHere;
  }

  private packageChildren(pkg: IndexPackage, parent: TreeNode | undefined): TreeNode[] {
    const out: TreeNode[] = [];
    const start = this.startHere(pkg);
    const startEntry = start ? this.entryByName(pkg, start) : undefined;
    if (startEntry && this.wanted(startEntry, [start!])) out.push(this.sidestoryNode(startEntry, [start!], parent, true));
    const tops = pkg.graph.tops.filter((n) => n !== start);
    const grouped = new Set<string>();
    // The group level only when some top in the package has a group.
    if (pkg.groups.length && tops.some((t) => this.entryByName(pkg, t)?.group)) {
      for (const g of pkg.groups) {
        const members = g.members.filter((m) => pkg.graph.isTop(m) && m !== start);
        for (const m of members) grouped.add(m);
        if (!members.length) continue;
        if (this.filtered && !members.some((m) => this.wanted(this.entryByName(pkg, m), [m]))) continue;
        out.push(this.make({ kind: 'group', id: this.id('g', pkg.key, g.key), pkg, key: g.key, label: g.label, members, parent }));
      }
    }
    for (const e of this.sortedTops(pkg, tops.filter((t) => !grouped.has(t)))) {
      if (this.wanted(e, [e.ref.name])) out.push(this.sidestoryNode(e, [e.ref.name], parent, false));
    }
    return out;
  }

  private sortedTops(pkg: IndexPackage, names: string[]): IndexEntry[] {
    const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    return names
      .map((n) => this.entryByName(pkg, n))
      .filter((e): e is IndexEntry => !!e)
      .sort((a, b) => coll.compare(this.index.name(a), this.index.name(b)) || a.ref.name.localeCompare(b.ref.name));
  }

  /** Details in the parent's HTML order (the author's reading order); cycles and depth stop as leaves. */
  private detailChildren(node: Extract<TreeNode, { kind: 'sidestory' }>): TreeNode[] {
    const pkg = this.index.packageOf(node.entry);
    if (!pkg) return [];
    const out: TreeNode[] = [];
    for (const child of pkg.graph.children(node.entry.ref.name)) {
      const e = this.entryByName(pkg, child);
      if (!e) continue;
      const path = [...node.path, child];
      if (!this.wanted(e, path)) continue;
      if (node.path.includes(child)) out.push(this.make({ kind: 'leaf', id: this.id('l', pkg.key, ...path), entry: e, path, reason: 'back', parent: node }));
      else if (path.length > MAX_TRAIL) out.push(this.make({ kind: 'leaf', id: this.id('l', pkg.key, ...path), entry: e, path, reason: 'deep', parent: node }));
      else out.push(this.sidestoryNode(e, path, node, false));
    }
    return out;
  }

  /** In filter mode, only nodes on a match's primary path. */
  private wanted(e: IndexEntry | undefined, path: string[]): boolean {
    if (!e) return false;
    if (!this.filtered) return true;
    return this.filtered.needed.has(`${e.pkg}\u0000${path.join('/')}`);
  }

  private entryByName(pkg: IndexPackage, name: string): IndexEntry | undefined {
    return pkg.byName.get(name);
  }

  private sidestoryNode(entry: IndexEntry, path: string[], parent: TreeNode | undefined, startHere: boolean): TreeNode {
    return this.make({ kind: 'sidestory', id: this.id(startHere ? 's*' : 's', entry.pkg, ...path), entry, path, startHere, parent });
  }

  private make<T extends TreeNode>(n: T): T {
    const existing = this.nodes.get(n.id);
    if (existing) return existing as T;
    this.nodes.set(n.id, n);
    if (n.kind === 'sidestory' || n.kind === 'leaf') {
      const list = this.byEntry.get(n.entry.key);
      if (list) list.push(n);
      else this.byEntry.set(n.entry.key, [n]);
    }
    return n;
  }

  /**
   * Node ids. While filtered they get their own namespace, so VS Code applies the filtered tree's expansion (each
   * match's path open) instead of the expansion it remembers for the same ids unfiltered.
   */
  private id(...parts: string[]): string {
    return this.filtered ? idOf('f', this.filterText, ...parts) : idOf(...parts);
  }

  getParent(node: TreeNode): TreeNode | undefined {
    return node.parent;
  }

  // ---- items ----

  getTreeItem(node: TreeNode): vscode.TreeItem {
    switch (node.kind) {
      case 'package': {
        const item = new vscode.TreeItem(node.pkg.label, this.index.packageCount <= TREE_LIMITS.expandPackages ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
        item.id = node.id;
        // Filtered: its matches, as a group counts the members it shows.
        let count = node.pkg.entries.size;
        if (this.filtered) {
          count = 0;
          for (const k of node.pkg.entries.keys()) if (this.filtered.matches.has(k)) count++;
        }
        item.description = `${count} sidestor${count === 1 ? 'y' : 'ies'}`;
        item.iconPath = new vscode.ThemeIcon('folder-library');
        item.tooltip = `${node.pkg.label}\n${displayText(vscode.workspace.asRelativePath(node.pkg.folder, true), 300)}`;
        item.contextValue = 'package';
        return item;
      }
      case 'group': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
        item.id = node.id;
        // Filtered: the members it shows, not all of them.
        const count = this.filtered ? node.members.filter((m) => this.wanted(this.entryByName(node.pkg, m), [m])).length : node.members.length;
        item.description = `${count} sidestor${count === 1 ? 'y' : 'ies'}`;
        item.iconPath = new vscode.ThemeIcon('symbol-namespace');
        item.contextValue = 'group';
        return item;
      }
      case 'leaf': {
        const target = this.index.name(node.entry);
        const item = new vscode.TreeItem(node.reason === 'back' ? `↩ back to ${target}` : target, vscode.TreeItemCollapsibleState.None);
        item.id = node.id;
        item.description = node.reason === 'deep' ? 'nested too deep' : undefined;
        item.iconPath = new vscode.ThemeIcon(node.reason === 'back' ? 'debug-step-back' : 'ellipsis');
        item.contextValue = 'cycle';
        // Opening a back-link cuts the trail back to it, as diving back up does; one nested too deep opens on its
        // primary path.
        const trail = node.reason === 'back' ? node.path.slice(0, node.path.indexOf(node.entry.ref.name) + 1) : this.index.trail(node.entry);
        item.command = { title: 'Open', command: 'sidestory.openAt', arguments: [{ dir: node.entry.ref.dir.toString(), trail, source: 'tree' }] };
        item.tooltip = `${this.index.pathLabel(node.entry)}\n.sidestory/${displayText(node.entry.ref.name, 64)}`;
        return item;
      }
      case 'sidestory':
        return this.sidestoryItem(node);
      case 'branch': {
        const item = new vscode.TreeItem('This branch', vscode.TreeItemCollapsibleState.Expanded);
        item.id = node.id;
        item.description = node.description;
        item.iconPath = new vscode.ThemeIcon('git-branch');
        item.tooltip = 'The sidestories that explain this branch’s changes against its base, and what is left';
        item.contextValue = 'branch';
        return item;
      }
      case 'branchRow': {
        const r = node.row;
        const item = new vscode.TreeItem(r.label, node.nested.has(r.id) ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
        item.id = node.id;
        item.description = r.description;
        item.tooltip = r.tooltip;
        item.iconPath = new vscode.ThemeIcon(r.icon);
        item.command = r.command;
        item.contextValue = r.contextValue;
        return item;
      }
    }
  }

  private sidestoryItem(node: Extract<TreeNode, { kind: 'sidestory' }>): vscode.TreeItem {
    const e = node.entry;
    const pkg = this.index.packageOf(e);
    const name = this.index.name(e);
    const label: vscode.TreeItemLabel = { label: name };
    if (this.filtered?.matches.has(e.key) && node.path.at(-1) === e.ref.name) {
      const at = name.toLowerCase().indexOf(this.filterText.toLowerCase());
      if (at >= 0) label.highlights = [[at, at + this.filterText.length]];
    }
    const hasChildren = !!pkg && pkg.graph.children(e.ref.name).length > 0;
    const expand = this.filtered && hasChildren && this.filtered.needed.has(`${e.pkg}\u0000${[...node.path].join('/')}`) && this.hasWantedChild(node) ? vscode.TreeItemCollapsibleState.Expanded : hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(label, expand);
    item.id = node.id;
    const isTop = !!pkg?.graph.isTop(e.ref.name);
    const parents = pkg?.graph.parents(e.ref.name) ?? [];
    const drift = this.drift.get(e);
    const parts: string[] = [];
    if (node.startHere) parts.push('Start here');
    if (e.outlined) parts.push(`${e.steps.length} step${e.steps.length === 1 ? '' : 's'}`);
    else if (e.state === 'not-read' || e.state === 'not-outlined') parts.push(e.state === 'not-read' ? 'not read (budget)' : 'not outlined (budget)');
    if (drift) parts.push(...driftWords(drift));
    // A sidestory listed at the top level (a group, or top: true) that is also a detail says so in both places,
    // naming the *other* place, so it doesn't look like a duplicate.
    if ((e.group || e.top) && parents.length) {
      if (node.path.length === 1) parts.push(`also under ${this.nameOf(pkg, parents[0]!)}${parents.length > 1 ? ` and ${parents.length - 1} more` : ''}`);
      else {
        // The group as the view shows it (merged spelling); Start here is listed at the top level, not in its group.
        const label = pkg?.groups.find((g) => g.members.includes(e.ref.name))?.label;
        parts.push(e.group && label && pkg?.graph.startHere !== e.ref.name ? `also in ${label}` : 'also at the top level');
      }
    }
    if (e.truncated) parts.push('page too complex to outline');
    item.description = parts.join(' · ');
    const broken = pkg?.graph.brokenLinks(e.ref.name) ?? [];
    item.tooltip = [
      name,
      e.summary,
      `.sidestory/${displayText(e.ref.name, 64)}`,
      parents.length ? `Also under: ${parents.slice(0, 5).map((p) => this.nameOf(pkg, p)).join(', ')}${parents.length > 5 ? ` and ${parents.length - 5} more` : ''}` : '',
      broken.length ? `Broken detail links: ${broken.slice(0, 10).map((b) => displayText(b, 64)).join(', ')}` : '',
      ...e.errors,
    ]
      .filter(Boolean)
      .join('\n');
    const warn = drift && (drift.lost || drift.outOfDate);
    item.iconPath = node.startHere
      ? new vscode.ThemeIcon('home')
      : warn
        ? new vscode.ThemeIcon('warning', new vscode.ThemeColor(drift.lost ? 'sidestory.lostForeground' : 'sidestory.staleForeground'))
        : new vscode.ThemeIcon(isTop && node.path.length === 1 ? 'book' : 'file-text');
    item.contextValue = e.errors.length && !e.ids.length ? 'broken' : isTop && node.path.length === 1 ? 'top' : 'detail';
    item.command = { title: 'Open', command: 'sidestory.openAt', arguments: [{ dir: e.ref.dir.toString(), trail: node.path, source: 'tree' }] };
    item.resourceUri = undefined;
    return item;
  }

  private hasWantedChild(node: Extract<TreeNode, { kind: 'sidestory' }>): boolean {
    if (!this.filtered) return false;
    const pkg = this.index.packageOf(node.entry);
    return !!pkg?.graph.children(node.entry.ref.name).some((c) => this.filtered!.needed.has(`${node.entry.pkg}\u0000${[...node.path, c].join('/')}`));
  }

  private nameOf(pkg: IndexPackage | undefined, n: string): string {
    const e = pkg && this.entryByName(pkg, n);
    return e ? this.index.name(e) : displayText(n, 64);
  }

  // ---- following the panel ----

  /** The node for a session's sidestory: its trail when that is a real path from a top, else the primary path. */
  nodeFor(s: ExplainerSession): TreeNode | undefined {
    const e = this.index.entry(s.ref.dir);
    const pkg = e && this.index.packageOf(e);
    if (!e || !pkg) return undefined;
    const names = s.trailRefs.map((r) => r.name);
    const valid = pkg.graph.isTop(names[0]!) && names.every((n, i) => i === 0 || pkg.graph.children(names[i - 1]!).includes(n)) && new Set(names).size === names.length;
    // Start here is listed on its own at the top level, even when it is someone's detail: reveal it there.
    const path = valid ? names : pkg.graph.startHere === e.ref.name ? [e.ref.name] : this.index.primaryPath(e, MAX_TRAIL + 1);
    return this.pathNode(pkg, path);
  }

  /** Builds (or finds) the nodes along a path, with parents, so `reveal` can walk them. */
  private pathNode(pkg: IndexPackage, path: string[]): TreeNode | undefined {
    const multi = this.index.packageCount > 1;
    let parent: TreeNode | undefined = multi ? this.make({ kind: 'package', id: this.id('p', pkg.key), pkg }) : undefined;
    const topName = path[0]!;
    const top = this.entryByName(pkg, topName);
    if (!top) return undefined;
    const start = this.startHere(pkg);
    if (topName !== start && top.group && pkg.groups.length) {
      const g = pkg.groups.find((x) => x.members.includes(topName));
      if (g) parent = this.make({ kind: 'group', id: this.id('g', pkg.key, g.key), pkg, key: g.key, label: g.label, members: g.members.filter((m) => pkg.graph.isTop(m) && m !== start), parent });
    }
    let node: TreeNode = this.sidestoryNode(top, [topName], parent, topName === start);
    for (let i = 1; i < path.length; i++) {
      const e = this.entryByName(pkg, path[i]!);
      if (!e) return node;
      const at = path.slice(0, i + 1);
      // Past the depth cap the tree lists a leaf, as detailChildren does.
      if (at.length > MAX_TRAIL) return this.make({ kind: 'leaf', id: this.id('l', pkg.key, ...at), entry: e, path: at, reason: 'deep', parent: node });
      node = this.sidestoryNode(e, at, node, false);
    }
    return node;
  }

  /** Reveals a panel's sidestory when the view is visible (`sidestory.sidebar.followPanel`). */
  follow(s: ExplainerSession): void {
    if (!this.view?.visible || this.filtered) return;
    if (!vscode.workspace.getConfiguration('sidestory').get<boolean>('sidebar.followPanel', true)) return;
    const node = this.nodeFor(s);
    if (node) void Promise.resolve(this.view.reveal(node, { select: true, focus: false, expand: false })).catch(() => {});
  }

  dispose(): void {
    for (const d of this.subscriptions) d.dispose();
    this.nodes.clear();
    this.byEntry.clear();
  }
}

export function driftWords(d: Drift): string[] {
  const out: string[] = [];
  if (d.outOfDate) out.push(`${d.outOfDate} out of date`);
  if (d.lost) out.push(`${d.lost} lost`);
  return out;
}

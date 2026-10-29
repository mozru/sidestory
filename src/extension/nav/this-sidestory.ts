// The This Sidestory view: where the panel is inside a hierarchy of sidestories. The way up (each sidestory on the
// panel's trail, a click goes back there), the sidestory it shows with its step, the details below it (a click
// dives in) and, beside it, the other details of its parent. It follows the active panel; the Sidestories view
// above stays the place to pick a sidestory. Labels are repository text, cleaned when indexed (as in tree.ts).
import * as vscode from 'vscode';
import { MAX_TRAIL } from '../../shared/protocol.ts';
import type { ExplainerSession } from '../session.ts';
import type { IndexEntry, IndexPackage, SidestoryIndex } from './index.ts';

export const THIS_SIDESTORY_VIEW = 'sidestory.thisSidestory';
/** Details listed under one sidestory, at most (a page can link to many). */
export const THIS_SIDESTORY_CAP = 200;

export type HereNode =
  | { kind: 'up'; id: string; entry: IndexEntry; trail: string[] }
  | { kind: 'here'; id: string; entry: IndexEntry; trail: string[]; step: { n: number; count: number; title: string } | undefined }
  | { kind: 'detail'; id: string; entry: IndexEntry; trail: string[] }
  | { kind: 'siblings'; id: string; parent: IndexEntry; trail: string[]; names: string[] };

export class ThisSidestoryView implements vscode.TreeDataProvider<HereNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<HereNode | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private sig = '';
  private readonly index: SidestoryIndex;
  /** The panel to follow: the active one, else the last one used. */
  private readonly session: () => ExplainerSession | undefined;

  constructor(index: SidestoryIndex, session: () => ExplainerSession | undefined) {
    this.index = index;
    this.session = session;
  }

  /** Repaints when what the view shows changed (the panel's place, or the index under it). */
  refresh(force = false): void {
    const p = this.place();
    const sig = p ? JSON.stringify([p.entry.key, p.trail, p.active ?? null]) : '';
    if (!force && sig === this.sig) return;
    this.sig = sig;
    this.emitter.fire();
  }

  /** The panel's sidestory, its trail (a real path from a top, else the primary path) and its step. */
  private place(): { entry: IndexEntry; pkg: IndexPackage; trail: string[]; active: string | undefined } | undefined {
    const s = this.session();
    if (!s) return undefined;
    const entry = this.index.entry(s.ref.dir);
    const pkg = entry && this.index.packageOf(entry);
    if (!entry || !pkg) return undefined;
    const names = s.trailRefs.map((r) => r.name);
    const valid = names.every((n, i) => pkg.graph.has(n) && (i === 0 || pkg.graph.children(names[i - 1]!).includes(n))) && new Set(names).size === names.length;
    return { entry, pkg, trail: valid ? names : this.index.trail(entry), active: s.place().active };
  }

  getChildren(node?: HereNode): HereNode[] {
    const p = this.place();
    if (!p) return [];
    if (!node) {
      const out: HereNode[] = [];
      p.trail.slice(0, -1).forEach((name, i) => {
        const e = p.pkg.byName.get(name);
        const trail = p.trail.slice(0, i + 1);
        if (e) out.push({ kind: 'up', id: `up/${trail.join('/')}`, entry: e, trail });
      });
      const at = p.active ? this.index.stepOf(p.entry.ref.dir, p.active) : undefined;
      const count = this.index.stepCount(p.entry.ref.dir);
      out.push({ kind: 'here', id: `here/${p.trail.join('/')}`, entry: p.entry, trail: p.trail, step: at && count ? { n: at.n, count, title: at.title } : undefined });
      const parent = p.trail.length > 1 ? p.pkg.byName.get(p.trail.at(-2)!) : undefined;
      const others = parent ? p.pkg.graph.children(parent.ref.name).filter((n) => !p.trail.includes(n) && p.pkg.byName.has(n)) : [];
      if (parent && others.length) out.push({ kind: 'siblings', id: `siblings/${p.trail.join('/')}`, parent, trail: p.trail.slice(0, -1), names: others.slice(0, THIS_SIDESTORY_CAP) });
      return out;
    }
    switch (node.kind) {
      case 'up':
        return [];
      case 'here':
      case 'detail':
        return this.details(p.pkg, node.entry, node.trail);
      case 'siblings':
        return node.names.flatMap((n) => {
          const e = p.pkg.byName.get(n);
          const trail = [...node.trail, n];
          return e ? [{ kind: 'detail' as const, id: `sib/${trail.join('/')}`, entry: e, trail }] : [];
        });
    }
  }

  private details(pkg: IndexPackage, e: IndexEntry, trail: string[]): HereNode[] {
    if (trail.length >= MAX_TRAIL) return [];
    return pkg.graph
      .children(e.ref.name)
      .filter((n) => !trail.includes(n)) // no going round a cycle
      .slice(0, THIS_SIDESTORY_CAP)
      .flatMap((n) => {
        const c = pkg.byName.get(n);
        const t = [...trail, n];
        return c ? [{ kind: 'detail' as const, id: `d/${t.join('/')}`, entry: c, trail: t }] : [];
      });
  }

  getTreeItem(node: HereNode): vscode.TreeItem {
    if (node.kind === 'siblings') {
      const item = new vscode.TreeItem(`Also in ${this.index.name(node.parent)}`, vscode.TreeItemCollapsibleState.Expanded);
      item.id = node.id;
      item.iconPath = new vscode.ThemeIcon('list-tree');
      item.tooltip = `The other details of ${this.index.name(node.parent)}`;
      item.contextValue = 'thisSidestorySiblings';
      return item;
    }
    const e = node.entry;
    const name = this.index.name(e);
    const pkg = this.index.packageOf(e);
    const hasDetails = node.kind !== 'up' && !!pkg && node.trail.length < MAX_TRAIL && pkg.graph.children(e.ref.name).some((n) => !node.trail.includes(n));
    const state = node.kind === 'here' ? (hasDetails ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None) : hasDetails ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(name, state);
    item.id = node.id;
    const steps = e.outlined ? `${e.steps.length} step${e.steps.length === 1 ? '' : 's'}` : '';
    switch (node.kind) {
      case 'up':
        item.iconPath = new vscode.ThemeIcon('arrow-up');
        item.description = 'up';
        item.tooltip = `${name}\n${e.summary ? `${e.summary}\n` : ''}Go back up to it`;
        break;
      case 'here':
        item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.blue'));
        item.description = node.step ? `step ${node.step.n} of ${node.step.count} · ${node.step.title}` : steps;
        item.tooltip = `${name}\n${e.summary ? `${e.summary}\n` : ''}You are here`;
        break;
      case 'detail':
        item.iconPath = new vscode.ThemeIcon('book');
        item.description = [steps, e.summary].filter(Boolean).join(' · ');
        item.tooltip = `${name}\n${e.summary ? `${e.summary}\n` : ''}Click to open`;
        break;
    }
    item.contextValue = `thisSidestory.${node.kind}`;
    if (node.kind !== 'here') item.command = { title: 'Open', command: 'sidestory.openAt', arguments: [{ dir: e.ref.dir.toString(), trail: node.trail, source: 'tree' }] };
    return item;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

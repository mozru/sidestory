// The This File view (docs/CHANGES-PLAN.md §9.10): every step, in any sidestory (with or without a base), that covers
// the active editor's file. From the workspace index's per-file table (no new index state), folded into steps (nested
// anchors under their step), grouped by sidestory, sorted by line; positions from Explained here's resolved results
// for visible documents, else the manifest's range with "≈"; lost ones last. The step at the cursor is marked `●`
// through the shared cursor helper and selected only while the view is visible. Works in Restricted Mode: it only reads.
import * as vscode from 'vscode';
import { displayText } from '../core/display-text.ts';
import type { LineRange } from '../core/manifest.ts';
import type { AnchorState } from '../core/resolve.ts';
import { uriKey } from './explainers.ts';
import type { ExplainedHere } from './nav/explained-here.ts';
import type { IndexEntry, SidestoryIndex } from './nav/index.ts';
import { explainFilePrompt, COPIED } from './changes/prompts.ts';

export const THIS_FILE_VIEW = 'sidestory.thisFile';
export const THIS_FILE_CAP = 500;

/** One anchor covering the file, as This File folds it. */
export interface StepInput {
  group: string;
  stepIndex: number;
  stepId: string;
  title: string;
  /** The anchor itself (the step's own, or one nested in it). */
  anchor: string;
  range: LineRange | null;
  state: AnchorState | 'pending';
  /** The manifest's range, not yet resolved against the file. */
  approx: boolean;
}

export interface StepRow {
  group: string;
  stepIndex: number;
  stepId: string;
  title: string;
  range: LineRange | null;
  approx: boolean;
  lost: boolean;
  anchors: string[];
}

/**
 * Folds anchors into steps (§9.10): one row per (sidestory, step); its range is the step's own anchor's when it is
 * in this file, else the span of its nested anchors here. Rows by line, lost last; at most `cap` rows in all.
 */
export function foldSteps(inputs: readonly StepInput[], cap = THIS_FILE_CAP): { groups: Map<string, StepRow[]>; total: number; shown: number } {
  const rows = new Map<string, StepRow & { own: boolean }>();
  for (const x of inputs) {
    const key = `${x.group}\0${x.stepId}`;
    const lost = x.state === 'lost' || !x.range;
    const own = x.anchor === x.stepId;
    let row = rows.get(key);
    if (!row) {
      row = { group: x.group, stepIndex: x.stepIndex, stepId: x.stepId, title: x.title, range: lost ? null : x.range, approx: x.approx, lost, anchors: [x.anchor], own };
      rows.set(key, row);
      continue;
    }
    row.anchors.push(x.anchor);
    if (lost) continue;
    if (own || row.lost) {
      Object.assign(row, { range: x.range, approx: x.approx, lost: false, own: own || row.own });
    } else if (!row.own && row.range && x.range) {
      row.range = { start: Math.min(row.range.start, x.range.start), end: Math.max(row.range.end, x.range.end) };
      row.approx ||= x.approx;
    }
  }
  const sorted = [...rows.values()].sort((a, b) => Number(a.lost) - Number(b.lost) || (a.range?.start ?? 0) - (b.range?.start ?? 0) || a.stepIndex - b.stepIndex);
  const shown = sorted.slice(0, cap);
  const groups = new Map<string, StepRow[]>();
  for (const { own: _own, ...r } of shown) {
    const list = groups.get(r.group);
    if (list) list.push(r);
    else groups.set(r.group, [r]);
  }
  return { groups, total: sorted.length, shown: shown.length };
}

type Node =
  | { kind: 'group'; id: string; entry: IndexEntry; label: string; description?: string; children: Node[] }
  | { kind: 'step'; id: string; entry: IndexEntry; row: StepRow; parent: Node }
  | { kind: 'more'; id: string; count: number };

export interface ThisFileHost {
  /** A diff side's repository path → its working tree file (§9.10: a diff and the plain editor list the same steps). */
  fileOf(uri: vscode.Uri): vscode.Uri | undefined;
  /** "vs main" for a sidestory with a base, when known. */
  baseOf(dir: vscode.Uri): string | undefined;
}

export class ThisFileView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;
  readonly view: vscode.TreeView<Node>;
  private readonly subs: vscode.Disposable[] = [];
  private file: vscode.Uri | undefined;
  private top: Node[] = [];
  private byStep = new Map<string, Node>();
  private marked: string | undefined;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  private readonly index: SidestoryIndex;
  private readonly here: ExplainedHere;
  private readonly host: ThisFileHost;

  constructor(index: SidestoryIndex, here: ExplainedHere, host: ThisFileHost) {
    this.index = index;
    this.here = here;
    this.host = host;
    this.view = vscode.window.createTreeView(THIS_FILE_VIEW, { treeDataProvider: this });
    this.subs.push(
      this.emitter,
      this.view,
      vscode.window.onDidChangeActiveTextEditor(() => this.later('file', () => this.follow())),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor === vscode.window.activeTextEditor) this.later('cursor', () => this.markCursor());
      }),
      index.onDidChange(() => this.later('rebuild', () => this.rebuild())),
      here.onDidChangeCodeLenses(() => this.later('rebuild', () => this.rebuild())),
      this.view.onDidChangeVisibility(() => {
        if (this.view.visible) this.rebuild();
      }),
    );
    this.follow();
  }

  private later(key: string, fn: () => void, ms = 100): void {
    clearTimeout(this.timers.get(key));
    this.timers.set(key, setTimeout(fn, ms));
  }

  /** The active editor's file; non-file editors (output, notebooks, an empty side) keep the last one. */
  private follow(): void {
    const ed = vscode.window.activeTextEditor;
    if (ed) {
      const uri = ed.document.uri;
      const f = uri.scheme === 'file' ? uri : this.host.fileOf(uri);
      if (f) this.file = f;
    }
    this.rebuild();
  }

  /** Rebuilds (a sidestory's base became known). */
  refresh(): void {
    this.later('rebuild', () => this.rebuild());
  }

  /** Steps covering a file, folded (for tests and the view). */
  stepsFor(file: vscode.Uri): { groups: Map<string, StepRow[]>; total: number; shown: number; entries: Map<string, IndexEntry> } {
    const key = uriKey(file);
    const resolved = new Map(this.here.resolvedItems(file).map((it) => [`${it.entry.key}\0${it.id}`, it]));
    const entries = new Map<string, IndexEntry>();
    const inputs: StepInput[] = [];
    for (const slot of this.index.anchorsIn(key)) {
      const e = slot.entry;
      const i = slot.index;
      const si = e.outlined ? e.stepOf[i]! : -1;
      if (e.outlined && si < 0) continue; // not in a step: only data-explain-ref uses it
      entries.set(e.key, e);
      const id = e.ids[i]!;
      const r = resolved.get(`${e.key}\0${id}`);
      const step = si >= 0 ? e.steps[si]! : undefined;
      inputs.push({
        group: e.key,
        stepIndex: si,
        stepId: step?.id ?? id,
        title: step?.title ?? id,
        anchor: id,
        range: r && r.state !== 'pending' ? r.range : { start: e.start[i]!, end: e.end[i]! },
        state: r?.state ?? 'pending',
        approx: !r || r.state === 'pending',
      });
    }
    return { ...foldSteps(inputs), entries };
  }

  private rebuild(): void {
    this.top = [];
    this.byStep.clear();
    const f = this.file;
    if (!f) {
      void vscode.commands.executeCommand('setContext', 'sidestory.thisFile.state', 'noFile');
      this.view.description = undefined;
      this.emitter.fire();
      return;
    }
    const name = displayText(f.path.split('/').pop() ?? '', 60);
    this.view.description = name;
    if (!this.view.visible) {
      // Nothing computed for a collapsed view (§9.1); the welcome state still needs the answer.
      void vscode.commands.executeCommand('setContext', 'sidestory.thisFile.state', this.index.isAnchored(uriKey(f)) ? 'ready' : 'empty');
      this.emitter.fire();
      return;
    }
    const { groups, total, shown, entries } = this.stepsFor(f);
    const order = [...groups.entries()].sort((a, b) => (a[1][0]!.range?.start ?? 1e9) - (b[1][0]!.range?.start ?? 1e9));
    for (const [key, rows] of order) {
      const e = entries.get(key)!;
      const base = this.host.baseOf(e.ref.dir);
      // Nodes are built once per rebuild: `reveal` and `getParent` need the same objects VS Code got.
      const g: Node & { kind: 'group' } = { kind: 'group', id: `g:${key}`, entry: e, label: this.index.pathLabel(e), description: base ? `vs ${displayText(base, 40)}` : undefined, children: [] };
      for (const row of rows) {
        const n: Node = { kind: 'step', id: `s:${e.key}\0${row.stepId}`, entry: e, row, parent: g };
        g.children.push(n);
        this.byStep.set(`${e.key}\0${row.stepId}`, n);
      }
      this.top.push(g);
    }
    if (total > shown) this.top.push({ kind: 'more', id: 'more', count: total - shown });
    void vscode.commands.executeCommand('setContext', 'sidestory.thisFile.state', total ? 'ready' : 'empty');
    this.emitter.fire();
    this.markCursor();
  }

  /** `●` on the step at the cursor (no I/O: resolved results only); selected only while the view is visible. */
  private markCursor(): void {
    const ed = vscode.window.activeTextEditor;
    const f = this.file;
    let next: string | undefined;
    if (ed && f && ed.document.uri.scheme === 'file' && uriKey(ed.document.uri) === uriKey(f)) {
      const best = this.here.covering(f, ed.selection.active.line + 1)[0];
      if (best) {
        const si = best.entry.outlined ? best.entry.stepOf[best.index]! : -1;
        next = `${best.entry.key}\0${si >= 0 ? best.entry.steps[si]!.id : best.id}`;
      }
    }
    if (next === this.marked) return;
    this.marked = next;
    this.emitter.fire();
    if (next && this.view.visible) {
      setTimeout(() => {
        const n = this.byStep.get(next!);
        if (n) void Promise.resolve(this.view.reveal(n, { select: true, focus: false })).catch(() => {});
      }, 0);
    }
  }

  /** For tests (`sidestory._thisFile`): the file followed and the rows shown. */
  stats(): { file: string | undefined; description: string | undefined; rows: string[] } {
    const rows: string[] = [];
    for (const n of this.top) {
      if (n.kind !== 'group') continue;
      rows.push(`${n.label}${n.description ? ` (${n.description})` : ''}`);
      for (const c of this.getChildren(n)) rows.push(`  ${this.getTreeItem(c).label as string} ${this.getTreeItem(c).description as string}`);
    }
    return { file: this.file?.toString(), description: this.view.description, rows };
  }

  getChildren(node?: Node): Node[] {
    if (!node) return this.top;
    return node.kind === 'group' ? node.children : [];
  }

  getParent(node: Node): Node | undefined {
    return node.kind === 'step' ? node.parent : undefined;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'more') {
      const item = new vscode.TreeItem(`+${node.count} more · Show Sidestories for This Code`);
      item.command = { command: 'sidestory.showHere', title: 'Show Sidestories for This Code' };
      return item;
    }
    if (node.kind === 'group') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.id = node.id;
      item.iconPath = new vscode.ThemeIcon('book');
      item.description = node.description;
      item.tooltip = `${node.label}\n${displayText(vscode.workspace.asRelativePath(node.entry.ref.dir, false), 200)}`;
      item.contextValue = 'thisFileSidestory';
      return item;
    }
    const r = node.row;
    const here = this.marked === `${node.entry.key}\0${r.stepId}`;
    const num = r.stepIndex >= 0 ? `${r.stepIndex + 1}  ` : '';
    const item = new vscode.TreeItem(`${here ? '● ' : ''}${num}${displayText(r.title, 80)}`, vscode.TreeItemCollapsibleState.None);
    item.id = node.id;
    const lines = r.range ? (r.range.start === r.range.end ? `L${r.range.start}` : `L${r.range.start}–${r.range.end}`) : '';
    item.description = r.lost ? 'code not found' : `${lines}${r.approx ? '  ≈' : ''}`;
    item.tooltip = [displayText(r.title, 200), r.lost ? 'Its code is not found in this file' : r.approx ? `${lines} (from the manifest; not yet checked against the file)` : lines, here ? 'At the cursor' : '', 'Click to open at this step'].filter(Boolean).join('\n');
    item.accessibilityInformation = { label: `${here ? 'At the cursor: ' : ''}step ${r.stepIndex + 1}, ${displayText(r.title, 80)}, ${item.description}` };
    item.command = { command: 'sidestory.openAt', title: 'Open at Step', arguments: [{ dir: node.entry.ref.dir.toString(), anchor: r.stepId, trail: this.index.trail(node.entry), source: 'tree' }] };
    item.contextValue = 'thisFileStep';
    return item;
  }

  /** "Explain with Sidestory" (§14.4): opens the first step covering the file, else copies the file prompt. */
  async explainFile(arg?: unknown): Promise<void> {
    const uri = arg instanceof vscode.Uri ? arg : (arg as { resourceUri?: vscode.Uri })?.resourceUri ?? (vscode.window.activeTextEditor ? (this.host.fileOf(vscode.window.activeTextEditor.document.uri) ?? vscode.window.activeTextEditor.document.uri) : this.file);
    if (!uri) return;
    const { groups, entries } = this.stepsFor(uri);
    const first = [...groups.values()].flat().find((r) => !r.lost);
    if (first) {
      const e = entries.get(first.group)!;
      await vscode.commands.executeCommand('sidestory.openAt', { dir: e.ref.dir.toString(), anchor: first.stepId, trail: this.index.trail(e), source: 'pick' });
      return;
    }
    const rel = vscode.workspace.asRelativePath(uri, false);
    await vscode.env.clipboard.writeText(explainFilePrompt(rel));
    void vscode.window.showInformationMessage(`No sidestory explains ${displayText(rel.split('/').pop() ?? rel, 60).replace(/\]\(/g, '] (')} yet. ${COPIED}`);
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.subs.forEach((d) => d.dispose());
  }
}

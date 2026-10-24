// One way to open code (docs/CHANGES-PLAN.md §7.1–§7.2): `openTarget`, used by the session's reveals (steps and
// inline refs) and by the Changes view's change items. A target whose file is in the comparison opens the merge diff
// with the same two URIs as the Changes view (`ChangesView.diffUris`), so both reuse one tab; then the side's editor
// is awaited (vscode.diff returns before its editors are visible, at most 1 s) and revealed. A file the branch didn't
// change opens a plain editor. When the left side has no editor (an inline diff, §7.5), the base-side lines are
// revealed on the right at their mapped position.
import * as vscode from 'vscode';
import type { FileDiff } from '../../core/hunks.ts';
import type { LineRange } from '../../core/manifest.ts';
import type { Snapshot } from './comparison.ts';
import type { ChangeEntry } from './model.ts';
import type { SideKey } from './targets.ts';
import { mapOldRange } from './targets.ts';

/** What opening and cursor-follow need from the comparison; built by the Changes view. */
export interface DiffContext {
  readonly snapshot: Snapshot;
  /** The two sides of a file's merge diff and its title (the view's `diffUris`). */
  diffUris(e: ChangeEntry): { left: vscode.Uri; right: vscode.Uri; title: string };
  /** An editor's document as (repo path, side): `file:` → head, `sidestory-git:` at the merge-base → base, at HEAD → head. */
  keyOf(uri: vscode.Uri): SideKey | undefined;
  /** The document a side of a path is read from and shown in: the working file (or HEAD's blob), or the merge-base blob. */
  uriFor(key: SideKey): vscode.Uri | undefined;
  /** The comparison's entry for a side of a path (a head path of an added, modified or renamed file; a base path of a deleted, modified or renamed one). */
  entryFor(key: SideKey): ChangeEntry | undefined;
  /** The file's diff (from coverage), for the line maps; undefined until computed. */
  lineMap(headPath: string): FileDiff | undefined;
}

export interface OpenOptions {
  moveCursor: boolean;
  viewColumn: vscode.ViewColumn;
  preserveFocus: boolean;
  /** `sidestory.changes.openStepsIn`: "diff" (default) or "editor". */
  mode: 'diff' | 'editor';
}

export interface Opened {
  editor: vscode.TextEditor | undefined;
  /** The URI the target's range is in (and is highlighted in). */
  uri: vscode.Uri;
  range: LineRange;
  /** Shown in a diff editor's side: no dimming there (§7.3). */
  inDiff: boolean;
  /** The base side had no editor: the range was mapped to the right side (§7.5). */
  mapped?: { removed: number };
}

export const STEPS_SETTING = 'changes.openStepsIn';
export const openStepsIn = (): 'diff' | 'editor' => (vscode.workspace.getConfiguration('sidestory').get<string>(STEPS_SETTING, 'diff') === 'editor' ? 'editor' : 'diff');

/** A visible editor showing `uri`, waiting for one at most `ms` (vscode.diff shows its editors a moment later). */
export function editorFor(uri: vscode.Uri, ms = 1000): Promise<vscode.TextEditor | undefined> {
  const key = uri.toString();
  const find = () => vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === key);
  const now = find();
  if (now) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = (e: vscode.TextEditor | undefined) => {
      clearTimeout(timer);
      sub.dispose();
      resolve(e);
    };
    const sub = vscode.window.onDidChangeVisibleTextEditors(() => {
      const e = find();
      if (e) done(e);
    });
    const timer = setTimeout(() => done(find()), ms);
  });
}

/** Whether `uri` is shown as a side of a diff editor in some group (§7.3: no dimming there). */
export function isDiffSide(uri: vscode.Uri): boolean {
  const key = uri.toString();
  return vscode.window.tabGroups.all.some((g) => {
    const input = g.activeTab?.input;
    return input instanceof vscode.TabInputTextDiff && (input.original.toString() === key || input.modified.toString() === key);
  });
}

function reveal(editor: vscode.TextEditor, r: LineRange, moveCursor: boolean): void {
  const last = Math.max(0, editor.document.lineCount - 1);
  const range = new vscode.Range(Math.min(r.start - 1, last), 0, Math.min(r.end - 1, last), 0);
  if (moveCursor) editor.selection = new vscode.Selection(range.start, range.start);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  // Vertically only: revealing the first line's start scrolls a long line's editor back (as revealNow did).
  editor.revealRange(new vscode.Range(range.start, range.start), vscode.TextEditorRevealType.Default);
}

/**
 * Opens a target (§7.1): the merge diff when its file is in the comparison (and the mode is "diff"), else a plain
 * editor of its side's document (`plain` when there is no comparison: the working tree file).
 */
export async function openTarget(ctx: DiffContext | undefined, target: SideKey & { range: LineRange }, plain: vscode.Uri | undefined, o: OpenOptions): Promise<Opened | undefined> {
  const entry = ctx && o.mode === 'diff' ? ctx.entryFor(target) : undefined;
  if (ctx && entry) {
    const { left, right, title } = ctx.diffUris(entry);
    const uri = target.side === 'base' ? left : right;
    await vscode.commands.executeCommand('vscode.diff', left, right, title, { viewColumn: o.viewColumn, preview: true, preserveFocus: o.preserveFocus });
    const editor = await editorFor(uri);
    if (editor) {
      reveal(editor, target.range, o.moveCursor);
      return { editor, uri, range: target.range, inDiff: true };
    }
    // No editor for the left side (an inline diff): the removed lines' place on the right.
    const diff = target.side === 'base' ? ctx.lineMap(entry.path) : undefined;
    const rightEditor = target.side === 'base' && entry.status !== 'D' ? await editorFor(right, 300) : undefined;
    if (rightEditor && diff) {
      const mapped = mapOldRange(diff, target.range);
      const at = { start: mapped.start, end: mapped.start };
      reveal(rightEditor, at, o.moveCursor);
      return { editor: rightEditor, uri: right, range: at, inDiff: true, mapped: { removed: target.range.end - target.range.start + 1 } };
    }
    return { editor: undefined, uri, range: target.range, inDiff: true };
  }
  const uri = ctx?.uriFor(target) ?? plain;
  if (!uri) return undefined;
  const r = target.range;
  const editor = await vscode.window.showTextDocument(uri, {
    viewColumn: o.viewColumn,
    preserveFocus: o.preserveFocus,
    preview: true,
    selection: o.moveCursor ? new vscode.Range(r.start - 1, 0, r.start - 1, 0) : undefined,
  });
  reveal(editor, r, false);
  return { editor, uri, range: r, inDiff: false };
}

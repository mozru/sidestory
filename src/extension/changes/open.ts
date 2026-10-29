// One way to open code (docs/CHANGES-PLAN.md §7.1–§7.2): `openTarget`, used by the session's reveals (steps and
// inline refs) and by Next/Previous Unexplained Change. Steps open plain editors by default (`openStepsIn`, §7.2;
// Open Changes with Base switches to the diff). In "diff" mode, and for Next/Previous Unexplained Change, a target whose
// file is in the comparison opens the merge diff with the comparison's two URIs (`ChangesService.diffUris`), so every opener reuses one tab; then the side's editor
// in that diff's group is awaited (vscode.diff returns before its editors are visible, at most 1 s) and revealed. A file the branch didn't
// change opens a plain editor. When the left side has no editor (an inline diff, §7.5), the base-side lines are
// revealed on the right at their mapped position.
import * as vscode from 'vscode';
import { revealLines } from '../reveal.ts';
import type { FileDiff } from '../../core/hunks.ts';
import type { LineRange } from '../../core/manifest.ts';
import type { Snapshot } from './comparison.ts';
import type { ChangeEntry } from './model.ts';
import type { SideKey } from './targets.ts';
import { mapOldRange } from './targets.ts';

/** What opening and cursor-follow need from the comparison; built by the changes service. */
export interface DiffContext {
  readonly snapshot: Snapshot;
  /** The two sides of a file's merge diff and its title (the service's `diffUris`); undefined for a path not read from disk. */
  diffUris(e: ChangeEntry): { left: vscode.Uri; right: vscode.Uri; title: string } | undefined;
  /** An editor's document as (repo path, side): `file:` → head, `sidestory-git:` at the merge-base → base, at HEAD → head. */
  keyOf(uri: vscode.Uri): SideKey | undefined;
  /** The document a side of a path is read from and shown in: the working file (or HEAD's blob), or the merge-base blob; undefined for a path not read from disk. */
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
  /** `sidestory.changes.openStepsIn`: "editor" (default) or "diff". */
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
export const openStepsIn = (): 'diff' | 'editor' => (vscode.workspace.getConfiguration('sidestory').get<string>(STEPS_SETTING, 'editor') === 'diff' ? 'diff' : 'editor');

/**
 * A visible editor showing `uri`, waiting for one at most `ms` (vscode.diff shows its editors a moment later). With
 * `diff`, only an editor in the group whose active tab is that diff (left ↔ right): the same file may be open in a
 * plain editor or another diff elsewhere, and revealing there would miss the diff the step opened.
 */
export function editorFor(uri: vscode.Uri, ms = 1000, diff?: { left: vscode.Uri; right: vscode.Uri }): Promise<vscode.TextEditor | undefined> {
  const key = uri.toString();
  const find = () => {
    const shown = vscode.window.visibleTextEditors.filter((e) => e.document.uri.toString() === key);
    if (!diff) return shown[0];
    const group = vscode.window.tabGroups.all.find((g) => {
      const input = g.activeTab?.input;
      return input instanceof vscode.TabInputTextDiff && input.original.toString() === diff.left.toString() && input.modified.toString() === diff.right.toString();
    });
    if (!group) return undefined;
    const inGroup = shown.find((e) => e.viewColumn === group.viewColumn);
    if (inGroup) return inGroup;
    // A diff's original side may report no column: take it only when nothing else shows that document.
    const unplaced = shown.filter((e) => e.viewColumn === undefined);
    return unplaced.length === 1 ? unplaced[0] : undefined;
  };
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

/** Whether some group shows this diff (left ↔ right) as its active tab. */
export function diffShown(pair: { left: vscode.Uri; right: vscode.Uri }): boolean {
  return vscode.window.tabGroups.all.some((g) => {
    const input = g.activeTab?.input;
    return input instanceof vscode.TabInputTextDiff && input.original.toString() === pair.left.toString() && input.modified.toString() === pair.right.toString();
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

/**
 * Whether an editor is a side of a diff editor: its group's active tab is a diff of its document. A diff's left side
 * may report no column: then any group showing such a diff.
 */
export function inDiffEditor(editor: vscode.TextEditor): boolean {
  const key = editor.document.uri.toString();
  const shows = (g: vscode.TabGroup) => {
    const input = g.activeTab?.input;
    return input instanceof vscode.TabInputTextDiff && (input.original.toString() === key || input.modified.toString() === key);
  };
  const groups = vscode.window.tabGroups.all;
  return editor.viewColumn === undefined ? groups.some(shows) : groups.some((g) => g.viewColumn === editor.viewColumn && shows(g));
}

function reveal(editor: vscode.TextEditor, r: LineRange, moveCursor: boolean): void {
  const last = Math.max(0, editor.document.lineCount - 1);
  const range = new vscode.Range(Math.min(r.start - 1, last), 0, Math.min(r.end - 1, last), 0);
  if (moveCursor) editor.selection = new vscode.Selection(range.start, range.start);
  revealLines(editor, range);
}

/**
 * Opens a target (§7.1): the merge diff when its file is in the comparison (and the mode is "diff"), else a plain
 * editor of its side's document (`plain` when there is no comparison: the working tree file).
 */
export async function openTarget(ctx: DiffContext | undefined, target: SideKey & { range: LineRange }, plain: vscode.Uri | undefined, o: OpenOptions): Promise<Opened | undefined> {
  const entry = ctx && o.mode === 'diff' ? ctx.entryFor(target) : undefined;
  const pair = ctx && entry ? ctx.diffUris(entry) : undefined;
  // A changed file whose working tree path isn't read from disk (a Windows device name): nothing to open.
  if (entry && !pair) return undefined;
  if (ctx && entry && pair) {
    const { left, right, title } = pair;
    const uri = target.side === 'base' ? left : right;
    await vscode.commands.executeCommand('vscode.diff', left, right, title, { viewColumn: o.viewColumn, preview: true, preserveFocus: o.preserveFocus });
    const editor = await editorFor(uri, 1000, { left, right });
    if (editor) {
      reveal(editor, target.range, o.moveCursor);
      return { editor, uri, range: target.range, inDiff: true };
    }
    // No editor for the left side (an inline diff): the removed lines' place on the right.
    const diff = target.side === 'base' ? ctx.lineMap(entry.path) : undefined;
    const rightEditor = target.side === 'base' && entry.status !== 'D' ? await editorFor(right, 300, { left, right }) : undefined;
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
  // The cursor is placed by `reveal`, not by showTextDocument's `selection`, which would scroll a second time.
  const editor = await vscode.window.showTextDocument(uri, { viewColumn: o.viewColumn, preserveFocus: o.preserveFocus, preview: true });
  reveal(editor, r, o.moveCursor);
  return { editor, uri, range: r, inDiff: false };
}

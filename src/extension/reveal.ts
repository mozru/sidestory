// Showing lines in an editor with one scroll, never several: two reveals in a row (centre the range, then make its
// first line visible; or showTextDocument's own `selection` reveal, then ours) pull the view one way and back, which
// reads as a jump. VS Code's InCenterIfOutsideViewport alone does it right: no scroll when the lines are on screen
// (sticky scroll and edge padding counted), centred when they fit, from the first line when they don't, and back to
// column 0. And placing the cursor ourselves, so the echo VS Code sends for it isn't taken for the reader's move.
import * as vscode from 'vscode';

/** Scrolls `editor` once, if at all, so that `range` (whole lines) shows. */
export function revealLines(editor: vscode.TextEditor, range: vscode.Range): void {
  editor.revealRange(new vscode.Range(range.start.line, 0, range.end.line, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

/** Cursors the extension placed and VS Code hasn't echoed yet: document URI → line, until when. */
const placed = new Map<string, { line: number; until: number }>();
/** Long enough for the echo (a later task), short enough not to swallow the reader's next move. */
const ECHO_MS = 1500;

/** Puts the cursor at the start of `line` without scrolling; its selection event is then the extension's, not the reader's. */
export function placeCursor(editor: vscode.TextEditor, line: number): void {
  const at = new vscode.Position(line, 0);
  placed.set(editor.document.uri.toString(), { line, until: Date.now() + ECHO_MS });
  editor.selection = new vscode.Selection(at, at);
}

/** Whether a selection change is the echo of a cursor `placeCursor` put there (used once). */
export function isPlacedEcho(e: vscode.TextEditorSelectionChangeEvent): boolean {
  const key = e.textEditor.document.uri.toString();
  const p = placed.get(key);
  if (!p) return false;
  placed.delete(key);
  const s = e.selections[0];
  return Date.now() <= p.until && e.kind === vscode.TextEditorSelectionChangeKind.Command && !!s && s.isEmpty && s.active.line === p.line;
}

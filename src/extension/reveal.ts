// Showing lines in an editor with one scroll, never several: two reveals in a row (centre the range, then make its
// first line visible) pull the view one way and back when the range is taller than the editor or already partly on
// screen, which reads as a jump. Lines already fully on screen don't move at all, so clicking the same link twice
// leaves the view where it is.
import * as vscode from 'vscode';

/** Scrolls `editor` once so that `range` (whole lines) shows: centred when it fits, else from its first line. */
export function revealLines(editor: vscode.TextEditor, range: vscode.Range): void {
  const visible = editor.visibleRanges;
  if (visible.some((v) => v.start.line <= range.start.line && v.end.line >= range.end.line)) return;
  const rows = visible.length ? visible[visible.length - 1]!.end.line - visible[0]!.start.line : 0;
  const start = new vscode.Range(range.start.line, 0, range.start.line, 0);
  if (rows > 0 && range.end.line - range.start.line < rows) editor.revealRange(new vscode.Range(range.start.line, 0, range.end.line, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  else editor.revealRange(start, vscode.TextEditorRevealType.AtTop);
}

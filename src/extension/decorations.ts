// Editor highlights for the active step. Colors come only from the theme (ThemeColor ids).
import * as vscode from 'vscode';
import type { LineRange } from '../core/manifest.ts';

export interface Focus {
  uri: vscode.Uri;
  range: LineRange;
  /** Theme color id for the left bar and scrollbar marker. */
  color?: string;
  highlight: readonly string[];
  /** Fade the rest of the file. */
  dim: boolean;
}

export class Decorations implements vscode.Disposable {
  private readonly focusTypes = new Map<string, vscode.TextEditorDecorationType>();
  private readonly chip = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('codeExplainer.highlightBackground'),
    borderColor: new vscode.ThemeColor('codeExplainer.highlightBorder'),
    borderStyle: 'solid',
    borderWidth: '1px',
    borderRadius: '3px',
  });
  private readonly dim = vscode.window.createTextEditorDecorationType({ opacity: '0.5' });
  private readonly flashType = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.findMatchForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Center,
  });
  private flashTimer: ReturnType<typeof setTimeout> | undefined;
  private current: Focus | undefined;

  /** Briefly marks lines (an inline reference's target) without changing the active step. */
  flash(editor: vscode.TextEditor, range: vscode.Range): void {
    clearTimeout(this.flashTimer);
    editor.setDecorations(this.flashType, [range]);
    this.flashTimer = setTimeout(() => editor.setDecorations(this.flashType, []), 1500);
  }

  set(focus: Focus | undefined): void {
    this.current = focus;
    this.refresh();
  }

  /** Whether the current highlight fades the rest of the file. */
  isDimmed(): boolean {
    return this.current?.dim ?? false;
  }

  /** Re-applies to visible editors (after edits, or when an editor becomes visible). */
  refresh(): void {
    for (const editor of vscode.window.visibleTextEditors) this.apply(editor);
  }

  private apply(editor: vscode.TextEditor): void {
    const f = this.current;
    const mine = f !== undefined && editor.document.uri.toString() === f.uri.toString();
    const focusType = f ? this.focusType(f.color) : undefined;
    for (const t of this.focusTypes.values()) if (t !== focusType || !mine) editor.setDecorations(t, []);
    if (!mine || !f || !focusType) {
      editor.setDecorations(this.chip, []);
      editor.setDecorations(this.dim, []);
      return;
    }
    const doc = editor.document;
    const last = doc.lineCount - 1;
    const startLine = Math.min(f.range.start - 1, last);
    const endLine = Math.min(f.range.end - 1, last);
    editor.setDecorations(focusType, [new vscode.Range(startLine, 0, endLine, doc.lineAt(endLine).text.length)]);
    editor.setDecorations(this.chip, identifierRanges(doc, f.highlight));
    const outside: vscode.Range[] = [];
    if (f.dim) {
      if (startLine > 0) outside.push(new vscode.Range(0, 0, startLine - 1, doc.lineAt(startLine - 1).text.length));
      if (endLine < last) outside.push(new vscode.Range(endLine + 1, 0, last, doc.lineAt(last).text.length));
    }
    editor.setDecorations(this.dim, outside);
  }

  private focusType(color = 'codeExplainer.focusBorder'): vscode.TextEditorDecorationType {
    let t = this.focusTypes.get(color);
    if (!t) {
      t = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: new vscode.ThemeColor('codeExplainer.focusBackground'),
        borderColor: new vscode.ThemeColor(color),
        borderStyle: 'solid',
        borderWidth: '0 0 0 2px',
        overviewRulerColor: new vscode.ThemeColor(color),
        overviewRulerLane: vscode.OverviewRulerLane.Left,
      });
      this.focusTypes.set(color, t);
    }
    return t;
  }

  dispose(): void {
    for (const t of this.focusTypes.values()) t.dispose();
    clearTimeout(this.flashTimer);
    this.chip.dispose();
    this.dim.dispose();
    this.flashType.dispose();
  }
}

/** Every whole-word occurrence of the given identifiers in the document. */
function identifierRanges(doc: vscode.TextDocument, names: readonly string[]): vscode.Range[] {
  if (names.length === 0) return [];
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(?<![\\w$])(?:${escaped.join('|')})(?![\\w$])`, 'g');
  const out: vscode.Range[] = [];
  for (let i = 0; i < doc.lineCount; i++) {
    const text = doc.lineAt(i).text;
    for (const m of text.matchAll(re)) out.push(new vscode.Range(i, m.index, i, m.index + m[0].length));
  }
  return out;
}

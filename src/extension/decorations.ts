// Editor highlights for the active step. Colors come only from the theme (ThemeColor ids).
import * as vscode from 'vscode';
import type { LineRange } from '../core/manifest.ts';
import { inDiffEditor } from './changes/open.ts';

export interface Focus {
  uri: vscode.Uri;
  range: LineRange;
  /** Theme color id for the left bar and scrollbar marker. */
  color?: string;
  highlight: readonly string[];
  /** Fade the rest of the file (never in a diff editor's side, docs/CHANGES-PLAN.md §7.3). */
  dim: boolean;
  /** A note before the first line: removed code shown at its place on the right of an inline diff (§7.5). */
  note?: string;
  /** The step's number and title, shown after its first line in a diff editor's side ("◀ Step 2 · Jitter"). */
  label?: string;
}

/** Lines (and identifiers) a widget highlights inside the current step's anchor (docs/WIDGETS-PLAN.md §5.3). */
export interface WidgetHighlight {
  uri: vscode.Uri;
  range: LineRange;
  identifiers: readonly string[];
}

export class Decorations implements vscode.Disposable {
  private readonly focusTypes = new Map<string, vscode.TextEditorDecorationType>();
  private readonly chip = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('sidestory.highlightBackground'),
    borderColor: new vscode.ThemeColor('sidestory.highlightBorder'),
    borderStyle: 'solid',
    borderWidth: '1px',
    borderRadius: '3px',
  });
  private readonly dim = vscode.window.createTextEditorDecorationType({ opacity: '0.5' });
  private readonly noteType = vscode.window.createTextEditorDecorationType({
    before: { color: new vscode.ThemeColor('editorCodeLens.foreground'), fontStyle: 'italic', margin: '0 1em 0 0' },
  });
  private readonly flashType = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.findMatchForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Center,
  });
  // After the flash fades, a frame stays around the lines: its sides on every line, its top and bottom on the ends.
  private readonly frameSides = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderColor: new vscode.ThemeColor('sidestory.clickFrameBorder'),
    borderStyle: 'solid',
    borderWidth: '0 1px',
  });
  private readonly frameTop = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderColor: new vscode.ThemeColor('sidestory.clickFrameBorder'),
    borderStyle: 'solid',
    borderWidth: '1px 0 0 0',
  });
  private readonly frameBottom = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderColor: new vscode.ThemeColor('sidestory.clickFrameBorder'),
    borderStyle: 'solid',
    borderWidth: '0 0 1px 0',
  });
  // High contrast themes leave highlight backgrounds transparent: there, a border marks the lines.
  private readonly widgetType = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('sidestory.widgetHighlightBackground'),
    borderColor: new vscode.ThemeColor('sidestory.widgetHighlightBorder'),
    borderStyle: 'solid',
    borderWidth: '1px',
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.wordHighlightForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });
  private readonly widgetIds = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('sidestory.highlightBackground'),
    borderColor: new vscode.ThemeColor('focusBorder'),
    borderStyle: 'solid',
    borderWidth: '1px',
    borderRadius: '3px',
  });
  // In a diff editor's side the plain tint is lost among the diff's own colours (a file the branch added is green from
  // top to bottom): the step gets a frame and a tint in a colour no diff uses (purple), a full-width mark in the
  // overview ruler, and a label after its first line. High contrast themes have no tint (transparent backgrounds):
  // the frame, in their contrast border colour, carries it. Plain editors keep their look.
  private readonly diffBody = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('sidestory.diffFocusBackground'),
    borderColor: new vscode.ThemeColor('sidestory.diffFocusBorder'),
    borderStyle: 'solid',
    borderWidth: '0 2px 0 3px',
    overviewRulerColor: new vscode.ThemeColor('sidestory.diffFocusBorder'),
    overviewRulerLane: vscode.OverviewRulerLane.Full,
  });
  private readonly diffTop = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderColor: new vscode.ThemeColor('sidestory.diffFocusBorder'),
    borderStyle: 'solid',
    borderWidth: '2px 0 0 0',
  });
  private readonly diffBottom = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderColor: new vscode.ThemeColor('sidestory.diffFocusBorder'),
    borderStyle: 'solid',
    borderWidth: '0 0 2px 0',
  });
  private readonly diffLabel = vscode.window.createTextEditorDecorationType({
    after: { color: new vscode.ThemeColor('sidestory.diffFocusBorder'), fontStyle: 'italic', fontWeight: '600', margin: '0 0 0 3em' },
  });
  private flashTimer: ReturnType<typeof setTimeout> | undefined;
  private flashed: vscode.TextEditor | undefined;
  private current: Focus | undefined;
  private widget: WidgetHighlight | undefined;

  /** A widget's highlight; undefined clears it. Never scrolls, opens files or moves focus. */
  setWidget(h: WidgetHighlight | undefined): void {
    if (!h && !this.widget) return;
    this.widget = h;
    // Only the widget's own decorations: widgets may highlight several times a second.
    for (const editor of vscode.window.visibleTextEditors) this.applyWidget(editor);
  }

  /**
   * Marks lines (a link's or widget's target) without changing the active step, for `sidestory.clickHighlightSeconds`
   * (0: until the next one, or the panel leaves this sidestory); then, with `sidestory.clickFrame`, a frame stays
   * around them until then. Clears the previous one, in whichever editor it was.
   */
  flash(editor: vscode.TextEditor, range: vscode.Range): void {
    this.clearFlash();
    this.flashed = editor;
    editor.setDecorations(this.flashType, [range]);
    const set = vscode.workspace.getConfiguration('sidestory').get<unknown>('clickHighlightSeconds', 1.5);
    const seconds = typeof set === 'number' && Number.isFinite(set) ? set : 1.5;
    if (seconds <= 0) return;
    this.flashTimer = setTimeout(() => {
      editor.setDecorations(this.flashType, []);
      if (vscode.workspace.getConfiguration('sidestory').get<unknown>('clickFrame', true) === false) {
        this.flashed = undefined;
        return;
      }
      editor.setDecorations(this.frameSides, [range]);
      editor.setDecorations(this.frameTop, [new vscode.Range(range.start.line, 0, range.start.line, 0)]);
      editor.setDecorations(this.frameBottom, [new vscode.Range(range.end.line, 0, range.end.line, 0)]);
    }, Math.min(seconds, 3600) * 1000);
  }

  /** Clears the click highlight and its frame (the next click, or the panel left its sidestory). */
  clearFlash(): void {
    clearTimeout(this.flashTimer);
    for (const t of [this.flashType, this.frameSides, this.frameTop, this.frameBottom]) this.flashed?.setDecorations(t, []);
    this.flashed = undefined;
  }

  set(focus: Focus | undefined): void {
    this.current = focus;
    this.refresh();
  }

  /** The current highlight (tests: which document, which lines, whether dimmed). */
  get focus(): Focus | undefined {
    return this.current;
  }

  /** Tests: whether a visible diff editor side shows the current highlight as the diff frame. */
  framed(): boolean {
    const f = this.current;
    return !!f && vscode.window.visibleTextEditors.some((e) => e.document.uri.toString() === f.uri.toString() && inDiffEditor(e));
  }

  /** Whether the current highlight fades the rest of the file. */
  isDimmed(): boolean {
    return this.current?.dim ?? false;
  }

  /** Re-applies to visible editors (after edits, or when an editor becomes visible). */
  refresh(): void {
    for (const editor of vscode.window.visibleTextEditors) this.apply(editor);
  }

  private applyWidget(editor: vscode.TextEditor): void {
    const w = this.widget;
    if (w && editor.document.uri.toString() === w.uri.toString()) {
      const last = editor.document.lineCount - 1;
      const range = new vscode.Range(Math.min(w.range.start - 1, last), 0, Math.min(w.range.end - 1, last), 0);
      editor.setDecorations(this.widgetType, [range]);
      editor.setDecorations(this.widgetIds, identifierRanges(editor.document, w.identifiers, range.start.line, range.end.line));
    } else {
      editor.setDecorations(this.widgetType, []);
      editor.setDecorations(this.widgetIds, []);
    }
  }

  private apply(editor: vscode.TextEditor): void {
    this.applyWidget(editor);
    const f = this.current;
    const mine = f !== undefined && editor.document.uri.toString() === f.uri.toString();
    const diff = mine && inDiffEditor(editor);
    const focusType = f && !diff ? this.focusType(f.color) : undefined;
    for (const t of this.focusTypes.values()) if (t !== focusType || !mine) editor.setDecorations(t, []);
    if (!diff) for (const t of [this.diffBody, this.diffTop, this.diffBottom, this.diffLabel]) editor.setDecorations(t, []);
    if (!mine || !f) {
      editor.setDecorations(this.chip, []);
      editor.setDecorations(this.dim, []);
      editor.setDecorations(this.noteType, []);
      return;
    }
    const doc = editor.document;
    const last = doc.lineCount - 1;
    const startLine = Math.min(f.range.start - 1, last);
    const endLine = Math.min(f.range.end - 1, last);
    const lines = new vscode.Range(startLine, 0, endLine, doc.lineAt(endLine).text.length);
    if (diff) {
      editor.setDecorations(this.diffBody, [lines]);
      editor.setDecorations(this.diffTop, [new vscode.Range(startLine, 0, startLine, 0)]);
      editor.setDecorations(this.diffBottom, [new vscode.Range(endLine, 0, endLine, 0)]);
      const end = doc.lineAt(startLine).range.end;
      editor.setDecorations(this.diffLabel, f.label && !f.note ? [{ range: new vscode.Range(end, end), renderOptions: { after: { contentText: f.label } } }] : []);
    } else if (focusType) {
      editor.setDecorations(focusType, [lines]);
    }
    editor.setDecorations(this.chip, identifierRanges(doc, f.highlight));
    editor.setDecorations(this.noteType, f.note ? [{ range: new vscode.Range(startLine, 0, startLine, 0), renderOptions: { before: { contentText: f.note } } }] : []);
    const outside: vscode.Range[] = [];
    // Never in a diff editor's side (docs/CHANGES-PLAN.md §7.3), even when the step opened in a plain editor first.
    if (f.dim && !diff) {
      if (startLine > 0) outside.push(new vscode.Range(0, 0, startLine - 1, doc.lineAt(startLine - 1).text.length));
      if (endLine < last) outside.push(new vscode.Range(endLine + 1, 0, last, doc.lineAt(last).text.length));
    }
    editor.setDecorations(this.dim, outside);
  }

  private focusType(color = 'sidestory.focusBorder'): vscode.TextEditorDecorationType {
    let t = this.focusTypes.get(color);
    if (!t) {
      t = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: new vscode.ThemeColor('sidestory.focusBackground'),
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
    this.noteType.dispose();
    this.flashType.dispose();
    this.frameSides.dispose();
    this.frameTop.dispose();
    this.frameBottom.dispose();
    this.diffBody.dispose();
    this.diffTop.dispose();
    this.diffBottom.dispose();
    this.diffLabel.dispose();
    this.widgetType.dispose();
    this.widgetIds.dispose();
  }
}

/** Every whole-word occurrence of the given identifiers in the document, or in lines `from`–`to` (0-based) of it. */
function identifierRanges(doc: vscode.TextDocument, names: readonly string[], from = 0, to = doc.lineCount - 1): vscode.Range[] {
  if (names.length === 0) return [];
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(?<![\\w$])(?:${escaped.join('|')})(?![\\w$])`, 'g');
  const out: vscode.Range[] = [];
  for (let i = Math.max(0, from); i <= to; i++) {
    const text = doc.lineAt(i).text;
    for (const m of text.matchAll(re)) out.push(new vscode.Range(i, m.index, i, m.index + m[0].length));
  }
  return out;
}

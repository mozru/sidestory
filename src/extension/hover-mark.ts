// The editor side of the hover preview (`sidestory.hoverPreview` editor/both, `sidestory.hoverReveal`): while the
// pointer rests on a link in a panel, its lines are highlighted (with a scrollbar mark) in every visible editor of the
// file, and an editor whose view is elsewhere gets an arrow at its edge pointing at them. Never opens a file or moves
// focus, the cursor or the step; with hoverReveal it scrolls those editors to the lines and back afterwards.
import * as vscode from 'vscode';
import type { LineRange } from '../core/manifest.ts';

export interface HoverTarget {
  uri: vscode.Uri;
  range: LineRange;
  /** What the arrow names: the step's title, or the link's symbol. Without it, the arrow says how far. */
  label?: string;
  /** Scroll the editors to the lines while hovering, and back after (`sidestory.hoverReveal`). */
  reveal: boolean;
}

/** An editor hoverReveal scrolled: where its view started, and whether the reader has scrolled it since. */
interface Revealed {
  top: number;
  at: number;
  userScrolled: boolean;
}

/** Visible-range changes this soon after a reveal are the reveal's own (smooth scrolling included). */
const REVEAL_SETTLE_MS = 400;

export class HoverMark implements vscode.Disposable {
  // Lighter than the click flash. High contrast themes get a left border instead of the (transparent) tint.
  private readonly lines = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('sidestory.hoverPreviewBackground'),
    borderColor: new vscode.ThemeColor('sidestory.hoverPreviewBorder'),
    borderStyle: 'solid',
    borderWidth: '0 0 0 2px',
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.rangeHighlightForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Full,
  });
  private readonly arrow = vscode.window.createTextEditorDecorationType({
    after: { color: new vscode.ThemeColor('editorCodeLens.foreground'), fontStyle: 'italic', margin: '0 0 0 3em' },
  });
  private target: (HoverTarget & { owner: object }) | undefined;
  /** Some editor may still show a mark: clearing repaints them once, and otherwise nothing is painted. */
  private painted = false;
  private readonly revealed = new Map<vscode.TextEditor, Revealed>();
  private readonly subs: vscode.Disposable[];

  constructor() {
    this.subs = [
      vscode.window.onDidChangeTextEditorVisibleRanges((e) => this.onScrolled(e.textEditor)),
      vscode.window.onDidChangeVisibleTextEditors(() => this.refresh()),
    ];
  }

  /**
   * Marks a link's lines (undefined: clears the mark `owner` made; panels share this). On clearing, editors the
   * reveal scrolled go back where they were, unless `keep` (the reader clicked the link) or the reader scrolled them.
   */
  set(owner: object, t: HoverTarget | undefined, keep = false): void {
    if (!t && this.target?.owner !== owner) return;
    if (!t) this.restore(keep);
    this.target = t && { owner, ...t };
    if (t?.reveal) for (const e of this.editors()) this.reveal(e, t);
    this.refresh();
  }

  /** Paints every visible editor: the lines and the arrow in those of the file, nothing in the rest. */
  refresh(): void {
    if (!this.target && !this.painted) return;
    this.painted = !!this.target;
    for (const e of vscode.window.visibleTextEditors) this.paint(e);
  }

  private editors(): vscode.TextEditor[] {
    const t = this.target;
    return t ? vscode.window.visibleTextEditors.filter((e) => e.document.uri.toString() === t.uri.toString()) : [];
  }

  private paint(editor: vscode.TextEditor): void {
    const t = this.target;
    if (!t || editor.document.uri.toString() !== t.uri.toString()) {
      editor.setDecorations(this.lines, []);
      editor.setDecorations(this.arrow, []);
      return;
    }
    const last = editor.document.lineCount - 1;
    const start = Math.min(t.range.start - 1, last);
    const end = Math.min(t.range.end - 1, last);
    editor.setDecorations(this.lines, [new vscode.Range(start, 0, end, 0)]);
    // A revealed editor is on its way to the lines: no arrow there.
    const a = t.reveal && this.revealed.has(editor) ? undefined : edgeArrow(editor.visibleRanges, start, end, t.label);
    const at = a && editor.document.lineAt(Math.min(a.line, last)).range.end;
    editor.setDecorations(this.arrow, a && at ? [{ range: new vscode.Range(at, at), renderOptions: { after: { contentText: a.text } } }] : []);
  }

  /** Scrolls an editor whose view misses the lines to them, keeping where it was; focus stays where it is. */
  private reveal(editor: vscode.TextEditor, t: HoverTarget): void {
    const start = t.range.start - 1;
    const end = t.range.end - 1;
    if (this.revealed.has(editor) || overlaps(editor.visibleRanges, start, end)) return;
    const top = editor.visibleRanges[0]?.start.line;
    if (top === undefined) return;
    this.revealed.set(editor, { top, at: Date.now(), userScrolled: false });
    editor.revealRange(new vscode.Range(start, 0, end, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  /** Puts revealed editors back, unless the reader clicked the link (`keep`) or scrolled that editor meanwhile. */
  private restore(keep: boolean): void {
    for (const [editor, r] of this.revealed) {
      if (keep || r.userScrolled || !vscode.window.visibleTextEditors.includes(editor)) continue;
      editor.revealRange(new vscode.Range(r.top, 0, r.top, 0), vscode.TextEditorRevealType.AtTop);
    }
    this.revealed.clear();
  }

  private onScrolled(editor: vscode.TextEditor): void {
    const r = this.revealed.get(editor);
    if (r && Date.now() - r.at > REVEAL_SETTLE_MS) r.userScrolled = true;
    if (this.target && editor.document.uri.toString() === this.target.uri.toString()) this.paint(editor);
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.lines.dispose();
    this.arrow.dispose();
  }
}

function overlaps(visible: readonly vscode.Range[], start: number, end: number): boolean {
  return visible.some((v) => v.start.line <= end && v.end.line >= start);
}

/**
 * The arrow for lines `start`–`end` (0-based) in a view of `visible` ranges: at the end of the first visible line when
 * they're above it, of the last when below; none when any of them is in view (or there is no view).
 */
export function edgeArrow(visible: readonly vscode.Range[], start: number, end: number, label?: string): { line: number; text: string } | undefined {
  if (visible.length === 0 || overlaps(visible, start, end)) return undefined;
  const top = visible[0]!.start.line;
  const bottom = visible[visible.length - 1]!.end.line;
  const lines = end > start ? `L${start + 1}–${end + 1}` : `L${start + 1}`;
  if (end >= top && start <= bottom) return undefined; // inside a fold between visible ranges
  const up = end < top;
  const far = up ? top - end : start - bottom;
  const text = label ? `${label} · ${lines}` : `${lines} · ${far} line${far === 1 ? '' : 's'} ${up ? 'up' : 'down'}`;
  return up ? { line: top, text: `↑ ${text}` } : { line: bottom, text: `↓ ${text}` };
}

// The editor side of the hover preview (`sidestory.hoverPreview` editor/both, `sidestory.hoverReveal`): while the
// pointer rests on a link in a panel, its lines are highlighted (with a scrollbar mark) in every visible editor of the
// file, and an editor whose view is elsewhere gets an arrow near its edge pointing at them. Never opens a file or moves
// focus, the cursor or the step; with hoverReveal it scrolls those editors to the lines, and back once the reader is
// done with them (not when they went to that editor, clicked the link, or scrolled it themselves).
import * as vscode from 'vscode';
import type { LineRange } from '../core/manifest.ts';

export interface HoverTarget {
  uri: vscode.Uri;
  range: LineRange;
  /** What the arrow names: the step's title, or the link's symbol. */
  label?: string;
  /** Scroll the editors to the lines while hovering, and back after (`sidestory.hoverReveal`). */
  reveal: boolean;
}

/**
 * How a hover ended. `left`: the pointer left the panel (likely for the editor): scrolled editors stay until the
 * panel is used again (`set(owner, undefined)` once more); also right after a plain end, whose scroll-back it then
 * cancels. Otherwise they go back after RESTORE_MS, unless another link's hover or a click (`keep`) comes first.
 */
export type HoverEnd = 'left' | undefined;

/** An editor hoverReveal scrolled: where its view started, and when. */
interface Revealed {
  top: number;
  at: number;
}

/** A hover ending waits this long before scrolling editors back: the next link's hover keeps them (no bounce). */
export const RESTORE_MS = 500;
/** With smooth scrolling, a reveal's own scroll takes this long; its frames don't count as the reader's. */
const REVEAL_SETTLE_MS = 400;
/** Arrow labels longer than this are cut short. */
const MAX_LABEL = 50;

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
  /** The arrow each editor shows (`line\ntext`), so a scroll that doesn't change it costs nothing. */
  private readonly arrows = new WeakMap<vscode.TextEditor, string>();
  /** Editors hoverReveal scrolled, and the panel that did (another panel's hover puts them back first). */
  private readonly revealed = new Map<vscode.TextEditor, Revealed>();
  private revealOwner: object | undefined;
  private restoreTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly subs: vscode.Disposable[];

  constructor() {
    this.subs = [
      vscode.window.onDidChangeTextEditorVisibleRanges((e) => this.onScrolled(e.textEditor)),
      vscode.window.onDidChangeVisibleTextEditors(() => this.refresh()),
      // The reader went to that editor: it stays where it is.
      vscode.window.onDidChangeActiveTextEditor((e) => e && this.revealed.delete(e)),
      vscode.window.onDidChangeTextEditorSelection((e) => this.revealed.delete(e.textEditor)),
      // An edit moves line ends (where the arrow sits): paint it again.
      vscode.workspace.onDidChangeTextDocument((e) => {
        const t = this.target;
        for (const ed of vscode.window.visibleTextEditors) {
          if (ed.document !== e.document) continue;
          this.arrows.delete(ed);
          if (t && ed.document.uri.toString() === t.uri.toString()) this.paintArrow(ed, t);
        }
      }),
    ];
  }

  /**
   * Marks a link's lines (undefined: ends the hover `owner` made; panels share this). See HoverEnd for what then
   * happens to editors the reveal scrolled.
   */
  set(owner: object, t: HoverTarget | undefined, end: HoverEnd = undefined): void {
    if (t) {
      clearTimeout(this.restoreTimer);
      if (this.revealOwner && this.revealOwner !== owner) this.restore();
      this.target = { owner, ...t };
      if (t.reveal) for (const e of this.editors()) this.reveal(owner, e, t);
      this.refresh();
      return;
    }
    if (this.target?.owner !== owner && this.revealOwner !== owner) return;
    if (this.target?.owner === owner) {
      this.target = undefined;
      this.refresh();
    }
    if (this.revealOwner !== owner) return;
    clearTimeout(this.restoreTimer);
    // `left`: they wait (no timer) for the panel to be used again, which ends the hover once more.
    if (end !== 'left') this.restoreTimer = setTimeout(() => this.restore(), RESTORE_MS);
  }

  /** The link was opened (a click, Enter): editors the hover scrolled stay there. */
  keep(owner: object): void {
    if (this.revealOwner !== owner) return;
    clearTimeout(this.restoreTimer);
    this.forget();
  }

  /** A step was shown in this file: its editors are the step's now, never scrolled back. */
  release(uri: vscode.Uri): void {
    for (const e of [...this.revealed.keys()]) if (e.document.uri.toString() === uri.toString()) this.revealed.delete(e);
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
      this.paintArrow(editor, undefined);
      return;
    }
    const last = editor.document.lineCount - 1;
    editor.setDecorations(this.lines, [new vscode.Range(Math.min(t.range.start - 1, last), 0, Math.min(t.range.end - 1, last), 0)]);
    this.paintArrow(editor, t);
  }

  /** The arrow alone (scrolling changes nothing else), and only when it moved or changed. */
  private paintArrow(editor: vscode.TextEditor, t: HoverTarget | undefined): void {
    const last = editor.document.lineCount - 1;
    // A revealed editor is on its way to the lines: no arrow there.
    const a = !t || (t.reveal && this.revealed.has(editor)) ? undefined : edgeArrow(editor.visibleRanges, Math.min(t.range.start - 1, last), Math.min(t.range.end - 1, last), t.label, stickyLines());
    const key = a ? `${a.line}\n${a.text}` : '';
    if ((this.arrows.get(editor) ?? '') === key) return;
    this.arrows.set(editor, key);
    const at = a && editor.document.lineAt(Math.min(a.line, last)).range.end;
    editor.setDecorations(this.arrow, a && at ? [{ range: new vscode.Range(at, at), renderOptions: { after: { contentText: a.text } } }] : []);
  }

  /** Scrolls an editor whose view misses the lines to them, keeping where it first was; focus stays where it is. */
  private reveal(owner: object, editor: vscode.TextEditor, t: HoverTarget): void {
    const start = t.range.start - 1;
    const end = t.range.end - 1;
    if (overlaps(editor.visibleRanges, start, end)) return;
    const top = editor.visibleRanges[0]?.start.line;
    if (top === undefined) return;
    const was = this.revealed.get(editor);
    // Moving from link to link keeps the first view: that's where it goes back to.
    this.revealed.set(editor, { top: was?.top ?? top, at: Date.now() });
    this.revealOwner = owner;
    editor.revealRange(new vscode.Range(start, 0, end, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  /** Puts scrolled editors back where they were (those the reader didn't take over meanwhile). */
  private restore(): void {
    clearTimeout(this.restoreTimer);
    for (const [editor, r] of this.revealed) {
      if (!vscode.window.visibleTextEditors.includes(editor)) continue;
      editor.revealRange(new vscode.Range(r.top, 0, r.top, 0), vscode.TextEditorRevealType.AtTop);
    }
    this.forget();
  }

  private forget(): void {
    this.revealed.clear();
    this.revealOwner = undefined;
  }

  /**
   * A view changed. The reveal's own scroll ends with the lines in view (with smooth scrolling, its frames come within
   * REVEAL_SETTLE_MS); any other scroll is the reader's, and that editor stays where they put it.
   */
  private onScrolled(editor: vscode.TextEditor): void {
    const r = this.revealed.get(editor);
    const t = this.target;
    if (r) {
      const toTarget = t && t.uri.toString() === editor.document.uri.toString() && overlaps(editor.visibleRanges, t.range.start - 1, t.range.end - 1);
      const settling = Date.now() - r.at < REVEAL_SETTLE_MS && vscode.workspace.getConfiguration('editor').get<boolean>('smoothScrolling', false) === true;
      if (!toTarget && !settling) this.revealed.delete(editor);
    }
    if (t && editor.document.uri.toString() === t.uri.toString()) this.paintArrow(editor, t);
  }

  dispose(): void {
    clearTimeout(this.restoreTimer);
    for (const s of this.subs) s.dispose();
    this.lines.dispose();
    this.arrow.dispose();
  }
}

/**
 * Lines sticky scroll may cover at an editor's top: its `maxLineCount` (VS Code's default is 5), at most 5, so a
 * larger setting doesn't push the arrow far from the edge when few scopes are stuck.
 */
function stickyLines(): number {
  const c = vscode.workspace.getConfiguration('editor.stickyScroll');
  if (c.get<boolean>('enabled', true) === false) return 0;
  const n = c.get<unknown>('maxLineCount', 5);
  return Math.min(5, typeof n === 'number' && n >= 0 ? Math.floor(n) : 5);
}

function overlaps(visible: readonly vscode.Range[], start: number, end: number): boolean {
  return visible.some((v) => v.start.line <= end && v.end.line >= start);
}

/**
 * The arrow for lines `start`–`end` (0-based) in a view of `visible` ranges: a few lines into the view when they're
 * above it (`skip`: under sticky scroll), on the line before the last when below (the last may be cut off); none when
 * any of them is in view, or they're folded away between visible ranges. The text never counts lines, so scrolling
 * doesn't change it.
 */
export function edgeArrow(visible: readonly vscode.Range[], start: number, end: number, label?: string, skip = 5): { line: number; text: string } | undefined {
  if (visible.length === 0 || overlaps(visible, start, end)) return undefined;
  const top = visible[0]!.start.line;
  const bottom = visible[visible.length - 1]!.end.line;
  if (end >= top && start <= bottom) return undefined; // inside a fold between visible ranges
  const lines = end > start ? `L${start + 1}–${end + 1}` : `L${start + 1}`;
  const name = label?.replace(/\s+/g, ' ').trim();
  const shown = name && name.length > MAX_LABEL ? `${name.slice(0, MAX_LABEL - 1).trimEnd()}…` : name;
  const text = shown ? `${shown} · ${lines}` : lines;
  return end < top ? { line: Math.min(top + skip, bottom), text: `↑ ${text}` } : { line: Math.max(bottom - 1, top), text: `↓ ${text}` };
}

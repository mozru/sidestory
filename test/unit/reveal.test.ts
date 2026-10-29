// Showing lines with one scroll, and a cursor the extension places that isn't taken for the reader's own move.
import { describe, expect, it, vi } from 'vitest';
import { Range, Selection, TextEditorRevealType, TextEditorSelectionChangeKind, Uri } from './vscode-stub.ts';

vi.mock('vscode', () => import('./vscode-stub.ts'));

const { isPlacedEcho, placeCursor, revealLines } = await import('../../src/extension/reveal.ts');

function editor(path = '/ws/a.ts') {
  const calls: { start: number; end: number; type: unknown }[] = [];
  return {
    calls,
    document: { uri: Uri.file(path) },
    selection: undefined as unknown,
    revealRange: (r: Range, type: unknown) => calls.push({ start: r.start.line, end: r.end.line, type }),
  };
}

const change = (e: ReturnType<typeof editor>, line: number, kind: number) => ({ textEditor: e, selections: [new Selection(line, 0, line, 0)], kind }) as never;

describe('revealLines', () => {
  it('is one reveal, and one VS Code leaves alone when the lines are on screen', () => {
    const e = editor();
    revealLines(e as never, new Range(100, 4, 110, 2) as never);
    expect(e.calls).toEqual([{ start: 100, end: 110, type: TextEditorRevealType.InCenterIfOutsideViewport }]);
  });
});

describe('placeCursor', () => {
  it('puts the cursor at a line start, and its echo (once, a Command change on that line) is the extension\'s', () => {
    const e = editor();
    placeCursor(e as never, 41);
    expect((e.selection as Selection).start.line).toBe(41);
    expect(isPlacedEcho(change(e, 41, TextEditorSelectionChangeKind.Command))).toBe(true);
    // Every panel's listener sees the same echo; the reader's next move elsewhere ends it.
    expect(isPlacedEcho(change(e, 41, TextEditorSelectionChangeKind.Command))).toBe(true);
    expect(isPlacedEcho(change(e, 50, TextEditorSelectionChangeKind.Mouse))).toBe(false);
    expect(isPlacedEcho(change(e, 41, TextEditorSelectionChangeKind.Command))).toBe(false);
  });

  it('the reader\'s own click or another line is never taken for the echo', () => {
    const e = editor('/ws/b.ts');
    placeCursor(e as never, 7);
    expect(isPlacedEcho(change(e, 7, TextEditorSelectionChangeKind.Mouse))).toBe(false);
    placeCursor(e as never, 7);
    expect(isPlacedEcho(change(e, 9, TextEditorSelectionChangeKind.Command))).toBe(false);
    expect(isPlacedEcho(change(editor('/ws/c.ts'), 7, TextEditorSelectionChangeKind.Command))).toBe(false);
  });
});

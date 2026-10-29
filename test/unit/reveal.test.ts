// Showing lines with one scroll: none when they're on screen, centred when they fit, else from their first line.
import { describe, expect, it, vi } from 'vitest';
import { Range } from './vscode-stub.ts';

vi.mock('vscode', () => import('./vscode-stub.ts'));

const { revealLines } = await import('../../src/extension/reveal.ts');

/** An editor showing lines `top`–`bottom` (0-based), recording its reveals. */
function editor(top: number, bottom: number) {
  const calls: { start: number; end: number; type: number }[] = [];
  return {
    calls,
    visibleRanges: [new Range(top, 0, bottom, 0)],
    revealRange: (r: Range, type: number) => calls.push({ start: r.start.line, end: r.end.line, type }),
  };
}

describe('revealLines', () => {
  it('leaves lines already fully on screen alone, so a second click on the same link never moves the view', () => {
    const e = editor(10, 50);
    revealLines(e as never, new Range(20, 0, 30, 0));
    revealLines(e as never, new Range(10, 0, 50, 0));
    expect(e.calls).toEqual([]);
  });

  it('scrolls once: centred when the lines fit, from their first line when they are taller than the editor', () => {
    const fits = editor(0, 40);
    revealLines(fits as never, new Range(100, 0, 110, 0));
    expect(fits.calls).toHaveLength(1);
    expect(fits.calls[0]).toMatchObject({ start: 100, end: 110 });
    const tall = editor(0, 40);
    revealLines(tall as never, new Range(100, 0, 200, 0));
    expect(tall.calls).toHaveLength(1);
    expect(tall.calls[0]).toMatchObject({ start: 100, end: 100 });
    // Partly on screen and taller than the editor: one scroll to its first line, not a centre and back.
    const part = editor(90, 130);
    revealLines(part as never, new Range(100, 0, 200, 0));
    expect(part.calls).toEqual([expect.objectContaining({ start: 100, end: 100 })]);
  });
});

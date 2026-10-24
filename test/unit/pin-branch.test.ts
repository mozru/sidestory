// Pin Anchors on a sidestory that explains a branch (docs/CHANGES-PLAN.md §7.6, §13.1): base-side anchors are read
// from the merge-base (never the working tree, where the file may be deleted or different), skipped with a reason
// when there is no comparison; a step whose code grew since it was written is asked about, never re-pinned silently.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pinQuote } from '../../src/core/pin.ts';
import { splitLines } from '../../src/core/text.ts';

vi.mock('vscode', () => import('./vscode-stub.ts'));
const vscode = await import('./vscode-stub.ts');
const { pinAnchors } = await import('../../src/extension/pin.ts');

const lines = (n: number, p: string) => Array.from({ length: n }, (_, i) => `${p} line ${i + 1} with some words`).join('\n') + '\n';
const OLD_SLEEP = lines(24, 'sleep');
const HEAD_LOOP = lines(12, 'loop');

let root = '';
const manifestPath = () => join(root, '.sidestory/retry/manifest.json');
const manifest = () => JSON.parse(readFileSync(manifestPath(), 'utf8'));
const ref = () => {
  const dir = vscode.Uri.file(join(root, '.sidestory/retry'));
  return { name: 'retry', dir, root: vscode.Uri.file(root) } as never;
};

function setup(loopNow: string) {
  root = mkdtempSync(join(tmpdir(), 'cx-pin-'));
  vscode.workspace.root = vscode.Uri.file(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'legacy'), { recursive: true });
  mkdirSync(join(root, '.sidestory/retry'), { recursive: true });
  writeFileSync(join(root, 'src/loop.ts'), loopNow);
  // A different file of the same name in the working tree: Pin must never read a base-side quote from it.
  writeFileSync(join(root, 'legacy/sleep.ts'), lines(5, 'unrelated'));
  const loopQuote = pinQuote(splitLines(HEAD_LOOP), { start: 1, end: 12 }, 'ws');
  const sleepQuote = pinQuote(splitLines(OLD_SLEEP), { start: 1, end: 24 }, 'ws');
  writeFileSync(
    manifestPath(),
    JSON.stringify(
      {
        version: 3,
        title: 'Retry',
        base: 'main',
        anchors: {
          loop: { file: 'src/loop.ts', range: [1, 12], quote: loopQuote },
          'old-sleep': { file: 'legacy/sleep.ts', side: 'base', range: [1, 24], quote: sleepQuote },
        },
      },
      null,
      2,
    ),
  );
}

const fromMergeBase = async () => ({ read: async (file: string) => (file === 'legacy/sleep.ts' ? OLD_SLEEP : undefined) });

beforeEach(() => {
  vscode.info.length = 0;
  vscode.modal.asked.length = 0;
  vscode.modal.answer = undefined;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('Pin Anchors with a base (§7.6)', () => {
  it('pins a base-side anchor from the merge-base blob, not the working tree file of the same name', async () => {
    setup(HEAD_LOOP);
    const before = manifest().anchors['old-sleep'];
    await pinAnchors(ref(), undefined, undefined, fromMergeBase);
    const after = manifest().anchors['old-sleep'];
    expect(after.side).toBe('base');
    expect(after.quote.exact).toBe(before.quote.exact);
    expect(after.range).toEqual([1, 24]);
    expect(vscode.info.at(-1)!.message).toMatch(/^Pinned 2 anchors in retry\./);
    expect(vscode.info.at(-1)!.message).not.toContain('Not pinned');
  });

  it('skips base-side anchors with a reason when there is no comparison, leaving them as written', async () => {
    setup(HEAD_LOOP);
    const before = manifest().anchors['old-sleep'];
    await pinAnchors(ref(), undefined, undefined, async () => ({ why: 'no git comparison here' }));
    expect(manifest().anchors['old-sleep']).toEqual(before);
    expect(vscode.info.at(-1)!.message).toContain('Not pinned: old-sleep (base side: no git comparison here).');
    // Without a reader at all: the same refusal.
    await pinAnchors(ref());
    expect(manifest().anchors['old-sleep']).toEqual(before);
  });
});

describe('needs a look (§13.1)', () => {
  // A line added inside the step's code: still "changed" with high similarity, but the prose doesn't cover it.
  const grown = HEAD_LOOP.replace('loop line 6 with some words\n', 'loop line 6 with some words\nawait jitter(delay, random)\n');

  it('asks first, and "Pin the Others" leaves the grown step as it was', async () => {
    setup(grown);
    const before = manifest().anchors.loop;
    vscode.modal.answer = 'Pin the Others';
    await pinAnchors(ref(), undefined, undefined, fromMergeBase);
    expect(vscode.modal.asked).toEqual(['1 step has code added since it was written. Re-pin it anyway?']);
    expect(vscode.modal.buttons.at(-1)).toEqual(['Re-pin', 'Pin the Others']);
    expect(manifest().anchors.loop).toEqual(before);
    expect(vscode.info.at(-1)!.message).toContain('loop (code added since it was written)');
  });

  it('"Re-pin" pins it where it is now; dismissing pins nothing', async () => {
    setup(grown);
    vscode.modal.answer = undefined;
    const text = readFileSync(manifestPath(), 'utf8');
    await pinAnchors(ref(), undefined, undefined, fromMergeBase);
    expect(readFileSync(manifestPath(), 'utf8')).toBe(text);
    vscode.modal.answer = 'Re-pin';
    await pinAnchors(ref(), undefined, undefined, fromMergeBase);
    expect(manifest().anchors.loop.range).toEqual([1, 13]);
    expect(manifest().anchors.loop.quote.exact).toContain('await jitter(delay, random)');
  });
});

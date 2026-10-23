// Drift badges (docs/NAVIGATION-PLAN.md §8.5, §12.1): only for shown nodes, within byte budgets, reused by stamp.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { code, story, tempRoot, waitFor, write } from './nav-fixtures.ts';
import { counts, events, Uri, workspace } from './vscode-stub.ts';

vi.mock('vscode', () => import('./vscode-stub.ts'));

const { SidestoryIndex, INDEX_LIMITS } = await import('../../src/extension/nav/index.ts');
const { SidestoryWatcher } = await import('../../src/extension/nav/watcher.ts');
const { DriftQueue, DRIFT_LIMITS } = await import('../../src/extension/nav/drift.ts');
const { uriKey } = await import('../../src/extension/explainers.ts');

const limits = INDEX_LIMITS as unknown as Record<string, number>;
const drifts = DRIFT_LIMITS as unknown as Record<string, number>;
const savedIndex = { ...limits };
const savedDrift = { ...drifts };
let root = '';
let index: InstanceType<typeof SidestoryIndex>;
let drift: InstanceType<typeof DriftQueue>;
const owned: { dispose(): void }[] = [];

const entry = (name: string) => index.entry(uriKey(Uri.file(join(root, '.sidestory', name)) as never))!;
const codeReads = (file: string) => counts.readPaths.filter((p) => p.endsWith(`/${file}`)).length;

async function start() {
  const watcher = new SidestoryWatcher();
  index = new SidestoryIndex(watcher);
  drift = new DriftQueue(index);
  owned.push(drift, index, watcher);
  await index.refresh();
}

/** Asks for a sidestory's drift (as showing its node does) and waits for it. */
async function driftOf(name: string) {
  const e = entry(name);
  if (!drift.get(e)) await new Promise<void>((resolve) => {
    const sub = drift.onDidChange((k) => {
      if (k === e.key) {
        sub.dispose();
        resolve();
      }
    });
  });
  return drift.get(e);
}

beforeAll(() => {
  limits.debounceMs = 20;
  drifts.typingPauseMs = 50;
});

beforeEach(() => {
  root = tempRoot('cx-drift-');
  workspace.root = Uri.file(root);
  workspace.textDocuments = [];
  write(join(root, 'f.ts'), code(50));
  // a1 is where it was; a2's code is gone; a3 changed a little.
  story(root, '', 'a', {
    anchors: {
      a1: { file: 'f.ts', range: [5, 6], quote: 'line 5\nline 6' },
      a2: { file: 'f.ts', range: [10, 11], quote: 'something else entirely\nthat never existed here' },
      a3: { file: 'f.ts', range: [20, 23], quote: 'line 20\nline 21\nline 22 changed\nline 23' },
    },
  });
  story(root, '', 'b', { anchors: { b1: { file: 'f.ts', range: [5, 6], quote: 'line 5\nline 6' } } });
});

afterEach(() => {
  for (const d of owned.splice(0)) d.dispose();
  Object.assign(drifts, savedDrift, { typingPauseMs: 50 });
  rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  Object.assign(limits, savedIndex);
  Object.assign(drifts, savedDrift);
});

describe('drift', () => {
  it('counts out-of-date and lost anchors, only for sidestories asked about', async () => {
    await start();
    const d = await driftOf('a');
    expect(d).toEqual({ outOfDate: 1, lost: 1, unchecked: 0 });
    expect(drift.peek(entry('b').key)).toBeUndefined();
  });

  it('skips files over 1 MB as unchecked, not lost', async () => {
    drifts.fileBytes = 100;
    await start();
    expect(await driftOf('a')).toEqual({ outOfDate: 0, lost: 0, unchecked: 3 });
  });

  it('stops reading at the per-sidestory budget', async () => {
    write(join(root, 'g.ts'), code(50));
    story(root, '', 'c', { anchors: { x: { file: 'f.ts', range: [5, 6], quote: 'line 5\nline 6' }, y: { file: 'g.ts', range: [5, 6], quote: 'line 5\nline 6' } } });
    drifts.perSidestoryBytes = 400;
    await start();
    expect(await driftOf('c')).toMatchObject({ unchecked: 1 });
  });

  it('reuses a result while every stamp matches, and recomputes after invalidation', async () => {
    await start();
    await driftOf('a');
    const reads = codeReads('f.ts');
    drift.invalidateAll();
    expect(drift.get(entry('a'))).toBeUndefined(); // dirty: recomputed, not shown stale
    await driftOf('a');
    expect(codeReads('f.ts')).toBe(reads); // stamps matched: no code read
  });

  it('an edit to an anchored file makes it dirty; the new drift reflects the change', async () => {
    await start();
    await driftOf('b');
    write(join(root, 'f.ts'), code(50, 'other'));
    events.documentChanged.fire({ document: { uri: Uri.file(join(root, 'f.ts')) }, contentChanges: [{}] });
    expect(drift.get(entry('b'))).toBeUndefined();
    await waitFor(() => drift.peek(entry('b').key)?.lost === 1);
  });

  it('prefers the live states of a sidestory open in a panel', async () => {
    await start();
    drift.live = (k) => (k === entry('b').key ? { outOfDate: 7, lost: 0, unchecked: 0 } : undefined);
    expect(drift.get(entry('b'))).toEqual({ outOfDate: 7, lost: 0, unchecked: 0 });
  });
});

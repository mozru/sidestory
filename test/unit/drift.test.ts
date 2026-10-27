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
  Object.assign(limits, savedIndex, { debounceMs: 20 });
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

  it('an edit makes every sidestory anchoring the file dirty, past the per-file anchor cap too', async () => {
    limits.anchorsPerFile = 2; // a's anchors fill f.ts's table: b has none in it
    await start();
    expect(index.anchorsIn(uriKey(Uri.file(join(root, 'f.ts')) as never)).map((s) => s.entry.ref.name)).toEqual(['a', 'a']);
    await driftOf('b');
    write(join(root, 'f.ts'), code(50, 'other'));
    events.documentChanged.fire({ document: { uri: Uri.file(join(root, 'f.ts')) }, contentChanges: [{}] });
    expect(drift.get(entry('b'))).toBeUndefined(); // dirty: not shown stale
    await waitFor(() => drift.peek(entry('b').key)?.lost === 1);
  });

  it('an unsaved document counts at its real size, and closing it without saving counts the file again', async () => {
    write(join(root, 'g.ts'), code(50));
    story(root, '', 'c', { anchors: { x: { file: 'f.ts', range: [5, 6], quote: 'line 5\nline 6' }, y: { file: 'g.ts', range: [5, 6], quote: 'line 5\nline 6' } } });
    drifts.perSidestoryBytes = 400;
    await start();
    const doc = { uri: Uri.file(join(root, 'g.ts')), isDirty: true, version: 7, lineCount: 51, offsetAt: () => code(50).length, getText: () => code(50) };
    workspace.textDocuments = [doc as never];
    // Past the per-sidestory budget as the buffer is (a size made from the version alone slipped past it).
    expect(await driftOf('c')).toEqual({ outOfDate: 0, lost: 0, unchecked: 1 });
    workspace.textDocuments = [];
    events.documentClosed.fire(doc);
    expect(drift.get(entry('c'))).toBeUndefined(); // dirty: recomputed from the file
  });

  it('an unsaved document over the file limit is not copied to be measured', async () => {
    story(root, '', 'd', { anchors: { x: { file: 'f.ts', range: [5, 6], quote: 'line 5\nline 6' } } });
    drifts.fileBytes = 100;
    await start();
    const getText = vi.fn(() => code(50));
    workspace.textDocuments = [{ uri: Uri.file(join(root, 'f.ts')), isDirty: true, version: 3, lineCount: 51, offsetAt: () => code(50).length, getText } as never];
    expect(await driftOf('d')).toEqual({ outOfDate: 0, lost: 0, unchecked: 1 });
    expect(getText).not.toHaveBeenCalled();
  });

  it('prefers the live states of a sidestory open in a panel', async () => {
    await start();
    drift.live = (k) => (k === entry('b').key ? { outOfDate: 7, lost: 0, unchecked: 0 } : undefined);
    expect(drift.get(entry('b'))).toEqual({ outOfDate: 7, lost: 0, unchecked: 0 });
  });

  it('an invalidation that arrives while drift is being computed keeps the result dirty', async () => {
    write(join(root, 'f.ts'), code(20));
    story(root, '', 'b', { anchors: { x: { file: 'f.ts', range: [1, 2] } } });
    await start();
    const e = entry('b');
    await driftOf('b'); // cached and clean
    const d = drift as unknown as { compute(e: unknown): Promise<unknown> };
    const real = d.compute.bind(drift);
    d.compute = async (x) => {
      const r = await real(x);
      drift.invalidateAll(); // the file changed meanwhile
      return r;
    };
    drift.invalidateAll();
    expect(drift.get(e)).toBeUndefined(); // dirty: asks again
    await new Promise<void>((resolve) => {
      const sub = drift.onDidChange((k) => {
        if (k === e.key) {
          sub.dispose();
          resolve();
        }
      });
    });
    d.compute = real;
    // The mark made during the computation survived it.
    expect((drift as unknown as { dirty: Map<string, number> }).dirty.has(e.key)).toBe(true);
  });

  it('asks nothing for a sidestory the index hasn’t read yet, and keeps short stamps', async () => {
    write(join(root, 'f.ts'), code(20));
    story(root, '', 'b', { anchors: { x: { file: 'f.ts', range: [1, 2] } } });
    await start();
    const e = entry('b');
    const stamp = e.manifestStamp;
    e.manifestStamp = undefined;
    let fired = 0;
    drift.onDidChange(() => fired++);
    expect(drift.get(e)).toBeUndefined();
    await new Promise((r) => setTimeout(r, 50));
    expect(fired).toBe(0);
    e.manifestStamp = stamp;
    await driftOf('b');
    const cached = (drift as unknown as { cache: Map<string, { stamp: string }> }).cache.get(e.key)!;
    expect(cached.stamp.length).toBeLessThan(80);
  });
});

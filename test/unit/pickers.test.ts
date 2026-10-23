// Open Sidestory and Go to Step (docs/NAVIGATION-PLAN.md §9, §10, §12.1).
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { code, story, tempRoot, waitFor, write } from './nav-fixtures.ts';
import { quickPicks, type StubQuickPick, Uri, workspace } from './vscode-stub.ts';

vi.mock('vscode', () => import('./vscode-stub.ts'));

const { SidestoryIndex, INDEX_LIMITS } = await import('../../src/extension/nav/index.ts');
const { SidestoryWatcher } = await import('../../src/extension/nav/watcher.ts');
const { goToStep, pickSidestory, treeOrder, PICK_LIMITS, SCOPE_KEY } = await import('../../src/extension/nav/pickers.ts');
const { uriKey } = await import('../../src/extension/explainers.ts');

const limits = INDEX_LIMITS as unknown as Record<string, number>;
const pick = PICK_LIMITS as unknown as Record<string, number>;
const saved = { ...limits };
const savedPick = { ...pick };
let root = '';
let index: InstanceType<typeof SidestoryIndex>;
const owned: { dispose(): void }[] = [];
let memory: Record<string, unknown> = {};
const memento = { get: (k: string, d?: unknown) => (k in memory ? memory[k] : d), update: async (k: string, v: unknown) => void (memory[k] = v) };

const entry = (pkg: string, name: string) => index.entry(uriKey(Uri.file(join(root, pkg, '.sidestory', name)) as never))!;
const dirStr = (pkg: string, name: string) => Uri.file(join(root, pkg, '.sidestory', name)).toString();

async function start() {
  const watcher = new SidestoryWatcher();
  index = new SidestoryIndex(watcher);
  owned.push(index, watcher);
  await index.refresh();
}

/** The quick pick the call just showed (it appears asynchronously). */
async function shown(): Promise<StubQuickPick> {
  const before = quickPicks.length;
  await waitFor(() => quickPicks.length > before - 1 && !!quickPicks.at(-1)?.shown);
  return quickPicks.at(-1)!;
}

/** Runs a picker, lets `inspect` look at it, then accepts the item `choose` returns (or hides it). */
async function run<T>(open: () => Promise<T>, inspect: (qp: StubQuickPick) => unknown = () => undefined): Promise<T> {
  quickPicks.length = 0;
  const p = open();
  await waitFor(() => !!quickPicks.at(-1)?.shown);
  const qp = quickPicks.at(-1)!;
  const choice = await inspect(qp);
  if (choice) qp.accept(choice);
  else qp.hide();
  return p;
}

function workspaceWithTwoPackages() {
  write(join(root, 'f.ts'), code(50));
  write(join(root, 'svc/x.ts'), code(50));
  write(join(root, 'svc/other.ts'), code(50));
  story(root, '', 'overview', { title: 'Overview', anchors: { o1: { file: 'f.ts', range: [1, 2] } }, details: ['d1', 'd2'] });
  story(root, '', 'd1', { title: 'D1', anchors: { x1: { file: 'f.ts', range: [3, 4] } }, details: ['d3'] });
  story(root, '', 'd2', { title: 'D2', summary: 'Second detail.', anchors: { x2: { file: 'f.ts', range: [5, 6] } } });
  story(root, '', 'd3', { title: 'D3 $(alert)', anchors: { x3: { file: 'f.ts', range: [7, 8] } }, details: ['d1'] });
  story(root, '', 'g1', { title: 'Grouped', group: 'Storage', anchors: { g: { file: 'f.ts', range: [9, 9] } } });
  story(root, '', 'lone', { title: 'Alone', anchors: { l1: { file: 'svc/x.ts', range: [1, 3] } } });
  story(root, 'svc', 'svc-a', { title: 'Service A', anchors: { s1: { file: 'x.ts', range: [10, 12] }, s2: { file: 'x.ts', range: [20, 22] } } });
}

beforeAll(() => {
  limits.debounceMs = 20;
});

beforeEach(() => {
  root = tempRoot('cx-pick-');
  workspace.root = Uri.file(root);
  workspace.textDocuments = [];
  memory = {};
  quickPicks.length = 0;
});

afterEach(() => {
  for (const d of owned.splice(0)) d.dispose();
  Object.assign(limits, saved, { debounceMs: 20 });
  Object.assign(pick, savedPick);
  rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  Object.assign(limits, saved);
});

describe('tree order', () => {
  it('Start here, then grouped tops, then the rest; each top followed by its details once, in HTML order', async () => {
    workspaceWithTwoPackages();
    await start();
    const order = treeOrder(index).map((e) => e.ref.name);
    const rootPart = order.filter((n) => n !== 'svc-a');
    expect(rootPart).toEqual(['overview', 'd1', 'd3', 'd2', 'g1', 'lone']);
    expect(order).toHaveLength(7);
  });
});

describe('Open Sidestory', () => {
  it('lists recent ones first, then all in tree order, with Top › Detail labels and escaped icon syntax', async () => {
    workspaceWithTwoPackages();
    await start();
    const picked = await run(
      () => pickSidestory(index, [dirStr('', 'd2'), dirStr('', 'gone')]),
      (qp) => {
        const labels = qp.items.map((i) => i.label);
        expect(labels[0]).toBe('Recently opened');
        expect(qp.items[0]!.kind).toBe(-1);
        expect(labels[1]).toBe('Overview › D2');
        expect(qp.items[1]!.detail).toBe('Second detail.');
        expect(labels[2]).toBe('All sidestories');
        expect(labels).toContain('Overview › D1 › D3 \\$(alert)');
        expect(labels.filter((l) => l === 'Overview › D2')).toHaveLength(1);
        expect(qp.matchOnDescription).toBe(true);
        return qp.items.find((i) => i.label === 'Alone');
      },
    );
    expect(picked?.ref.name).toBe('lone');
  });

  it('has no 200 cap', async () => {
    for (let i = 0; i < 230; i++) story(root, '', `s${String(i).padStart(3, '0')}`, { title: `S${i}` });
    await start();
    await run(
      () => pickSidestory(index, []),
      (qp) => {
        expect(qp.items.filter((i) => i.kind !== -1)).toHaveLength(230);
      },
    );
  });

  it('opens the only sidestory directly, and offers Show Sidestories when there are none', async () => {
    story(root, '', 'one', { title: 'One' });
    await start();
    expect((await pickSidestory(index, []))?.ref.name).toBe('one');
    rmSync(join(root, '.sidestory'), { recursive: true });
    await index.refresh();
    expect(await pickSidestory(index, [])).toBeUndefined();
  });
});

describe('Go to Step', () => {
  it('scopes to the file’s packages: the longest prefix plus any package anchoring the file', async () => {
    workspaceWithTwoPackages();
    await start();
    // svc/x.ts is in the svc package and anchored by the root package's "lone".
    const r = await run(
      () => goToStep(index, { fileKey: uriKey(Uri.file(join(root, 'svc/x.ts')) as never), recent: [], memento: memento as never }),
      (qp) => {
        const names = new Set(qp.items.map((i) => (i.entry as { ref: { name: string } }).ref.name));
        expect([...names].sort()).toEqual(['d1', 'd2', 'd3', 'g1', 'lone', 'overview', 'svc-a'].sort());
        return undefined;
      },
    );
    expect(r).toBeUndefined();
    // svc/other.ts: only the svc package.
    await run(
      () => goToStep(index, { fileKey: uriKey(Uri.file(join(root, 'svc/other.ts')) as never), recent: [], memento: memento as never }),
      (qp) => {
        expect(qp.title).toBe('Go to Step: svc');
        expect(qp.items.map((i) => i.label)).toEqual(['Step s1', 'Step s2']);
        expect(qp.items[0]!.description).toBe('Service A · step 1');
        expect(qp.items[0]!.detail).toBe('About s1.');
      },
    );
  });

  it('toggles to all packages, and remembers the choice', async () => {
    workspaceWithTwoPackages();
    await start();
    const r = await run(
      () => goToStep(index, { fileKey: uriKey(Uri.file(join(root, 'svc/other.ts')) as never), recent: [], memento: memento as never }),
      async (qp) => {
        qp.triggerButton();
        expect(qp.title).toBe('Go to Step: All packages');
        return qp.items.find((i) => i.label === 'Step x3');
      },
    );
    expect(r).toMatchObject({ step: 'x3' });
    expect(memory[SCOPE_KEY]).toBe('all');
  });

  it('puts the current panel’s sidestory first, then recent ones', async () => {
    workspaceWithTwoPackages();
    await start();
    await run(
      () => goToStep(index, { current: entry('', 'd2'), recent: [dirStr('', 'lone')], memento: memento as never }),
      (qp) => {
        // No editor: the current panel's package (This package, with two packages).
        expect(qp.items.slice(0, 3).map((i) => i.label)).toEqual(['Step x2', 'Step l1', 'Step o1']);
      },
    );
  });

  it('caps the list (20,000), forcing This package when one is known', async () => {
    workspaceWithTwoPackages();
    await start();
    pick.steps = 3;
    memory[SCOPE_KEY] = 'all';
    await run(
      () => goToStep(index, { recent: [], memento: memento as never }),
      (qp) => {
        expect(qp.items).toHaveLength(3);
        expect(qp.placeholder).toBe('Showing 3 of 8 steps; narrow with This package');
      },
    );
    await run(
      () => goToStep(index, { fileKey: uriKey(Uri.file(join(root, 'svc/other.ts')) as never), recent: [], memento: memento as never }),
      (qp) => {
        expect(qp.title).toBe('Go to Step: svc');
        // Forced: the toggle can't undo it, so it isn't offered, and the placeholder says why.
        expect(qp.buttons).toEqual([]);
        expect(qp.placeholder).toBe('All packages have more than 3 steps: showing this package');
      },
    );
  });

  it('offers the scope toggle only when a package is current, and names no scope with one package', async () => {
    workspaceWithTwoPackages();
    await start();
    memory[SCOPE_KEY] = 'all';
    await run(
      () => goToStep(index, { recent: [], memento: memento as never }),
      (qp) => {
        expect(qp.buttons).toEqual([]);
        expect(qp.title).toBe('Go to Step: All packages');
      },
    );
  });

  it('with a single package, the title is just "Go to Step"', async () => {
    story(root, '', 'one', { title: 'One', anchors: { a: { file: 'f.ts', range: [1, 2] } } });
    await start();
    await run(
      () => goToStep(index, { recent: [], memento: memento as never }),
      (qp) => {
        expect(qp.title).toBe('Go to Step');
        expect(qp.buttons).toEqual([]);
      },
    );
  });

  it('shows anchor ids as provisional items before a page is outlined', async () => {
    workspaceWithTwoPackages();
    limits.scanMsPerBatch = 0;
    limits.followUpMs = 60_000;
    await start();
    await run(
      () => goToStep(index, { only: entry('svc', 'svc-a'), recent: [], memento: memento as never }),
      (qp) => {
        expect(qp.items.map((i) => i.label)).toEqual(['s1', 's2']);
        expect(qp.busy).toBe(true);
        expect(qp.title).toBe('Go to Step: Service A');
      },
    );
  });
});

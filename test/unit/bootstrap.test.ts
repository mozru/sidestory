// The bootstrap (docs/NAVIGATION-PLAN.md §8.1, §12.1): cheap in workspaces without sidestories, and it wakes the
// full extension when the first sidestory appears.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => import('./vscode-stub.ts'));

type Stub = typeof import('./vscode-stub.ts');
type Boot = typeof import('../../src/extension/bootstrap.ts');

let loads = 0;
const memory: Record<string, unknown> = {};
const subscriptions: { dispose(): void }[] = [];
const context = () => ({ subscriptions, workspaceState: { get: (k: string) => memory[k], update: async (k: string, v: unknown) => void (memory[k] = v) } });
let stub: Stub;

/** A fresh bootstrap (its loaded state is per module) over a fresh stub. */
async function fresh(found: string[] = []): Promise<Boot> {
  vi.resetModules();
  // The instance the bootstrap will see (the mock factory's own).
  stub = (await import('vscode')) as unknown as Stub;
  stub.workspace.root = stub.Uri.file('/ws');
  stub.workspace.findFilesImpl = () => found.map((p) => stub.Uri.file(p));
  const boot = await import('../../src/extension/bootstrap.ts');
  // Stand in for dist/full.cjs.
  boot.loader.load = () => {
    loads++;
    return { activateFull: () => ({ commands: {}, deserialize: async () => {}, deactivate() {} }) as never };
  };
  return boot;
}

beforeEach(() => {
  loads = 0;
  for (const k of Object.keys(memory)) delete memory[k];
});

afterEach(() => {
  for (const d of subscriptions.splice(0)) d.dispose();
});

const tick = () => new Promise((r) => setTimeout(r, 15));

describe('bootstrap', () => {
  it('imports nothing heavy: vscode, the glob helpers, its shared constants and the branch probe only', () => {
    const src = readFileSync('src/extension/bootstrap.ts', 'utf8');
    const imports = [...src.matchAll(/^import (?!type )[^;]*? from '([^']+)'/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual(['../core/glob.ts', './bootstrap-shared.ts', './changes/probe.ts', 'vscode'].sort());
    for (const dep of ['src/core/glob.ts', 'src/extension/bootstrap-shared.ts']) expect(readFileSync(dep, 'utf8')).not.toMatch(/^import (?!type )/m);
    // The probe (docs/CHANGES-PLAN.md §9.1) imports vscode and nothing else.
    const probe = [...readFileSync('src/extension/changes/probe.ts', 'utf8').matchAll(/^import (?!type )[^;]*? from '([^']+)'/gm)].map((m) => m[1]);
    expect(probe).toEqual(['vscode']);
  });

  it('in a workspace without sidestories: one watcher, nothing loaded, and fast', async () => {
    const { activate } = await fresh();
    const before = stub.counts.watchers;
    const t0 = performance.now();
    activate(context() as never);
    const took = performance.now() - t0;
    await tick();
    expect(stub.counts.watchers - before).toBe(1);
    expect(loads).toBe(0);
    console.log(`bootstrap activation: ${took.toFixed(2)} ms`);
    expect(took).toBeLessThan(5);
  });

  it('no sidestory, but a branch with commits of its own: the container shows and the full extension loads (CHANGES-PLAN §9.1)', async () => {
    const boot = await fresh();
    boot.probe.branchDiffers = async () => true;
    boot.activate(context() as never);
    await tick();
    expect(loads).toBe(1);
    expect(memory['sidestory.available']).toBe('shown');
  });

  it('no sidestory and no branch: nothing loads', async () => {
    const boot = await fresh();
    boot.probe.branchDiffers = async () => false;
    boot.activate(context() as never);
    await tick();
    expect(loads).toBe(0);
    expect(memory['sidestory.available']).toBeUndefined();
  });

  it('a manifest created in a sidestory folder wakes the full extension and remembers it', async () => {
    const { activate } = await fresh();
    activate(context() as never);
    await tick();
    const w = stub.watchers.find((x) => x.pattern === '**/.sidestory/*/manifest.json')!;
    w.fireCreate(stub.Uri.file('/ws/node_modules/pkg/.sidestory/x/manifest.json')); // excluded
    w.fireCreate(stub.Uri.file('/ws/.sidestory/x/.sidestory/y/manifest.json')); // nested: not a sidestory
    await tick();
    expect(loads).toBe(0);
    w.fireCreate(stub.Uri.file('/ws/.sidestory/first/manifest.json'));
    await tick();
    expect(loads).toBe(1);
    expect(memory['sidestory.available']).toBe(true);
    expect(stub.watchers.find((x) => x.pattern === '**/.sidestory/*/manifest.json')).toBeUndefined(); // its job is done
  });

  it('loads at once where sidestories were seen before', async () => {
    memory['sidestory.available'] = true;
    const { activate } = await fresh();
    activate(context() as never);
    await tick();
    expect(loads).toBe(1);
  });

  it('loads when discovery finds a sidestory already there', async () => {
    const { activate } = await fresh(['/ws/a/.sidestory/x/manifest.json']);
    activate(context() as never);
    await tick();
    expect(loads).toBe(1);
  });

  it('a failed load of full.cjs is retried by the next caller, not remembered', async () => {
    const boot = await fresh();
    let fail = true;
    boot.loader.load = () => {
      loads++;
      if (fail) throw new Error('broken bundle');
      return { activateFull: () => ({ commands: {}, deserialize: async () => {}, deactivate() {} }) as never };
    };
    memory['sidestory.available'] = true;
    boot.activate(context() as never);
    await tick();
    expect(loads).toBe(1);
    fail = false;
    boot.activate(context() as never);
    await tick();
    expect(loads).toBe(2);
  });

  it('does not run activateFull twice when it threw (its partial registrations stay)', async () => {
    const boot = await fresh();
    let activations = 0;
    boot.loader.load = () => {
      loads++;
      return {
        activateFull: () => {
          activations++;
          throw new Error('half started');
        },
      } as never;
    };
    memory['sidestory.available'] = true;
    boot.activate(context() as never);
    await tick();
    boot.activate(context() as never);
    await tick();
    expect(activations).toBe(1);
  });

  it('looksLikeSidestory follows refFromDir’s layout rules', async () => {
    const { looksLikeSidestory } = await fresh();
    const u = (p: string) => stub.Uri.file(p) as never;
    expect(looksLikeSidestory(u('/ws/.sidestory/a/manifest.json'))).toBe(true);
    expect(looksLikeSidestory(u('/ws/svc/.sidestory/a/manifest.json'))).toBe(true);
    expect(looksLikeSidestory(u('/ws/.sidestory/manifest.json'))).toBe(false);
    expect(looksLikeSidestory(u('/ws/.sidestory/a/b/manifest.json'))).toBe(false);
    expect(looksLikeSidestory(u('/elsewhere/.sidestory/a/manifest.json'))).toBe(false);
    expect(looksLikeSidestory(u('/ws/.sidestory/a/.sidestory/b/manifest.json'))).toBe(false);
  });
});

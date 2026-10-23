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
  it('imports nothing heavy: vscode, the glob helpers and its shared constants only', () => {
    const src = readFileSync('src/extension/bootstrap.ts', 'utf8');
    const imports = [...src.matchAll(/^import (?!type )[^;]*? from '([^']+)'/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual(['../core/glob.ts', './bootstrap-shared.ts', 'vscode'].sort());
    for (const dep of ['src/core/glob.ts', 'src/extension/bootstrap-shared.ts']) expect(readFileSync(dep, 'utf8')).not.toMatch(/^import (?!type )/m);
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

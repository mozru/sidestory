// The Sidestories view's items (docs/NAVIGATION-PLAN.md §8.2–§8.3): "also under" names the other place, leaves
// nested too deep open on the primary path, and Start here is revealed where it is listed.
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { story, tempRoot } from './nav-fixtures.ts';
import { Uri, workspace } from './vscode-stub.ts';

vi.mock('vscode', () => import('./vscode-stub.ts'));

const { SidestoryIndex } = await import('../../src/extension/nav/index.ts');
const { SidestoryWatcher } = await import('../../src/extension/nav/watcher.ts');
const { DriftQueue } = await import('../../src/extension/nav/drift.ts');
const { SidestoryTree } = await import('../../src/extension/nav/tree.ts');

let root = '';
const owned: { dispose(): void }[] = [];
const memento = { get: (_k: string, d: unknown) => d, update: async () => {}, keys: () => [] } as never;

async function build() {
  const watcher = new SidestoryWatcher();
  const index = new SidestoryIndex(watcher);
  const drift = new DriftQueue(index);
  const tree = new SidestoryTree(index, drift, memento);
  owned.push(tree, drift, index, watcher);
  await index.refresh();
  return { index, tree };
}

type Node = Parameters<InstanceType<typeof SidestoryTree>['getTreeItem']>[0];
const label = (tree: InstanceType<typeof SidestoryTree>, n: Node) => {
  const l = tree.getTreeItem(n).label as string | { label: string };
  return typeof l === 'string' ? l : l.label;
};

beforeEach(() => {
  root = tempRoot('cx-tree-');
  workspace.root = Uri.file(root);
});

afterEach(() => {
  for (const d of owned.splice(0)) d.dispose();
  rmSync(root, { recursive: true, force: true });
});

describe('the Sidestories tree', () => {
  it('a grouped detail names its parent at the top level, and its group when nested', async () => {
    story(root, '', 'auth-overview', { title: 'Auth overview', details: ['auth-tokens'] });
    story(root, '', 'auth-tokens', { title: 'Session tokens', group: 'Security' });
    const { tree } = await build();
    const top = tree.getChildren();
    const start = top.find((n) => label(tree, n) === 'Auth overview')!;
    const group = top.find((n) => label(tree, n) === 'Security')!;
    const grouped = tree.getChildren(group)[0]!;
    expect(tree.getTreeItem(grouped).description).toContain('also under Auth overview');
    const nested = tree.getChildren(start)[0]!;
    expect(label(tree, nested)).toBe('Session tokens');
    expect(tree.getTreeItem(nested).description).toContain('also in Security');
    expect(tree.getTreeItem(nested).description).not.toContain('also under Auth overview');
  });

  it('top: true says so too', async () => {
    story(root, '', 'a', { title: 'A', details: ['b'] });
    story(root, '', 'b', { title: 'B', top: true });
    const { tree } = await build();
    const b = tree.getChildren().find((n) => label(tree, n) === 'B')!;
    expect(tree.getTreeItem(b).description).toContain('also under A');
  });

  it('a leaf nested too deep opens on the primary path', async () => {
    const names = Array.from({ length: 18 }, (_, i) => `n${i}`);
    names.forEach((n, i) => story(root, '', n, { title: n.toUpperCase(), details: i + 1 < names.length ? [names[i + 1]!] : [] }));
    const { tree, index } = await build();
    let node = tree.getChildren()[0]!;
    for (let depth = 1; depth < 17; depth++) node = tree.getChildren(node)[0]!;
    expect((node as { kind: string }).kind).toBe('leaf');
    const cmd = tree.getTreeItem(node).command as unknown as { arguments: [{ trail: string[] }] };
    const e = (node as { entry: Parameters<typeof index.primaryPath>[0] }).entry;
    expect(cmd.arguments[0].trail).toEqual(index.primaryPath(e));
    expect(cmd.arguments[0].trail.at(-1)).toBe(e.ref.name);
  });
});

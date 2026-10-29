// The Sidestories view's items (docs/NAVIGATION-PLAN.md §8.2–§8.3): "also under" names the other place, leaves
// nested too deep open on the primary path, and Start here is revealed where it is listed.
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { story, tempRoot } from './nav-fixtures.ts';
import { config, Uri, workspace } from './vscode-stub.ts';

vi.mock('vscode', () => import('./vscode-stub.ts'));

const { SidestoryIndex } = await import('../../src/extension/nav/index.ts');
const { SidestoryWatcher } = await import('../../src/extension/nav/watcher.ts');
const { DriftQueue } = await import('../../src/extension/nav/drift.ts');
const { SidestoryTree } = await import('../../src/extension/nav/tree.ts');
const { branchRows } = await import('../../src/extension/changes/coverage-labels.ts');

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

  it('"This branch" lists its sidestories as their hierarchy: each under its nearest ancestor that explains the branch', async () => {
    story(root, '', 'overview', { title: 'Overview', details: ['mid', 'parser'] });
    story(root, '', 'mid', { title: 'Mid', details: ['deep'] });
    story(root, '', 'deep', { title: 'Deep' });
    story(root, '', 'parser', { title: 'Parser', details: ['lexer'] });
    story(root, '', 'lexer', { title: 'Lexer' });
    story(root, '', 'other', { title: 'Other' });
    const { tree, index } = await build();
    const totals = { changes: 2, explained: 1, trivial: 0, left: 1, needsLook: 0, files: 1 };
    // Details first, as the comparison may list them; "mid" doesn't explain the branch.
    const belonging = ['lexer', 'deep', 'parser', 'other', 'overview'].map((n) => {
      const e = [...index.all()].find((x) => x.ref.name === n)!;
      return { folder: n, title: e.title, base: 'main', dir: e.ref.dir.toString(), totals };
    });
    tree.branch = { branchGroup: () => ({ description: undefined, rows: branchRows({ belonging, totals, hasChanges: true, suggest: true }) }) };
    // Off by default: the view is for finding sidestories.
    expect(tree.getChildren().map((n) => label(tree, n))).not.toContain('This branch');
    config['sidestory.sidebar.thisBranch'] = true;
    onTestFinished(() => void delete config['sidestory.sidebar.thisBranch']);
    tree.refresh();
    const group = tree.getChildren()[0]!;
    expect(label(tree, group)).toBe('This branch');
    const names = (n: Node) => tree.getChildren(n).map((c) => label(tree, c));
    expect(names(group)).toEqual(['Other', 'Overview', 'Copy Prompt: Update the Sidestory for New Changes']);
    const overview = tree.getChildren(group)[1]!;
    expect(names(overview)).toEqual(['Deep', 'Parser']);
    expect(names(tree.getChildren(overview)[1]!)).toEqual(['Lexer']);
    expect(tree.getTreeItem(overview).collapsibleState).toBe(2); // Expanded
    expect(tree.getTreeItem(tree.getChildren(group)[0]!).collapsibleState).toBe(0); // None
    expect(tree.getParent(tree.getChildren(overview)[0]!)).toBe(overview);
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
    expect(cmd.arguments[0].trail).toEqual(index.trail(e));
    expect(cmd.arguments[0].trail).toEqual(names.slice(1, 17));
    expect(cmd.arguments[0].trail.at(-1)).toBe(e.ref.name);
  });

  it('the filter shows a match nested too deep: at the depth cap, down its path from the top', async () => {
    const names = Array.from({ length: 19 }, (_, i) => `n${i}`);
    names.forEach((n, i) => story(root, '', n, { title: `Title ${n}`, details: i + 1 < names.length ? [names[i + 1]!] : [] }));
    const { tree } = await build();
    for (const [q, last] of [
      ['n16', 'n16'], // its own place: the leaf at the cap
      ['n18', 'n16'], // deeper: the path down to the cap
    ] as const) {
      tree.setFilter(q);
      let node = tree.getChildren()[0]!;
      expect(label(tree, node)).toBe('Title n0');
      for (let depth = 1; depth < 17; depth++) {
        const kids = tree.getChildren(node);
        expect(kids, `${q} at depth ${depth}`).toHaveLength(1);
        node = kids[0]!;
      }
      expect((node as { kind: string }).kind).toBe('leaf');
      expect(label(tree, node)).toBe(`Title ${last}`);
    }
  });

  it('reveals a sidestory nested too deep at the leaf the tree lists', async () => {
    const names = Array.from({ length: 19 }, (_, i) => `n${i}`);
    names.forEach((n, i) => story(root, '', n, { title: n, details: i + 1 < names.length ? [names[i + 1]!] : [] }));
    const { tree, index } = await build();
    const e = [...index.all()].find((x) => x.ref.name === 'n18')!;
    // A session whose trail isn't a path from a top (the panel's trail was cut): the primary path is used.
    const node = tree.nodeFor({ ref: e.ref, trailRefs: [e.ref] } as never)!;
    expect((node as { kind: string }).kind).toBe('leaf');
    expect((node as { path: string[] }).path).toEqual(names.slice(0, 17));
    let depth = 0;
    for (let n: unknown = node; n; n = tree.getParent(n as never)) depth++;
    expect(depth).toBe(17);
  });

  it('a filtered group counts the members it shows', async () => {
    story(root, '', 'a', { title: 'Alpha', group: 'Storage' });
    story(root, '', 'b', { title: 'Beta', group: 'Storage' });
    story(root, '', 'c', { title: 'Gamma', group: 'Storage' });
    const { tree } = await build();
    const group = () => tree.getChildren().find((n) => label(tree, n) === 'Storage')!;
    expect(tree.getTreeItem(group()).description).toBe('3 sidestories');
    tree.setFilter('alpha');
    expect(tree.getTreeItem(group()).description).toBe('1 sidestory');
  });

  it('a filtered package counts its matches', async () => {
    story(root, 'one', 'a', { title: 'Alpha' });
    story(root, 'one', 'b', { title: 'Alpine' });
    story(root, 'one', 'c', { title: 'Gamma' });
    story(root, 'two', 'd', { title: 'Delta' });
    const { tree } = await build();
    const one = () => tree.getChildren().find((n) => (n as { kind: string }).kind === 'package' && (n as { pkg: { entries: Map<string, unknown> } }).pkg.entries.size === 3)!;
    expect(tree.getTreeItem(one()).description).toBe('3 sidestories');
    tree.setFilter('alp');
    expect(tree.getChildren()).toHaveLength(1);
    expect(tree.getTreeItem(one()).description).toBe('2 sidestories');
    tree.setFilter('alpha');
    expect(tree.getTreeItem(one()).description).toBe('1 sidestory');
  });
});

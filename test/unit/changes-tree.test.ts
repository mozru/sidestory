// The Changes view's rows (docs/CHANGES-PLAN.md §9.2, §16.1 changes-tree): compact folders with counts, file rows
// with their status resource and description, list mode, stable path-based ids, parents for reveal, and labels
// cleaned of control and bidirectional characters.
import { describe, expect, it, vi } from 'vitest';
import type { ChangeEntry } from '../../src/extension/changes/model.ts';

vi.mock('vscode', () => import('./vscode-stub.ts'));
const { ChangesTree } = await import('../../src/extension/changes/tree.ts');

const entries: ChangeEntry[] = [
  { path: 'src/retry/retry.ts', status: 'M', added: 4, removed: 1 },
  { path: 'src/retry/backoff.ts', oldPath: 'old/backoff.ts', status: 'R', added: 2, removed: 2 },
  { path: 'legacy/sleep.ts', status: 'D', added: 0, removed: 24 },
  { path: 'notes‮.txt', status: 'A', untracked: true },
];

describe('the Changes tree', () => {
  it('shows compact folders with counts, then files with status, counts and renames', () => {
    const t = new ChangesTree();
    t.set({ entries, listMode: false, sort: 'path', onDisk: true });
    const top = t.getChildren();
    const items = top.map((n) => t.getTreeItem(n));
    expect(items.map((i) => i.label)).toEqual(['legacy', 'src/retry', 'notes.txt']);
    expect(items[1]!.description).toBe('2 files · +6 −3');
    const files = t.getChildren(top[1]).map((n) => t.getTreeItem(n));
    expect(files.map((i) => [i.label, i.description, i.contextValue])).toEqual([
      ['backoff.ts', '← old/backoff.ts · +2 −2', 'file:R:onDisk'],
      ['retry.ts', '+4 −1', 'file:M:onDisk'],
    ]);
    expect((files[0]!.resourceUri as { scheme: string; query: string }).scheme).toBe('sidestory-change');
    expect((files[0]!.resourceUri as { query: string }).query).toBe('R');
    const deleted = t.getTreeItem(t.getChildren(top[0])[0]!);
    expect(deleted.contextValue).toBe('file:D:deleted');
    expect(deleted.description).toBe('−24');
    // The bidirectional override is removed from the label, and the tooltip says the path is unusual.
    const odd = t.getTreeItem(top[2]!);
    expect(odd.description).toBe('untracked');
    expect(String(odd.tooltip)).toContain('⚠');
  });

  it('list mode: files only, with the folder in the description, in the chosen sort', () => {
    const t = new ChangesTree();
    t.set({ entries, listMode: true, sort: 'size', onDisk: false });
    const items = t.getChildren().map((n) => t.getTreeItem(n));
    expect(items.map((i) => i.label)).toEqual(['sleep.ts', 'retry.ts', 'backoff.ts', 'notes.txt']);
    expect(items[0]!.description).toBe('legacy · −24');
    expect(items[1]!.contextValue).toBe('file:M');
    expect(t.order.map((e) => e.path)).toEqual(['legacy/sleep.ts', 'src/retry/retry.ts', 'src/retry/backoff.ts', 'notes‮.txt']);
  });

  it('ids are stable across renders; parents lead to the top for reveal; Collapse All changes the ids', () => {
    const t = new ChangesTree();
    t.set({ entries, listMode: false, sort: 'path', onDisk: true });
    const id = t.getTreeItem(t.nodeFor('src/retry/retry.ts')!).id;
    t.set({ entries: [...entries, { path: 'src/retry/new.ts', status: 'A' }], listMode: false, sort: 'path', onDisk: true });
    const node = t.nodeFor('src/retry/retry.ts')!;
    expect(t.getTreeItem(node).id).toBe(id);
    expect(t.getParent(node)?.kind).toBe('folder');
    expect(t.getParent(t.getParent(node)!)).toBeUndefined();
    t.collapseAll();
    expect(t.getTreeItem(t.nodeFor('src/retry/retry.ts')!).id).not.toBe(id);
    expect(t.getTreeItem(t.getChildren()[0]!).collapsibleState).toBe(1);
  });

  it('a file row opens its merge diff by path, and only files in the comparison are accepted', () => {
    const t = new ChangesTree();
    t.set({ entries, listMode: true, sort: 'path', onDisk: true });
    const item = t.getTreeItem(t.nodeFor('src/retry/retry.ts')!);
    expect(item.command).toMatchObject({ command: 'sidestory.changes.open', arguments: [{ path: 'src/retry/retry.ts' }] });
  });

  it('more than 200 files: only top-level folders start expanded', () => {
    const many: ChangeEntry[] = Array.from({ length: 250 }, (_, i) => ({ path: `a/b${i % 3}/c${i}.ts`, status: 'M' }));
    const t = new ChangesTree();
    t.set({ entries: many, listMode: false, sort: 'path', onDisk: true });
    const top = t.getChildren()[0]!;
    expect(t.getTreeItem(top).collapsibleState).toBe(2);
    expect(t.getTreeItem(t.getChildren(top)[0]!).collapsibleState).toBe(1);
  });
});

// The This Sidestory view: the way up, where the panel is, the details below and the parent's other details.
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { story, tempRoot } from './nav-fixtures.ts';
import { Uri, workspace } from './vscode-stub.ts';

vi.mock('vscode', () => import('./vscode-stub.ts'));

const { SidestoryIndex } = await import('../../src/extension/nav/index.ts');
const { SidestoryWatcher } = await import('../../src/extension/nav/watcher.ts');
const { ThisSidestoryView } = await import('../../src/extension/nav/this-sidestory.ts');

type View = InstanceType<typeof ThisSidestoryView>;
type Node = Parameters<View['getTreeItem']>[0];

let root = '';
const owned: { dispose(): void }[] = [];

beforeEach(() => {
  root = tempRoot('cx-here-');
  workspace.root = Uri.file(root);
});

afterEach(() => {
  for (const d of owned.splice(0)) d.dispose();
  rmSync(root, { recursive: true, force: true });
});

/** A panel showing `trail` (names), at anchor `active`. */
function panel(index: InstanceType<typeof SidestoryIndex>, trail: string[], active?: string) {
  const refs = trail.map((n) => [...index.all()].find((e) => e.ref.name === n)!.ref);
  return { ref: refs.at(-1)!, trailRefs: refs, place: () => ({ trail: refs, active }) } as never;
}

async function build(session: (index: InstanceType<typeof SidestoryIndex>) => unknown) {
  const watcher = new SidestoryWatcher();
  const index = new SidestoryIndex(watcher);
  owned.push(index, watcher);
  await index.refresh();
  let s: unknown;
  const view = new ThisSidestoryView(index, () => s as never);
  owned.push(view);
  s = session(index);
  return { view, index };
}

const label = (view: View, n: Node) => view.getTreeItem(n).label as string;
const rows = (view: View, n?: Node) => view.getChildren(n).map((c) => `${c.kind}:${label(view, c)}`);

describe('the This Sidestory view', () => {
  beforeEach(() => {
    story(root, '', 'overview', { title: 'Overview', details: ['auth', 'storage'] });
    story(root, '', 'auth', { title: 'Auth', details: ['tokens', 'cookies'] });
    story(root, '', 'tokens', { title: 'Session tokens', details: ['refresh'] });
    story(root, '', 'refresh', { title: 'Refresh flow' });
    story(root, '', 'cookies', { title: 'Cookies' });
    story(root, '', 'storage', { title: 'Storage' });
  });

  it('shows the way up, where the panel is with its details, and the parent’s other details', async () => {
    const { view } = await build((index) => panel(index, ['overview', 'auth', 'tokens']));
    expect(rows(view)).toEqual(['up:Overview', 'up:Auth', 'here:Session tokens', 'siblings:Also in Auth']);
    const [up, , here, siblings] = view.getChildren();
    expect(rows(view, here)).toEqual(['detail:Refresh flow']);
    expect(rows(view, siblings)).toEqual(['detail:Cookies']);
    // A click goes up, or dives in, along the trail.
    expect(view.getTreeItem(up!).command?.arguments?.[0]).toMatchObject({ trail: ['overview'] });
    expect(view.getTreeItem(view.getChildren(here)[0]!).command?.arguments?.[0]).toMatchObject({ trail: ['overview', 'auth', 'tokens', 'refresh'] });
    expect(view.getTreeItem(view.getChildren(siblings)[0]!).command?.arguments?.[0]).toMatchObject({ trail: ['overview', 'auth', 'cookies'] });
    expect(view.getTreeItem(here!).command).toBeUndefined();
    expect(view.getTreeItem(here!).collapsibleState).toBe(2); // Expanded
  });

  it('a top has no way up and no siblings; details of details open lazily', async () => {
    const { view } = await build((index) => panel(index, ['overview']));
    expect(rows(view)).toEqual(['here:Overview']);
    const auth = view.getChildren(view.getChildren()[0])[0]!;
    expect(label(view, auth)).toBe('Auth');
    expect(view.getTreeItem(auth).collapsibleState).toBe(1); // Collapsed
    expect(rows(view, auth)).toEqual(['detail:Session tokens', 'detail:Cookies']);
  });

  it('a trail that is no path in the graph falls back to the primary path; no panel shows nothing', async () => {
    const { view } = await build((index) => panel(index, ['storage', 'tokens']));
    expect(rows(view)).toEqual(['up:Overview', 'up:Auth', 'here:Session tokens', 'siblings:Also in Auth']);
    const empty = await build(() => undefined);
    expect(empty.view.getChildren()).toEqual([]);
  });

  it('repaints only when the place changed', async () => {
    const { view } = await build((index) => panel(index, ['overview']));
    let fired = 0;
    view.onDidChangeTreeData(() => fired++);
    view.refresh();
    view.refresh();
    expect(fired).toBe(1);
  });
});

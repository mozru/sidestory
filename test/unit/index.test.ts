// The workspace index (docs/NAVIGATION-PLAN.md §6, §12.1): discovery, watching, budgets, caps, quote slices.
import { rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { code, manifestText, story, tempRoot, waitFor, write } from './nav-fixtures.ts';
import { config, counts, events, findFilesCalls, Uri, watchers, workspace } from './vscode-stub.ts';

vi.mock('vscode', () => import('./vscode-stub.ts'));

const { SidestoryIndex, INDEX_LIMITS } = await import('../../src/extension/nav/index.ts');
const { SidestoryWatcher } = await import('../../src/extension/nav/watcher.ts');
const { uriKey } = await import('../../src/extension/explainers.ts');

type Index = InstanceType<typeof SidestoryIndex>;
const limits = INDEX_LIMITS as unknown as Record<string, number>;
const saved = { ...limits };

let root = '';
let index: Index;
let watcher: InstanceType<typeof SidestoryWatcher>;
const open: { dispose(): void }[] = [];

const key = (p: string) => uriKey(Uri.file(p) as never);
const dirOf = (pkg: string, name: string) => join(root, pkg, '.sidestory', name);
const entryOf = (pkg: string, name: string) => index.entry(key(dirOf(pkg, name)));
const fire = (kind: 'change' | 'create' | 'delete', path: string) => {
  const w = watchers.find((x) => x.pattern === '**/.sidestory/**')!;
  if (kind === 'change') w.fireChange(Uri.file(path));
  else if (kind === 'create') w.fireCreate(Uri.file(path));
  else w.fireDelete(Uri.file(path));
};

/**
 * Rewrites a file the index has read with text of the same size. The index's stamp is (mtime in ms, size), and a
 * rewrite moments later may keep the mtime: within the same millisecond, or on NTFS, whose timestamps follow a clock
 * that ticks every ~16 ms. A later mtime, as an edit by hand has, makes the change visible.
 */
function edit(path: string, text: string): void {
  const before = statSync(path).mtimeMs / 1000;
  write(path, text);
  utimesSync(path, before + 5, before + 5);
}

async function start(): Promise<Index> {
  watcher = new SidestoryWatcher();
  index = new SidestoryIndex(watcher);
  open.push(index, watcher);
  await index.refresh();
  return index;
}

beforeAll(() => {
  limits.debounceMs = 20;
  limits.debounceMaxMs = 100;
});

beforeEach(() => {
  root = tempRoot('cx-index-');
  workspace.root = Uri.file(root);
  workspace.textDocuments = [];
  workspace.findFilesImpl = undefined;
  findFilesCalls.length = 0;
  for (const k of Object.keys(config)) delete config[k];
});

afterEach(() => {
  for (const d of open.splice(0)) d.dispose();
  Object.assign(limits, saved, { debounceMs: 20, debounceMaxMs: 100 });
  rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  Object.assign(limits, saved);
});

describe('discovery', () => {
  it('reads titles, outlines, groups and the detail graph per package', async () => {
    write(join(root, 'src/a.ts'), code(40));
    story(root, '', 'overview', { title: 'Overview', anchors: { one: { file: 'src/a.ts', range: [1, 5] } }, details: ['detail', 'missing'] });
    story(root, '', 'detail', { title: 'Detail', summary: 'A detail.', anchors: { two: { file: 'src/a.ts', range: [10, 12] }, three: { file: 'src/a.ts', range: [20, 30] } } });
    story(root, 'svc', 'other', { title: 'Other', group: 'Storage', anchors: {} });
    await start();
    expect(index.state).toBe('ready');
    expect(index.size).toBe(3);
    expect(index.packages().map((p) => p.label).sort()).toEqual([basename(root), 'svc'].sort());
    const d = entryOf('', 'detail')!;
    expect(d.title).toBe('Detail');
    expect(d.steps.map((s) => s.title)).toEqual(['Step two', 'Step three']);
    expect(index.pathLabel(d)).toBe('Overview › Detail');
    expect(index.packageOf(entryOf('', 'overview')!)!.graph.brokenLinks('overview')).toEqual(['missing']);
    expect(entryOf('svc', 'other')!.group).toBe('Storage');
    expect(index.stepCount(d.ref.dir as never)).toBe(2);
    const fileKey = key(join(root, 'src/a.ts'));
    expect(index.isAnchored(fileKey)).toBe(true);
    expect(index.anchorsIn(fileKey)).toHaveLength(3);
    expect(index.anchorsCovering(fileKey, 11, 21).map((s) => s.entry.ids[s.index]).sort()).toEqual(['three', 'two']);
    expect(index.anchorsCovering(fileKey, 6, 9)).toEqual([]);
    expect(index.packagesForFile(fileKey).size).toBe(1);
  });

  it("a base-side anchor isn't on the working file's lines, and the manifest id is kept", async () => {
    write(join(root, 'src/a.ts'), code(40));
    const dir = story(root, '', 'branch', { title: 'Branch', anchors: { now: { file: 'src/a.ts', range: [1, 5] }, gone: { file: 'src/a.ts', range: [10, 12] } } });
    write(join(dir, 'manifest.json'), JSON.stringify({ version: 3, id: '01JC0AANDED00000000000000A', title: 'Branch', base: 'main', anchors: { now: { file: 'src/a.ts', range: [1, 5] }, gone: { file: 'src/a.ts', side: 'base', range: [10, 12] } } }));
    await start();
    const fileKey = key(join(root, 'src/a.ts'));
    expect(index.anchorsIn(fileKey).map((s) => s.entry.ids[s.index])).toEqual(['now']);
    expect(index.anchorsCovering(fileKey, 10, 12)).toEqual([]);
    expect(entryOf('', 'branch')!.id).toBe('01JC0AANDED00000000000000A');
  });

  it('keeps a stable cut: the first by path, whatever order findFiles returns', async () => {
    limits.sidestories = 10;
    const all: string[] = [];
    for (let i = 0; i < 30; i++) all.push(story(root, '', `s${String(i).padStart(2, '0')}`, { title: `S${i}` }));
    let seed = 3;
    workspace.findFilesImpl = () => {
      const shuffled = [...all].sort(() => ((seed = (seed * 16807) % 2147483647) % 3) - 1);
      return shuffled.map((d) => Uri.file(join(d, 'manifest.json')));
    };
    await start();
    expect(index.size).toBe(10);
    expect([...index.all()].map((e) => e.ref.name).sort()).toEqual(all.slice(0, 10).map((d) => basename(d)).sort());
    expect(index.discoveryCut).toEqual({ found: 30, atLeast: false });
    await index.refresh(); // another order, the same cut
    expect([...index.all()].map((e) => e.ref.name).sort()).toEqual(all.slice(0, 10).map((d) => basename(d)).sort());
  });

  it('passes the merged exclusions to findFiles: true entries only, braces expanded, never nested', async () => {
    config['files.exclude'] = { '**/gen': true, '**/keep': false, '**/*.js': { when: 'x' }, 'docs/{a,b}': true };
    await start();
    const exclude = String(findFilesCalls.at(-1)![1]);
    expect(exclude).toContain('**/gen/**');
    expect(exclude).toContain('docs/a/**');
    expect(exclude).toContain('docs/b/**');
    expect(exclude).toContain('**/node_modules/**');
    expect(exclude).not.toContain('keep');
    expect(exclude).not.toContain('*.js');
    expect(exclude.slice(1, -1)).not.toMatch(/[{}]/);
    expect(findFilesCalls.at(-1)![2]).toBe(20_000);
  });

  it('is empty, not ready, in a workspace without sidestories', async () => {
    await start();
    expect(index.state).toBe('empty');
  });
});

describe('watching', () => {
  it('re-reads a changed manifest, adds a created sidestory, and removes deleted folders', async () => {
    story(root, '', 'a', { title: 'A' });
    await start();
    write(join(dirOf('', 'a'), 'manifest.json'), manifestText({ title: 'A2' }));
    fire('change', join(dirOf('', 'a'), 'manifest.json'));
    await waitFor(() => entryOf('', 'a')!.title === 'A2');
    story(root, '', 'b', { title: 'B' });
    fire('create', join(dirOf('', 'b'), 'manifest.json'));
    await waitFor(() => entryOf('', 'b')?.title === 'B');
    // The whole Sidestory folder deleted: everything under it goes.
    rmSync(join(root, '.sidestory'), { recursive: true });
    fire('delete', join(root, '.sidestory'));
    expect(index.size).toBe(0);
  });

  it('a page edit that leaves the outline alone is only a re-read, not a change; a new step title is', async () => {
    const anchors = { x: { file: 'a.ts', range: [1, 2] as [number, number] } };
    const html = (title: string, prose: string) => `<section data-explain-anchor="x"><h2>${title}</h2><p>About x.</p><p>${prose}</p></section>`;
    story(root, '', 'a', { title: 'A', anchors, html: html('Step x', 'Some prose.') });
    await start();
    let changes = 0;
    let rereads = 0;
    index.onDidChange(() => changes++);
    index.onDidRereadPages(() => rereads++);
    const page = join(dirOf('', 'a'), 'sidestory.html');
    const stamp = entryOf('', 'a')!.pageStamp;
    edit(page, html('Step x', 'Reworded prose, a little longer.'));
    fire('change', page);
    await waitFor(() => entryOf('', 'a')!.pageStamp !== stamp);
    await new Promise((r) => setTimeout(r, 150));
    expect([changes, rereads]).toEqual([0, 1]);
    expect(entryOf('', 'a')!.steps.map((s) => s.title)).toEqual(['Step x']);
    expect(entryOf('', 'a')!.state).toBe('ready');
    edit(page, html('Renamed', 'Reworded prose, a little longer.'));
    fire('change', page);
    await waitFor(() => changes > 0);
    expect(entryOf('', 'a')!.steps.map((s) => s.title)).toEqual(['Renamed']);
  });

  it('coalesces folder deletes: one change event, only the packages they touched rebuilt', async () => {
    story(root, 'p1', 'a', { title: 'A' });
    story(root, 'p2', 'b', { title: 'B' });
    story(root, 'p3', 'c', { title: 'C', details: ['c2'] });
    story(root, 'p3', 'c2', { title: 'C2' });
    story(root, 'p4', 'd', { title: 'D' });
    await start();
    const graphOf = (p: string) => index.packages().find((x) => uriKey(x.folder) === key(join(root, p, '.sidestory')))?.graph;
    const before = { p3: graphOf('p3'), p4: graphOf('p4') };
    const fired: Set<string>[] = [];
    index.onDidChange((ev) => fired.push(new Set(ev.packages)));
    rmSync(join(root, 'p1', '.sidestory'), { recursive: true });
    fire('delete', join(root, 'p1', '.sidestory'));
    rmSync(dirOf('p3', 'c2'), { recursive: true });
    fire('delete', dirOf('p3', 'c2'));
    events.filesDeleted.fire({ files: [Uri.file(join(root, 'p2'))] });
    // Gone from lookups at once; the graphs and the event come with the batch.
    expect([...index.all()].map((e) => e.ref.name).sort()).toEqual(['c', 'd']);
    expect(fired).toHaveLength(0);
    await waitFor(() => fired.length > 0);
    await new Promise((r) => setTimeout(r, 150));
    expect(fired).toHaveLength(1);
    expect(fired[0]!.size).toBe(3); // p1, p2 and p3
    expect(graphOf('p4')).toBe(before.p4);
    expect(graphOf('p3')).not.toBe(before.p3);
    expect(graphOf('p3')!.children('c')).toEqual([]);
  });

  it('removes sidestories under a folder deleted inside VS Code (an ancestor)', async () => {
    story(root, 'services/auth', 'x', { title: 'X' });
    story(root, '', 'y', { title: 'Y' });
    await start();
    events.filesDeleted.fire({ files: [Uri.file(join(root, 'services'))] });
    expect([...index.all()].map((e) => e.ref.name)).toEqual(['y']);
  });

  it('reconciles deletes nobody reported, at most every 30 s unless forced', async () => {
    story(root, 'a', 'x', { title: 'X' });
    story(root, 'b', 'y', { title: 'Y' });
    story(root, 'c', 'z', { title: 'Z' });
    await start();
    rmSync(join(root, 'a'), { recursive: true });
    events.windowState.fire({ focused: true });
    await waitFor(() => !entryOf('a', 'x'));
    rmSync(join(root, 'b'), { recursive: true });
    await index.reconcile(); // throttled
    expect(entryOf('b', 'y')).toBeDefined();
    await index.reconcile(true); // a git HEAD change
    expect(entryOf('b', 'y')).toBeUndefined();
    expect(entryOf('c', 'z')).toBeDefined();
  });

  it('turns a burst of 300 events into one batch', async () => {
    story(root, '', 'a', { title: 'A' });
    await start();
    let changes = 0;
    index.onDidChange(() => changes++);
    const manifest = join(dirOf('', 'a'), 'manifest.json');
    write(manifest, manifestText({ title: 'Burst' }));
    const before = counts.readPaths.filter((p) => p.endsWith('/a/manifest.json')).length;
    for (let i = 0; i < 300; i++) fire('change', manifest);
    await waitFor(() => entryOf('', 'a')!.title === 'Burst');
    await new Promise((r) => setTimeout(r, 150));
    expect(counts.readPaths.filter((p) => p.endsWith('/a/manifest.json')).length - before).toBe(1);
    expect(changes).toBe(1);
  });

  it('reads an open, dirty manifest from its buffer', async () => {
    story(root, '', 'a', { title: 'On disk' });
    await start();
    const uri = Uri.file(join(dirOf('', 'a'), 'manifest.json'));
    const doc = { uri, isDirty: true, version: 7, isClosed: false, getText: () => manifestText({ title: 'In the buffer' }) };
    workspace.textDocuments = [doc];
    events.documentChanged.fire({ document: doc, contentChanges: [{}] });
    await waitFor(() => entryOf('', 'a')!.title === 'In the buffer');
    expect(entryOf('', 'a')!.manifestStamp).toBe('d7');
  });

  it('drops a read that a newer change overtook', async () => {
    story(root, '', 'a', { title: 'First' });
    await start();
    const manifest = join(dirOf('', 'a'), 'manifest.json');
    const fs = workspace.fs as { readFile: (u: Uri) => Promise<Uint8Array> };
    const real = fs.readFile;
    let raced = false;
    fs.readFile = async (u: Uri) => {
      const bytes = await real(u);
      if (!raced && u.path.endsWith('/a/manifest.json')) {
        raced = true;
        // While this read is in flight, the file changes again.
        write(manifest, manifestText({ title: 'Third' }));
        fire('change', manifest);
      }
      return bytes;
    };
    try {
      write(manifest, manifestText({ title: 'Second' }));
      fire('change', manifest);
      await waitFor(() => entryOf('', 'a')!.title === 'Third');
      expect(raced).toBe(true);
    } finally {
      fs.readFile = real;
    }
  });

  it('keeps the file map current when anchors move to another file', async () => {
    write(join(root, 'a.ts'), code(10));
    write(join(root, 'b.ts'), code(10));
    story(root, '', 's', { anchors: { x: { file: 'a.ts', range: [1, 2] } } });
    await start();
    expect(index.isAnchored(key(join(root, 'a.ts')))).toBe(true);
    edit(join(dirOf('', 's'), 'manifest.json'), manifestText({ anchors: { x: { file: 'b.ts', range: [1, 2] } } }));
    fire('change', join(dirOf('', 's'), 'manifest.json'));
    await waitFor(() => index.isAnchored(key(join(root, 'b.ts'))));
    expect(index.isAnchored(key(join(root, 'a.ts')))).toBe(false);
    expect(index.anchorsIn(key(join(root, 'a.ts')))).toEqual([]);
  });

  it('dispose leaves no watchers or listeners', async () => {
    const before = counts.watchers;
    story(root, '', 'a', {});
    await start();
    expect(counts.watchers).toBe(before + 1);
    for (const d of open.splice(0)) d.dispose();
    expect(counts.watchers).toBe(before);
    expect(Object.values(events).reduce((n, e) => n + e.listeners.size, 0)).toBe(0);
  });
});

describe('budgets and caps', () => {
  it('stops at the per-batch byte budget, says so, and reads the rest in a follow-up batch', async () => {
    for (let i = 0; i < 4; i++) story(root, '', `s${i}`, { title: `S${i}` });
    const size = statSync(join(dirOf('', 's0'), 'manifest.json')).size;
    limits.manifestBytesPerBatch = size * 2 + 1;
    limits.followUpMs = 50;
    await start();
    const states = () => [...index.all()].map((e) => e.state);
    expect(states().filter((s) => s === 'not-read')).toHaveLength(2);
    limits.manifestBytesPerBatch = saved.manifestBytesPerBatch!;
    await waitFor(() => states().every((s) => s === 'ready'));
  });

  it('stops outlining at the per-batch scan-time budget', async () => {
    for (let i = 0; i < 3; i++) story(root, '', `s${i}`, { title: `S${i}` });
    limits.scanMsPerBatch = 0;
    limits.followUpMs = 60_000;
    await start();
    expect([...index.all()].every((e) => e.state === 'not-outlined' && !e.outlined)).toBe(true);
  });

  it('outlines pages skipped by the budget in a follow-up, even when their manifests were read', async () => {
    for (let i = 0; i < 3; i++) story(root, '', `s${i}`, { title: `S${i}` });
    limits.scanMsPerBatch = 0;
    limits.followUpMs = 50;
    await start();
    expect([...index.all()].every((e) => e.title && !e.outlined)).toBe(true); // manifests read, pages not
    limits.scanMsPerBatch = saved.scanMsPerBatch!;
    await waitFor(() => [...index.all()].every((e) => e.outlined && e.state === 'ready'));
  });

  it('caches the sorted package list until packages change', async () => {
    story(root, '', 'a', {});
    story(root, 'svc', 'b', {});
    await start();
    const first = index.packages();
    expect(index.packages()).toBe(first);
    expect(index.packageCount).toBe(2);
    expect(index.packageByKey(first[0]!.key)).toBe(first[0]);
    story(root, 'other', 'c', {});
    fire('create', join(dirOf('other', 'c'), 'manifest.json'));
    await waitFor(() => index.packageCount === 3);
    expect(index.packages()).not.toBe(first);
    expect(index.packages()).toHaveLength(3);
  });

  it('labels a long primary path by its first and last two titles', async () => {
    const names = Array.from({ length: 30 }, (_, i) => `n${i}`);
    names.forEach((n, i) => story(root, '', n, { title: `T${i}`, details: i + 1 < names.length ? [names[i + 1]!] : [] }));
    await start();
    const last = entryOf('', 'n29')!;
    // Anchored at the top: the label starts at the real top, and the trail is the last 16 names.
    expect(index.primaryPath(last)).toEqual(names.slice(0, 16));
    expect(index.trail(last)).toEqual(names.slice(14));
    expect(index.pathLabel(last)).toBe('T0 › … › T28 › T29');
    expect(index.pathLabel(entryOf('', 'n2')!)).toBe('T0 › T1 › T2');
    expect(index.pathLabel(entryOf('', 'n3')!)).toBe('T0 › … › T2 › T3');
  });

  it('drops step ids that aren’t anchor ids', async () => {
    story(root, '', 'a', { html: '<section data-explain-anchor="ok"><h2>A</h2></section><section data-explain-anchor="9 bad id"><h2>B</h2></section>' });
    await start();
    expect(entryOf('', 'a')!.steps.map((s) => s.id)).toEqual(['ok']);
  });

  it('clears the capped flag once a re-read fits, without a refresh', async () => {
    limits.anchors = 1;
    write(join(root, 'f.ts'), code(10));
    story(root, '', 'a', { anchors: { x: { file: 'f.ts', range: [1, 2] }, y: { file: 'f.ts', range: [3, 4] } } });
    await start();
    expect(index.capped).toBe(true);
    write(join(dirOf('', 'a'), 'manifest.json'), manifestText({ anchors: { x: { file: 'f.ts', range: [1, 2] } } }));
    fire('change', join(dirOf('', 'a'), 'manifest.json'));
    await waitFor(() => !index.capped);
    expect(entryOf('', 'a')!.capped).toBe(false);
  });

  it('forgets interned files nothing anchors any more', async () => {
    write(join(root, 'f.ts'), code(10));
    write(join(root, 'g.ts'), code(10));
    story(root, '', 'a', { anchors: { x: { file: 'f.ts', range: [1, 2] } } });
    await start();
    expect(index.stats().files).toBe(1);
    edit(join(dirOf('', 'a'), 'manifest.json'), manifestText({ anchors: { x: { file: 'g.ts', range: [1, 2] } } }));
    fire('change', join(dirOf('', 'a'), 'manifest.json'));
    await waitFor(() => index.isAnchored(key(join(root, 'g.ts'))));
    expect(index.isAnchored(key(join(root, 'f.ts')))).toBe(false);
    expect(index.stats().files).toBe(1);
  });

  it('judges caps afresh on a refresh', async () => {
    limits.anchors = 1;
    write(join(root, 'f.ts'), code(10));
    story(root, '', 'a', { anchors: { x: { file: 'f.ts', range: [1, 2] }, y: { file: 'f.ts', range: [3, 4] } } });
    await start();
    expect(index.capped).toBe(true);
    limits.anchors = saved.anchors!;
    write(join(dirOf('', 'a'), 'manifest.json'), manifestText({ anchors: { x: { file: 'f.ts', range: [1, 2] } } }));
    await index.refresh();
    expect(index.capped).toBe(false);
  });

  it('keeps a cap that still bites across a refresh where nothing changed', async () => {
    limits.anchors = 1;
    write(join(root, 'f.ts'), code(10));
    story(root, '', 'a', { anchors: { x: { file: 'f.ts', range: [1, 2] }, y: { file: 'f.ts', range: [3, 4] } } });
    await start();
    expect(index.capped).toBe(true);
    await index.refresh(); // every read is 'same': no commit, but the cap is still there
    expect(entryOf('', 'a')!.capped).toBe(true);
    expect(index.capped).toBe(true);
  });

  it('a sidestory whose manifest can’t be read still ends outlined (nothing waits on it)', async () => {
    const outside = tempRoot('cx-outside-');
    try {
      write(join(outside, 'manifest.json'), manifestText({ title: 'Elsewhere' }));
      story(root, '', 'broken', { title: 'Broken' });
      rmSync(join(dirOf('', 'broken'), 'manifest.json'));
      symlinkSync(join(outside, 'manifest.json'), join(dirOf('', 'broken'), 'manifest.json'));
      await start();
      const e = entryOf('', 'broken')!;
      expect(e.errors.join(' ')).toMatch(/can't be read/);
      expect(e.outlined).toBe(true);
      expect(e.state).toBe('ready');
      expect(e.ids).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('gives each file at most 200 anchors from one sidestory, in-use sidestories first', async () => {
    write(join(root, 'f.ts'), code(600));
    const many: Record<string, { file: string; range: [number, number] }> = {};
    for (let i = 0; i < 500; i++) many[`a${i}`] = { file: 'f.ts', range: [i + 1, i + 1] };
    story(root, '', 'big', { anchors: many });
    story(root, '', 'small', { anchors: { s1: { file: 'f.ts', range: [1, 3] }, s2: { file: 'f.ts', range: [5, 6] } } });
    await start();
    const f = key(join(root, 'f.ts'));
    const slots = index.anchorsIn(f);
    expect(slots.filter((s) => s.entry.ref.name === 'big')).toHaveLength(200);
    expect(slots.filter((s) => s.entry.ref.name === 'small')).toHaveLength(2);
    expect(slots[0]!.entry.ref.name).toBe('big'); // by name, with nothing in use
    expect(slots.map((s) => s.entry.ids[s.index])).toEqual(index.anchorsIn(f).map((s) => s.entry.ids[s.index])); // deterministic
    // A sidestory in use comes first (the table is rebuilt on the next change).
    index.priority = (k) => (k === entryOf('', 'small')!.key ? 0 : 1);
    edit(join(dirOf('', 'small'), 'manifest.json'), manifestText({ anchors: { s1: { file: 'f.ts', range: [1, 4] }, s2: { file: 'f.ts', range: [5, 6] } } }));
    fire('change', join(dirOf('', 'small'), 'manifest.json'));
    await waitFor(() => index.anchorsIn(f)[0]?.entry.ref.name === 'small');
  });

  it('caps a file’s anchors at 2,000 in all', async () => {
    limits.anchorsPerFile = 250;
    write(join(root, 'f.ts'), code(600));
    for (const n of ['a', 'b']) {
      const many: Record<string, { file: string; range: [number, number] }> = {};
      for (let i = 0; i < 200; i++) many[`x${i}`] = { file: 'f.ts', range: [i + 1, i + 1] };
      story(root, '', n, { anchors: many });
    }
    await start();
    const slots = index.anchorsIn(key(join(root, 'f.ts')));
    expect(slots).toHaveLength(250);
    expect(slots.filter((s) => s.entry.ref.name === 'b')).toHaveLength(50);
  });

  it('caps anchors in total, and says so', async () => {
    limits.anchors = 600;
    write(join(root, 'f.ts'), code(600));
    for (const n of ['a', 'b']) {
      const many: Record<string, { file: string; range: [number, number] }> = {};
      for (let i = 0; i < 500; i++) many[`x${i}`] = { file: 'f.ts', range: [i + 1, i + 1] };
      story(root, '', n, { anchors: many });
    }
    await start();
    expect(index.stats().anchors).toBe(600);
    expect(index.capped).toBe(true);
    expect([...index.all()].some((e) => e.capped)).toBe(true);
  });

  it('caps detail links in total', async () => {
    limits.edges = 1;
    story(root, '', 'top', { details: ['d1', 'd2'] });
    story(root, '', 'd1', {});
    story(root, '', 'd2', {});
    await start();
    const g = index.packages()[0]!.graph;
    expect(g.edgeCount).toBe(1);
    expect(g.edgesCapped).toBe(true);
    expect(index.capped).toBe(true);
  });
});

describe('quote slices', () => {
  /** A pinned anchor on `f.ts` line 3, in a manifest padded to about `pad` bytes. */
  function pinned(name: string, pad: number, title = name) {
    return story(root, '', name, { title, anchors: { q: { file: 'f.ts', range: [3, 3], quote: 'line 3' } }, extra: { pad: 'x'.repeat(pad) } });
  }

  it('one file anchored by many sidestories with big manifests: reads only the slices', async () => {
    write(join(root, 'f.ts'), code(10));
    const n = 30;
    for (let i = 0; i < n; i++) pinned(`s${i}`, 200_000);
    await start();
    const store = (index as unknown as { quotes: { bytesRead: number } }).quotes;
    const slots = index.anchorsIn(key(join(root, 'f.ts')));
    expect(slots).toHaveLength(n);
    for (const s of slots) {
      const q = await index.quotesFor(s.entry, [s.index], () => true);
      expect(q.get(s.index)).toMatchObject({ exact: 'line 3' });
    }
    expect(store.bytesRead).toBeLessThan(n * 200); // a few dozen bytes each, never 200 KB manifests
    // Cached: a second round reads nothing.
    const before = store.bytesRead;
    for (const s of slots) await index.quotesFor(s.entry, [s.index], () => true);
    expect(store.bytesRead).toBe(before);
  });

  it('catches a same-size edit the stamp can’t see (hash), and marks the manifest for a re-read', async () => {
    write(join(root, 'f.ts'), code(10));
    const dir = pinned('s', 10);
    const manifest = join(dir, 'manifest.json');
    const t = 1_700_000_000; // whole seconds: the same mtime survives a rewrite on every file system
    utimesSync(manifest, t, t);
    await start();
    const e = entryOf('', 's')!;
    const st = statSync(manifest);
    // Same size, same mtime: only the quote's bytes differ.
    writeFileSync(manifest, manifestText({ title: 's', anchors: { q: { file: 'f.ts', range: [3, 3], quote: 'line 4' } }, extra: { pad: 'x'.repeat(10) } }));
    utimesSync(manifest, t, t);
    expect(statSync(manifest).size).toBe(st.size);
    const version = e.version;
    const now = statSync(manifest);
    expect(`${Math.floor(now.mtimeMs)}:${now.size}`).toBe(e.manifestStamp);
    expect([e.qOff[0], e.qLen[0], e.noSlices]).toEqual([expect.any(Number), expect.any(Number), false]);
    const q = await index.quotesFor(e, [0], () => true);
    expect(q.get(0)).toBeNull();
    expect(e.version).toBeGreaterThan(version);
    // The re-read records the new quote, which is then served.
    await waitFor(() => e.state === 'ready' && e.ids.length === 1);
    await new Promise((r) => setTimeout(r, 100));
    expect((await index.quotesFor(entryOf('', 's')!, [0], () => true)).get(0)).toMatchObject({ exact: 'line 4' });
  });

  it('reads the right bytes in a manifest with non-ASCII text', async () => {
    write(join(root, 'f.ts'), code(10));
    story(root, '', 'u', { title: 'Ünïcödé 🚀 — “title”', summary: 'ßüé 漢字 🎉', anchors: { q: { file: 'f.ts', range: [3, 3], quote: 'line 3' } } });
    await start();
    const e = entryOf('', 'u')!;
    expect(e.title).toBe('Ünïcödé 🚀 — “title”');
    const q = await index.quotesFor(e, [0], () => true);
    expect(q.get(0)).toMatchObject({ exact: 'line 3' });
  });

  it('takes quotes of an open, dirty manifest from its buffer', async () => {
    write(join(root, 'f.ts'), code(10));
    const dir = pinned('s', 10);
    await start();
    const uri = Uri.file(join(dir, 'manifest.json'));
    const text = manifestText({ title: 's', anchors: { q: { file: 'f.ts', range: [3, 3], quote: 'line 3' } } });
    const doc = { uri, isDirty: true, version: 3, isClosed: false, getText: () => text };
    workspace.textDocuments = [doc];
    events.documentChanged.fire({ document: doc, contentChanges: [{}] });
    const e = entryOf('', 's')!;
    await waitFor(() => e.manifestStamp === 'd3');
    const store = (index as unknown as { quotes: { bytesRead: number } }).quotes;
    const before = store.bytesRead;
    const q = await index.quotesFor(e, [0], () => true);
    expect(q.get(0)).toMatchObject({ exact: 'line 3' });
    expect(store.bytesRead).toBe(before);
  });
});

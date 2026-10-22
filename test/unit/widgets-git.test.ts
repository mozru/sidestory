// Git through the git extension's API (src/extension/widgets/git.ts) and what the widget host asks of it:
// consent decisions wait for git to settle after the change that triggered them and never reuse an older
// status refresh; code access reads git's state as it is (no refresh per edit) and asks about the file
// behind a symlink. With a fake git extension over a real folder (the `.git` and the files are real).
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extensions, Uri, workspace } from './vscode-stub.ts';

vi.mock('vscode', () => import('./vscode-stub.ts'));

const { Git } = await import('../../src/extension/widgets/git.ts');
const { WidgetHost, modalText } = await import('../../src/extension/widgets/host.ts');
const { anchorsRead } = await import('../../src/extension/widgets/html.ts');
const { decideConsent } = await import('../../src/extension/widgets/consent.ts');
const { parseManifest } = await import('../../src/core/manifest.ts');
const { resolveAnchor } = await import('../../src/core/resolve.ts');
const { PreparedText } = await import('../../src/core/text.ts');
const { refFromDir } = await import('../../src/extension/explainers.ts');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let root = '';

function fakeRepo(over: Partial<Record<string, unknown>> = {}) {
  const repo = {
    rootUri: Uri.file(root),
    state: { HEAD: { commit: 'c1' }, indexChanges: [] as { uri: Uri }[], mergeChanges: [] as { uri: Uri }[], rebaseCommit: undefined as unknown },
    statusStarts: [] as number[],
    ignoreCalls: 0,
    async status() {
      repo.statusStarts.push(Date.now());
      await sleep(20);
    },
    show: async (_ref: string, _path: string): Promise<string> => {
      throw new Error('not in HEAD');
    },
    checkIgnore: async (paths: string[]) => {
      repo.ignoreCalls++;
      return new Set(paths.filter((p) => p.endsWith('.yml')));
    },
    ...over,
  };
  extensions.git = { getRepository: () => repo };
  return repo;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cx-git-')));
  mkdirSync(join(root, '.git'));
  workspace.root = Uri.file(root);
});
afterEach(() => {
  extensions.git = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe('settling git before a consent decision', () => {
  it('never reuses a status refresh that began before the triggering event', async () => {
    const repo = fakeRepo();
    const git = new Git();
    const t0 = Date.now();
    expect(await git.settle(repo as never, t0)).toBe(true);
    expect(repo.statusStarts).toHaveLength(1);
    // Asked again about the same event: the refresh is reused.
    expect(await git.settle(repo as never, t0)).toBe(true);
    expect(repo.statusStarts).toHaveLength(1);
    // A later event (a checkout's file write): a refresh that began after it.
    await sleep(5);
    const t1 = Date.now();
    expect(await git.settle(repo as never, t1)).toBe(true);
    expect(repo.statusStarts).toHaveLength(2);
    expect(repo.statusStarts[1]).toBeGreaterThanOrEqual(t1);
  });

  it('waits while git holds the index lock, and refreshes after it is gone', async () => {
    const repo = fakeRepo();
    const git = new Git();
    writeFileSync(join(root, '.git', 'index.lock'), '');
    const done = git.settle(repo as never, Date.now());
    await sleep(400);
    expect(repo.statusStarts).toHaveLength(0);
    const freed = Date.now();
    rmSync(join(root, '.git', 'index.lock'));
    expect(await done).toBe(true);
    expect(repo.statusStarts.at(-1)).toBeGreaterThanOrEqual(freed);
  });

  it('a merge or rebase in progress, or a lock that stays, doesn’t settle', async () => {
    const repo = fakeRepo();
    repo.state.rebaseCommit = { hash: 'x' };
    expect(await new Git().settle(repo as never, Date.now(), 300)).toBe(false);
    repo.state.rebaseCommit = undefined;
    repo.state.mergeChanges = [{ uri: Uri.file(join(root, 'a.ts')) }];
    expect(await new Git().settle(repo as never, Date.now(), 300)).toBe(false);
    repo.state.mergeChanges = [];
    writeFileSync(join(root, '.git', 'index.lock'), '');
    expect(await new Git().settle(repo as never, Date.now(), 300)).toBe(false);
  });

  it('a .git file (worktree) points at the git directory holding the lock', async () => {
    rmSync(join(root, '.git'), { recursive: true });
    mkdirSync(join(root, 'gd'));
    writeFileSync(join(root, '.git'), 'gitdir: gd\n');
    writeFileSync(join(root, 'gd', 'index.lock'), '');
    expect(await new Git().settle(fakeRepo() as never, Date.now(), 300)).toBe(false);
  });
});

describe('code access asks git cheaply', () => {
  it('looking up a repository runs no status refresh; ignore checks are cached per HEAD', async () => {
    const repo = fakeRepo();
    const git = new Git();
    const f = Uri.file(join(root, 'config', 'db.yml'));
    const l = await git.lookup(f as never);
    expect(l.kind).toBe('repo');
    expect(repo.statusStarts).toHaveLength(0);
    expect(await git.ignored(repo as never, f as never)).toBe(true);
    expect(await git.ignored(repo as never, f as never)).toBe(true);
    expect(repo.ignoreCalls).toBe(1);
    repo.state.HEAD = { commit: 'c2' };
    await git.ignored(repo as never, f as never);
    expect(repo.ignoreCalls).toBe(2);
  });
});

describe('a committed symlink to an ignored file (H1)', () => {
  it.skipIf(process.platform === 'win32')('useAnchorCode gets nothing: git is asked about the file behind the link', async () => {
    const secret = ['default: &default', '  adapter: postgresql', '  username: app', '  password: hunter2', '  host: localhost', '  pool: 5', ''].join('\n');
    mkdirSync(join(root, 'config'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, '.gitignore'), 'config/database.yml\n');
    writeFileSync(join(root, 'config', 'database.yml'), secret);
    symlinkSync('../config/database.yml', join(root, 'src', 'password:'));
    symlinkSync('password:', join(root, 'src', 'a.ts'));
    const manifestText = JSON.stringify({
      version: 2, title: 'x',
      anchors: { x: { file: 'src/a.ts', range: [4, 4], quote: { exact: 'password:', prefix: 'adapter: postgresql\nusername: app', suffix: 'host: localhost\npool: 5', norm: 'ws' } } },
    });
    mkdirSync(join(root, '.explain', 'e'), { recursive: true });
    writeFileSync(join(root, '.explain', 'e', 'manifest.json'), manifestText);
    // What git says about the link itself: committed, not ignored, and `git show` gives the link's target.
    fakeRepo({
      show: async (_ref: string, path: string) => {
        if (path.endsWith('manifest.json')) return manifestText;
        if (path.endsWith(join('src', 'a.ts'))) return 'password:';
        throw new Error('not in HEAD');
      },
    });
    const manifest = (parseManifest(manifestText) as { ok: true; manifest: import('../../src/core/manifest.ts').Manifest }).manifest;
    const anchor = manifest.anchors.get('x')!;
    const resolution = resolveAnchor(PreparedText.from(secret), anchor);
    const state = new Map<string, unknown>();
    const host = new WidgetHost({ workspaceState: { get: (k: string, d: unknown) => state.get(k) ?? d, update: async (k: string, v: unknown) => void state.set(k, v) }, extensionUri: Uri.file('/ext') } as never);
    const ref = refFromDir(Uri.file(join(root, '.explain', 'e')) as never)!;
    const port = { ref: () => ref, manifest: () => manifest, resolution: () => resolution } as never;
    const code = await host.codeFor(port, 'x');
    host.dispose();
    expect(resolution.state).toBe('stale'); // found (approximately): only git's answers stand in the way
    expect(code).toEqual({ anchor: 'x', status: 'unavailable', reason: 'ignored' });
  });

  it.skipIf(process.platform === 'win32')('a widget file that is a symlink counts as git-unknown for consent (changed code asks)', async () => {
    fakeRepo();
    mkdirSync(join(root, 'w'));
    writeFileSync(join(root, 'w', 'real.tsx'), 'x');
    symlinkSync('real.tsx', join(root, 'w', 'link.tsx'));
    const host = new WidgetHost({ workspaceState: { get: (_k: string, d: unknown) => d, update: async () => {} }, extensionUri: Uri.file('/ext') } as never);
    expect(await host.fileGit(Uri.file(join(root, 'w', 'link.tsx')) as never)).toEqual({ kind: 'unknown' });
    expect((await host.fileGit(Uri.file(join(root, 'w', 'real.tsx')) as never)).kind).toBe('repo');
    host.dispose();
  });
});

describe('consent for widget files reached through links, or read while git moves', () => {
  const memento = () => {
    const state = new Map<string, unknown>();
    return { workspaceState: { get: (k: string, d: unknown) => state.get(k) ?? d, update: async (k: string, v: unknown) => void state.set(k, v) }, extensionUri: Uri.file('/ext') } as never;
  };

  it.skipIf(process.platform === 'win32')('a file in a symlinked folder of the explainer is unknown to git, so a new one asks', async () => {
    const dir = join(root, '.explain', 'x');
    mkdirSync(join(dir, 'real'), { recursive: true });
    writeFileSync(join(dir, 'real', 'a.tsx'), 'export default () => null;');
    symlinkSync('real', join(dir, 'w'));
    fakeRepo({ getObjectDetails: async () => { throw new Error('Path not known'); } });
    const host = new WidgetHost(memento());
    await host.acknowledge([], true);
    const f = await host.widgetFile(Uri.file(join(dir, 'w', 'a.tsx')) as never, Uri.file(dir) as never, Date.now());
    expect(f.git).toEqual({ kind: 'unknown' });
    expect(decideConsent(host.consent(), [f])).toMatchObject({ ask: true, added: [f.path] });
    // The same file by its own path is git's to judge.
    expect((await host.widgetFile(Uri.file(join(dir, 'real', 'a.tsx')) as never, Uri.file(dir) as never, Date.now())).git.kind).toBe('repo');
    host.dispose();
  });

  it.skipIf(process.platform === 'win32')('a symlinked explainer folder (.explain/x -> ../docs/x) is unknown to git, so a new widget asks', async () => {
    mkdirSync(join(root, 'docs', 'x', 'w'), { recursive: true });
    writeFileSync(join(root, 'docs', 'x', 'w', 'a.tsx'), 'export default () => null;');
    mkdirSync(join(root, '.explain'), { recursive: true });
    symlinkSync('../docs/x', join(root, '.explain', 'x'));
    fakeRepo({ getObjectDetails: async () => { throw new Error('Path not known'); } });
    const host = new WidgetHost(memento());
    await host.acknowledge([], true);
    const ref = refFromDir(Uri.file(join(root, '.explain', 'x')) as never)!;
    const [f] = await host.widgetFiles(ref, [{ files: ['w/a.tsx'] } as never]);
    expect(f!.git).toEqual({ kind: 'unknown' });
    expect(decideConsent(host.consent(), [f!])).toMatchObject({ ask: true, added: [f!.path] });
    host.dispose();
  });

  it.skipIf(process.platform === 'win32')('a symlink above the folder holding .explain (b -> a, opened as b/.explain/x) is unknown to git, so a new widget asks', async () => {
    mkdirSync(join(root, 'a', '.explain', 'x', 'w'), { recursive: true });
    writeFileSync(join(root, 'a', '.explain', 'x', 'w', 'a.tsx'), 'export default () => null;');
    symlinkSync('a', join(root, 'b'));
    fakeRepo({ getObjectDetails: async () => { throw new Error('Path not known'); } });
    const host = new WidgetHost(memento());
    await host.acknowledge([], true);
    const ref = refFromDir(Uri.file(join(root, 'b', '.explain', 'x')) as never)!;
    const [f] = await host.widgetFiles(ref, [{ files: ['w/a.tsx'] } as never]);
    expect(f!.git).toEqual({ kind: 'unknown' });
    expect(decideConsent(host.consent(), [f!])).toMatchObject({ ask: true, added: [f!.path] });
    host.dispose();
  });

  it('bytes that change while git is asked (a pull landing) give unknown, not a mismatched record', async () => {
    const dir = join(root, '.explain', 'x');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'a.tsx');
    writeFileSync(path, 'old');
    fakeRepo({ getObjectDetails: async () => { writeFileSync(path, 'new'); return { mode: '100644', object: 'b2', size: 3 }; } });
    const host = new WidgetHost(memento());
    const f = await host.widgetFile(Uri.file(path) as never, Uri.file(dir) as never, Date.now());
    expect(f.git).toEqual({ kind: 'unknown' });
    host.dispose();
  });

  it('an uncommitted .gitignore edit is seen by the ignore check', async () => {
    const repo = fakeRepo();
    const git = new Git();
    const f = Uri.file(join(root, 'config', 'db.yml'));
    await git.ignored(repo as never, f as never);
    writeFileSync(join(root, '.gitignore'), 'x\n');
    await git.ignored(repo as never, f as never);
    expect(repo.ignoreCalls).toBe(2);
    // A nested .gitignore, and .git/info/exclude.
    mkdirSync(join(root, 'config'), { recursive: true });
    writeFileSync(join(root, 'config', '.gitignore'), 'db.yml\n');
    await git.ignored(repo as never, f as never);
    expect(repo.ignoreCalls).toBe(3);
    mkdirSync(join(root, '.git', 'info'), { recursive: true });
    writeFileSync(join(root, '.git', 'info', 'exclude'), 'db.yml\n');
    await git.ignored(repo as never, f as never);
    expect(repo.ignoreCalls).toBe(4);
    await git.ignored(repo as never, f as never);
    expect(repo.ignoreCalls).toBe(4);
  });
});

describe('what widgets read, judged conservatively (M2)', () => {
  it('literal direct calls name their anchors; aliases, renames and other mentions mean any anchor', () => {
    expect(anchorsRead({ 'a.tsx': "const c = (0, _explainer.useAnchorCode)('refill'); _explainer.useAnchorCode.call(void 0, 'drain');" })).toEqual(new Set(['refill', 'drain']));
    expect(anchorsRead({ 'a.tsx': 'const read = _explainer.useAnchorCode; read("secret");' })).toBe('all');
    expect(anchorsRead({ 'a.tsx': 'const { useAnchorCode: u } = require("explainer"); u("x");' })).toBe('all');
    expect(anchorsRead({ 'a.tsx': 'const { useAnchorCode } = require("explainer"); useAnchorCode("x");' })).toEqual(new Set(['x']));
    expect(anchorsRead({ 'a.tsx': 'parent.postMessage({ type: "requestCode", anchor: "x" }, "*");' })).toEqual(new Set());
  });
});

describe('modal text from an explainer', () => {
  it('is one line, without control or direction characters, and capped', () => {
    expect(modalText('Fine\n\nClick “Run Widgets”: it is safe‮')).toBe('Fine Click “Run Widgets”: it is safe');
    expect(modalText('x'.repeat(200))).toHaveLength(80);
  });
});

// The checker and the extension count the same changes (docs/CHANGES-PLAN.md §5.1, §6, §13): binary files, symlinks,
// submodules, Git LFS files, pure renames and unsupported paths are one change each, Windows device names are
// read by blob id but refused on disk, and an unstaged rename is paired by content. The checker runs on a real
// repository (src/cli/coverage.ts); the extension's coverage runs through CoverageService's own source over a git
// API stand-in backed by the same repository, with entries listed as comparison.ts lists them.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CoverageJson } from '../../src/cli/coverage.ts';
import { isSafeRepoPath } from '../../src/core/repo-path.ts';
import type { ChangeEntry } from '../../src/extension/changes/model.ts';

vi.mock('vscode', () => import('./vscode-stub.ts'));
const { main } = await import('../../src/cli/check-widgets.ts');
const { CoverageService, computeCoverage } = await import('../../src/extension/changes/coverage-service.ts');
type Result = import('../../src/extension/changes/coverage-service.ts').CoverageResult;
const vscode = await import('./vscode-stub.ts');

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const gitEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };
const gitBuf = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] });
const git = (cwd: string, ...args: string[]) => gitBuf(cwd, ...args).toString();

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const LFS = 'version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n';
const WEIRD = 'weird\u0001name.txt';

let base = '';
let committed = '';
let n = 0;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'cx-parity-')));
  committed = join(base, 'committed');
  execFileSync(process.execPath, [join(repoRoot, 'test/fixtures/git-repo.mjs'), committed, '--explained'], { env: gitEnv });
  // A commit of files whose lines can't be compared, on the branch.
  mkdirSync(join(committed, 'assets'));
  writeFileSync(join(committed, 'assets/logo.png'), PNG);
  writeFileSync(join(committed, 'data.bin'), PNG);
  writeFileSync(join(committed, 'video.mp4'), LFS);
  symlinkSync('README.md', join(committed, 'readme-link'));
  writeFileSync(join(committed, 'con'), 'a file Windows would read as the console\n');
  writeFileSync(join(committed, WEIRD), 'a control character in its name\n');
  git(committed, 'add', '-A');
  // A submodule (a gitlink to the branch's own commit) and its empty folder, as a clone without --recursive has it.
  git(committed, 'update-index', '--add', '--cacheinfo', `160000,${git(committed, 'rev-parse', 'HEAD').trim()},vendor/lib`);
  mkdirSync(join(committed, 'vendor/lib'), { recursive: true });
  // trivialFiles marks the assets folder.
  const mf = join(committed, '.sidestory/retry-jitter/manifest.json');
  const m = JSON.parse(readFileSync(mf, 'utf8'));
  m.trivialFiles = ['assets/**'];
  writeFileSync(mf, JSON.stringify(m, null, 2));
  git(committed, 'add', '-A');
  git(committed, 'commit', '-q', '--no-verify', '-m', 'Assets, links, a submodule');
}, 60_000);

afterAll(() => rmSync(base, { recursive: true, force: true }));

function copy(): string {
  const dir = join(base, `copy${n++}`);
  cpSync(committed, dir, { recursive: true, verbatimSymlinks: true });
  return dir;
}

async function checker(dir: string, committedOnly: boolean): Promise<CoverageJson> {
  const out: string[] = [];
  await main(['--coverage', '--base', 'main', ...(committedOnly ? ['--committed'] : []), '--repo', dir, '--json'], { out: (s) => out.push(s), err: () => {} }, undefined, undefined, { env: gitEnv });
  return JSON.parse(out.join('\n')).coverage;
}

/** The git extension's calls the coverage service makes, answered by git in `root`. */
function fakeRepo(root: string) {
  const rel = (abs: string) => relative(root, abs).split(sep).join('/');
  return {
    rootUri: vscode.Uri.file(root),
    getObjectDetails: async (treeish: string, path: string) => {
      const out = git(root, '--literal-pathspecs', 'ls-tree', '-l', '-z', treeish, '--', rel(path));
      const m = /^(\d{6}) (\w+) ([0-9a-f]{40,64}) +(\d+|-)\t/.exec(out);
      if (!m) throw Object.assign(new Error('Path not known by git'), { gitErrorCode: 'UnknownPath' });
      return { mode: m[1]!, object: m[3]!, size: m[4] === '-' ? 0 : Number(m[4]) };
    },
    buffer: async (ref: string, path: string) => new Uint8Array(gitBuf(root, 'cat-file', 'blob', `${ref}:${rel(path)}`)),
  };
}

/** Entries as comparison.ts lists them: renames from git, untracked files, unsafe paths set apart. */
function listing(root: string, mergeBase: string, workingTree: boolean): { entries: ChangeEntry[]; unsupported: { path: string; oldPath?: string }[] } {
  const parts = git(root, 'diff', '--name-status', '-z', '-M', '--no-ext-diff', mergeBase, ...(workingTree ? [] : ['HEAD']), '--').split('\0');
  const entries: ChangeEntry[] = [];
  const unsupported: { path: string; oldPath?: string }[] = [];
  const push = (e: ChangeEntry) => (isSafeRepoPath(e.path) && (e.oldPath === undefined || isSafeRepoPath(e.oldPath)) ? entries.push(e) : unsupported.push({ path: e.path, ...(e.oldPath ? { oldPath: e.oldPath } : {}) }));
  for (let i = 0; i < parts.length - 1; ) {
    const status = parts[i++]!;
    if (status.startsWith('R')) {
      const oldPath = parts[i++]!;
      push({ status: 'R', oldPath, path: parts[i++]! });
    } else push({ status: status[0] === 'A' ? 'A' : status[0] === 'D' ? 'D' : 'M', path: parts[i++]! });
  }
  if (workingTree) for (const p of git(root, 'ls-files', '-o', '--exclude-standard', '-z').split('\0').filter(Boolean)) push({ status: 'A', path: p, untracked: true });
  return { entries, unsupported };
}

async function extension(root: string, workingTree: boolean, dirs: string[] = ['.sidestory/retry-jitter']): Promise<Result> {
  const mergeBase = git(root, 'merge-base', 'main', 'HEAD').trim();
  const { entries, unsupported } = listing(root, mergeBase, workingTree);
  const snap = { repo: fakeRepo(root), mergeBase, head: { sha: git(root, 'rev-parse', 'HEAD').trim() }, mode: workingTree ? 'workingTree' : 'committed', entries, unsupported };
  const svc = new CoverageService({ snapshot: () => snap as never, order: () => [], sidestoryDirs: () => dirs.map((d) => vscode.Uri.file(join(root, d)) as never) });
  // Resolving `base` goes through the git extension's ref calls (base.ts, tested elsewhere): main's merge-base here.
  svc.ownMergeBase = async (_s, spec) => (spec === 'main' ? mergeBase : undefined);
  try {
    return (await computeCoverage((svc as unknown as { source(s: unknown): never }).source(snap)))!;
  } finally {
    svc.dispose();
  }
}

const checkerStates = (c: CoverageJson) => Object.fromEntries(c.files.filter((f) => f.changes.length).map((f) => [f.path, f.changes.map((x) => x.status).join(',')]));
function extensionStates(r: Result): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [p, f] of r.files) if (f.coverage?.changes.length) out[p] = f.coverage.changes.map((c) => c.state).join(',');
  for (const p of r.unsupported) out[p] = 'unexplained';
  return out;
}
const pick = (t: { changes: number; explained: number; trivial: number; left: number }) => ({ changes: t.changes, explained: t.explained, trivial: t.trivial, left: t.left });

describe.skipIf(process.platform === 'win32')('the checker and the extension count the same changes', () => {
  it('committed: binary, Git LFS, link, submodule and unsupported paths are one change each; a device name is a blob', async () => {
    const c = await checker(committed, true);
    const r = await extension(committed, false);
    const kind = (p: string) => c.files.find((f) => f.path === p)?.kind;
    expect(kind('assets/logo.png')).toBe('binary');
    expect(kind('data.bin')).toBe('binary');
    expect(kind('readme-link')).toBe('link');
    expect(kind('vendor/lib')).toBe('submodule');
    expect(kind(WEIRD)).toBe('unsupported');
    expect(kind('video.mp4')).toBe('lfs');
    expect(kind('con')).toBe('text');
    expect(checkerStates(c)).toMatchObject({ 'assets/logo.png': 'trivial', 'data.bin': 'unexplained', 'readme-link': 'unexplained', 'vendor/lib': 'unexplained', [WEIRD]: 'unexplained', con: 'unexplained' });
    expect(checkerStates(c)['video.mp4']).toBe('unexplained');
    expect(r.files.get('video.mp4')!.whole).toBe('lfs');
    expect(extensionStates(r)).toEqual(checkerStates(c));
    expect(pick(r.totals)).toEqual(pick(c.totals));
    expect(r.files.get('readme-link')!.whole).toBe('link');
    expect(r.files.get('vendor/lib')!.whole).toBe('submodule');
    expect(r.files.get('data.bin')!.whole).toBe('binary');
    expect(r.unsupported).toEqual([WEIRD]);
    expect(r.incomplete).toBe(c.incomplete);
  });

  it('working tree: an unstaged rename is paired, untracked links, nested repositories and device names count once', async () => {
    const dir = copy();
    renameSync(join(dir, 'docs/notes.md'), join(dir, 'docs/renamed.md'));
    writeFileSync(join(dir, 'new.bin'), PNG);
    symlinkSync('README.md', join(dir, 'untracked-link'));
    writeFileSync(join(dir, 'prn.txt'), 'Windows would read this as the printer\n');
    mkdirSync(join(dir, 'nested'));
    git(join(dir, 'nested'), 'init', '-q');
    writeFileSync(join(dir, 'nested/x.txt'), 'x\n');
    const c = await checker(dir, false);
    const r = await extension(dir, true);
    const kind = (p: string) => c.files.find((f) => f.path === p)?.kind;
    expect(c.files.find((f) => f.path === 'docs/renamed.md')).toMatchObject({ oldPath: 'docs/notes.md', status: 'R' });
    expect(c.files.find((f) => f.path === 'docs/notes.md')).toBeUndefined();
    expect(kind('untracked-link')).toBe('link');
    expect(kind('prn.txt')).toBe('unsupported');
    expect(kind('con')).toBe('unsupported'); // read from disk in working tree mode
    expect(kind('nested')).toBe('submodule');
    expect(kind('vendor/lib')).toBe('submodule');
    expect(kind('new.bin')).toBe('binary');
    // The extension pairs the rename too: no deletion of docs/notes.md left to explain.
    expect(r.files.get('docs/renamed.md')?.entry).toMatchObject({ status: 'R', oldPath: 'docs/notes.md' });
    expect(r.files.has('docs/notes.md')).toBe(false);
    expect(r.files.get('prn.txt')!.whole).toBe('unsupported');
    expect(r.files.get('untracked-link')!.whole).toBe('link');
    // The nested repository: the checker sees a submodule-to-be, the extension (git's `nested/`) an unsupported path;
    // one change either way.
    const cs = checkerStates(c);
    const es = extensionStates(r);
    expect(cs.nested).toBe('unexplained');
    expect(es['nested/']).toBe('unexplained');
    delete cs.nested;
    delete es['nested/'];
    expect(es).toEqual(cs);
    expect(pick(r.totals)).toEqual(pick(c.totals));
  });

  it('LFS only when every side is a complete pointer; code in a sidestory folder, a rename onto sidestory.html and archives count', async () => {
    const dir = copy();
    const commit = (msg: string) => {
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '--no-verify', '-m', msg);
    };
    // A sidestory complete on main, so the branch's merge-base has it (archiving needs that).
    git(dir, 'checkout', '-q', 'main');
    mkdirSync(join(dir, '.sidestory/landed'), { recursive: true });
    writeFileSync(join(dir, '.sidestory/landed/manifest.json'), JSON.stringify({ version: 3, title: 'Landed', base: 'main', anchors: {} }, null, 2));
    writeFileSync(join(dir, '.sidestory/landed/sidestory.html'), '<p>Landed</p>\n');
    commit('A sidestory lands');
    git(dir, 'checkout', '-q', 'feature');
    git(dir, 'merge', '-q', '--no-edit', 'main');
    // An incomplete pointer is text; a text file becoming a pointer is a change.
    writeFileSync(join(dir, 'fake-lfs.txt'), 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\n');
    writeFileSync(join(dir, 'README.md'), LFS);
    // Code kept in a sidestory folder counts like code anywhere.
    mkdirSync(join(dir, '.sidestory/helper'), { recursive: true });
    writeFileSync(join(dir, '.sidestory/helper/run.js'), 'module.exports = () => 1;\n');
    // Code renamed onto a sidestory's page: the code's deletion counts.
    mkdirSync(join(dir, '.sidestory/second'), { recursive: true });
    writeFileSync(join(dir, '.sidestory/second/manifest.json'), JSON.stringify({ version: 3, title: 'Second', base: 'main', anchors: {} }, null, 2));
    git(dir, 'mv', 'docs/notes.md', '.sidestory/second/sidestory.html');
    // Archiving the landed sidestory unchanged isn't code; anything else under the archive is one change.
    mkdirSync(join(dir, '.sidestory/archive'), { recursive: true });
    git(dir, 'mv', '.sidestory/landed', '.sidestory/archive/2026-01-02-landed');
    writeFileSync(join(dir, '.sidestory/archive/2026-01-02-landed/extra.js'), 'run();\n');
    commit('Pointers, helpers, a page, an archive');

    const c = await checker(dir, true);
    const r = await extension(dir, false, ['.sidestory/retry-jitter', '.sidestory/second']);
    const cs = checkerStates(c);
    expect(cs['fake-lfs.txt']).toBe('unexplained');
    expect(cs['README.md']).toBeDefined();
    expect(cs['.sidestory/helper/run.js']).toBe('unexplained');
    expect(cs['docs/notes.md']).toBe('unexplained');
    expect(cs['.sidestory/second/sidestory.html']).toBeUndefined();
    expect(cs['.sidestory/archive/2026-01-02-landed/extra.js']).toBe('unexplained');
    expect(Object.keys(cs).filter((p) => p.includes('landed') && !p.endsWith('extra.js'))).toEqual([]);
    expect(extensionStates(r)).toEqual(cs);
    expect(pick(r.totals)).toEqual(pick(c.totals));
    expect(r.files.get('.sidestory/archive/2026-01-02-landed/extra.js')!.whole).toBe('archive');
  });

  it('a move that changes no line is one change; an archived manifest passes only as the archive job rewrites it', async () => {
    const dir = copy();
    const commit = (msg: string) => {
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '--no-verify', '-m', msg);
    };
    const manifest = (title: string) => ({ version: 3, title, base: 'main', anchors: {} });
    git(dir, 'checkout', '-q', 'main');
    for (const name of ['landed', 'landed2']) {
      mkdirSync(join(dir, `.sidestory/${name}`), { recursive: true });
      writeFileSync(join(dir, `.sidestory/${name}/manifest.json`), JSON.stringify(manifest(name), null, 2));
      writeFileSync(join(dir, `.sidestory/${name}/sidestory.html`), `<p>${name}</p>\n`);
    }
    commit('Two sidestories land');
    git(dir, 'checkout', '-q', 'feature');
    git(dir, 'merge', '-q', '--no-edit', 'main');
    const mb = git(dir, 'rev-parse', 'main').trim();
    // Pure moves: switched off by directory, or hidden in a folder that isn't a sidestory.
    mkdirSync(join(dir, 'src/disabled'), { recursive: true });
    git(dir, 'mv', 'README.md', 'src/disabled/README.md');
    mkdirSync(join(dir, '.sidestory/notes'), { recursive: true });
    git(dir, 'mv', 'docs/notes.md', '.sidestory/notes/notes.md');
    // Archived as the job writes it (base, head, landed added), and one with a payload field.
    mkdirSync(join(dir, '.sidestory/archive'), { recursive: true });
    // The payload rides inside `landed`, which the archive job's schema doesn't allow.
    for (const [name, extra] of [['landed', {}], ['landed2', { landed: { branch: 'feature', at: '2026-01-02', payload: 'require("x")' } }]] as const) {
      const to = `.sidestory/archive/2026-01-02-${name}`;
      git(dir, 'mv', `.sidestory/${name}`, to);
      writeFileSync(join(dir, to, 'manifest.json'), JSON.stringify({ ...manifest(name), base: mb, head: mb, landed: { branch: 'feature', at: '2026-01-02' }, ...extra }, null, 2));
    }
    commit('Moves and archives');

    const c = await checker(dir, true);
    const r = await extension(dir, false);
    const cs = checkerStates(c);
    expect(c.files.find((f) => f.path === 'src/disabled/README.md')).toMatchObject({ kind: 'rename', oldPath: 'README.md' });
    expect(cs['src/disabled/README.md']).toBe('unexplained');
    expect(cs['.sidestory/notes/notes.md']).toBe('unexplained');
    expect(cs['.sidestory/archive/2026-01-02-landed2/manifest.json']).toBe('unexplained');
    expect(Object.keys(cs).filter((p) => p.includes('landed') && !p.endsWith('landed2/manifest.json'))).toEqual([]);
    expect(extensionStates(r)).toEqual(cs);
    expect(pick(r.totals)).toEqual(pick(c.totals));
    expect(r.files.get('src/disabled/README.md')!.move!.files).toEqual([{ path: 'src/disabled/README.md', oldPath: 'README.md' }]);
  });

  it('a folder moved as a whole is one change; an edited file keeps its line change; a partial trivialFiles glob does not cover the move', async () => {
    const dir = copy();
    const commit = (msg: string) => {
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '--no-verify', '-m', msg);
    };
    git(dir, 'checkout', '-q', 'main');
    mkdirSync(join(dir, 'src/a'), { recursive: true });
    for (const n of ['one', 'two', 'three', 'four']) writeFileSync(join(dir, `src/a/${n}.js`), Array.from({ length: 12 }, (_, i) => `export const ${n}${i} = ${i};`).join('\n') + '\n');
    commit('A package');
    git(dir, 'checkout', '-q', 'feature');
    git(dir, 'merge', '-q', '--no-edit', 'main');
    git(dir, 'mv', 'src/a', 'src/b');
    writeFileSync(join(dir, 'src/b/three.js'), readFileSync(join(dir, 'src/b/three.js'), 'utf8').replace('three5 = 5', 'three5 = 50'));
    // A glob that matches some of the moved files only.
    const mf = join(dir, '.sidestory/retry-jitter/manifest.json');
    const m = JSON.parse(readFileSync(mf, 'utf8'));
    m.trivialFiles = [...(m.trivialFiles ?? []), 'src/b/one.js', 'src/b/two.js'];
    writeFileSync(mf, JSON.stringify(m, null, 2));
    commit('Move the package');

    const c = await checker(dir, true);
    const r = await extension(dir, false);
    const cs = checkerStates(c);
    // The group's change on its first file (four.js), the edit on three.js; one.js and two.js have nothing of their own.
    expect(cs['src/b/four.js']).toBe('unexplained');
    expect(cs['src/b/three.js']).toBe('unexplained');
    expect(cs['src/b/one.js']).toBeUndefined();
    expect(cs['src/b/two.js']).toBeUndefined();
    expect(c.files.filter((f) => f.path.startsWith('src/b/')).map((f) => f.kind).sort()).toEqual(['rename', 'rename', 'rename', 'text']);
    expect(extensionStates(r)).toEqual(cs);
    expect(pick(r.totals)).toEqual(pick(c.totals));
    expect(r.files.get('src/b/four.js')!.move!.files.map((f) => f.path)).toEqual(['src/b/four.js', 'src/b/one.js', 'src/b/three.js', 'src/b/two.js']);
    expect(r.files.get('src/b/one.js')!.movedWith).toBe('src/b/four.js');
  });

  it('groups by moved prefix; one file\'s trivial mark covers only its own move; archive and unsupported entries are never in a group', async () => {
    const dir = copy();
    const commit = (msg: string) => {
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '--no-verify', '-m', msg);
    };
    git(dir, 'checkout', '-q', 'main');
    mkdirSync(join(dir, 'src/a/deep'), { recursive: true });
    writeFileSync(join(dir, 'src/a/one.js'), 'export const one = 1;\n');
    writeFileSync(join(dir, 'src/a/deep/two.js'), 'export const two = 2;\n');
    commit('A package with a subfolder');
    git(dir, 'checkout', '-q', 'feature');
    git(dir, 'merge', '-q', '--no-edit', 'main');
    git(dir, 'mv', 'src/a', 'src/b');
    // A trivial mark on one moved file: it covers that file's move only.
    const mf = join(dir, '.sidestory/retry-jitter/manifest.json');
    const m = JSON.parse(readFileSync(mf, 'utf8'));
    m.anchors['trivial-9'] = { file: 'src/b/one.js', range: [1, 1], trivial: true, why: 'moved with its package' };
    writeFileSync(mf, JSON.stringify(m, null, 2));
    // A rename onto an unsupported path, and a move into an archive: one change each, in no group.
    git(dir, 'mv', 'README.md', WEIRD.replace('.txt', '.md'));
    mkdirSync(join(dir, '.sidestory/archive/2026-01-01-x'), { recursive: true });
    git(dir, 'mv', 'docs/notes.md', '.sidestory/archive/2026-01-01-x/notes.md');
    commit('Moves');

    const c = await checker(dir, true);
    const r = await extension(dir, false);
    const cs = checkerStates(c);
    expect(cs['src/b/deep/two.js']).toBe('unexplained'); // the carrier: src/a → src/b, two files
    expect(cs['src/b/one.js']).toBeUndefined();
    const move = c.files.find((f) => f.path === 'src/b/deep/two.js')!.changes[0]!;
    expect(move.move).toMatchObject({ label: '2 files moved src/a → src/b' });
    expect(move.uncoveredFiles).toEqual(['src/b/deep/two.js']);
    expect(cs[WEIRD.replace('.txt', '.md')]).toBe('unexplained');
    expect(cs['.sidestory/archive/2026-01-01-x/notes.md']).toBe('unexplained');
    // The only move carriers: the package, and the fixture's own backoff.ts move.
    expect(c.files.filter((f) => f.changes.some((x) => x.move)).map((f) => f.path)).toEqual(['src/b/deep/two.js', 'src/retry/backoff.ts']);
    expect(extensionStates(r)).toEqual(cs);
    expect(pick(r.totals)).toEqual(pick(c.totals));
    expect([...r.files.values()].filter((f) => f.move).map((f) => f.entry.path)).toEqual(['src/b/deep/two.js', 'src/retry/backoff.ts']);
    expect(r.files.get('src/b/deep/two.js')!.coverage!.changes[0]!.uncoveredFiles).toEqual(['src/b/deep/two.js']);
  });

  it('in-place renames sharing a transform are one change; other renames in the folder stay apart', async () => {
    const dir = copy();
    const commit = (msg: string) => {
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '--no-verify', '-m', msg);
    };
    git(dir, 'checkout', '-q', 'main');
    mkdirSync(join(dir, 'src/components'), { recursive: true });
    for (const n of ['A', 'B', 'C', 'auth', 'pay', 'retry']) writeFileSync(join(dir, `src/components/${n}.js`), `export const ${n} = '${n}';\n`);
    commit('Components');
    git(dir, 'checkout', '-q', 'feature');
    git(dir, 'merge', '-q', '--no-edit', 'main');
    for (const n of ['A', 'B', 'C']) git(dir, 'mv', `src/components/${n}.js`, `src/components/${n}.ts`);
    git(dir, 'mv', 'src/components/auth.js', 'src/components/auth.js.disabled');
    git(dir, 'mv', 'src/components/pay.js', 'src/components/pay.js.disabled'); // inert: never grouped with auth's
    git(dir, 'mv', 'src/components/retry.js', 'src/components/retry-policy.js');
    commit('Renames');

    const c = await checker(dir, true);
    const r = await extension(dir, false);
    const labels = c.files.flatMap((f) => f.changes.flatMap((x) => (x.move && f.path.startsWith('src/components/') ? [x.move.label] : [])));
    expect(labels.sort()).toEqual([
      '3 files renamed in src/components (*.js → *.ts)',
      'renamed src/components/auth.js → src/components/auth.js.disabled',
      'renamed src/components/pay.js → src/components/pay.js.disabled',
      'renamed src/components/retry.js → src/components/retry-policy.js',
    ]);
    expect(extensionStates(r)).toEqual(checkerStates(c));
    expect(pick(r.totals)).toEqual(pick(c.totals));
  });
});

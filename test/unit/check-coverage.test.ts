// check.cjs --coverage (src/cli/coverage.ts, docs/CHANGES-PLAN.md §13.1) on the real git fixture
// (test/fixtures/git-repo.mjs --explained), built in a temporary folder and copied per test.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from '../../src/cli/check-widgets.ts';
import type { CoverageJson } from '../../src/cli/coverage.ts';

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

const status = (c: CoverageJson) => Object.fromEntries(c.files.map((f) => [f.path, f.changes.map((x) => x.status).join(',') || f.kind]));

describe('--coverage on the fixture', () => {
  it('text: the header, what is left, the totals; exit 3', async () => {
    const r = await run(['--coverage', '--base', 'main', '--repo', fixture]);
    expect(r.code).toBe(3);
    expect(r.out).toMatch(/Coverage: base main, merge-base [0-9a-f]{7}, head: working tree; counting \.sidestory\/retry-jitter/);
    expect(r.out).toMatch(/test\/retry\.test\.ts:11: warning unexplained: lines 11–40 \(\+30\) aren't explained by a sidestory of this branch\./);
    expect(r.out).toContain('3 explained · 1 trivial · 1 left, in 5 files.');
    expect(r.out).not.toContain('unused-anchor');
  });

  it('--json: the checklist, change by change', async () => {
    const r = await json(['--coverage', '--base', 'main', '--repo', fixture]);
    expect(r.code).toBe(3);
    expect(r.coverage.sidestories).toEqual(['.sidestory/retry-jitter']);
    expect(status(r.coverage)).toEqual({
      'legacy/sleep.ts': 'explained',
      'src/retry/backoff.ts': 'trivial',
      'src/retry/jitter.ts': 'explained',
      'src/retry/retry.ts': 'explained',
      'test/retry.test.ts': 'unexplained',
    });
    const retry = r.coverage.files.find((f) => f.path === 'src/retry/retry.ts')!.changes[0]!;
    expect(retry).toMatchObject({ old: [5, 5], new: [5, 8], added: 4, removed: 1, by: [{ sidestory: '.sidestory/retry-jitter', anchor: 'retry-loop' }] });
    expect(retry.key).toMatch(/^[0-9a-f]{16}-0$/);
    expect(r.coverage.files.find((f) => f.path === 'src/retry/backoff.ts')).toMatchObject({ oldPath: 'old/backoff.ts', status: 'R' });
    expect(r.coverage.files.find((f) => f.path === 'test/retry.test.ts')!.changes[0]!.uncovered).toEqual([[11, 40]]);
    expect(r.coverage.totals).toMatchObject({ changes: 5, explained: 3, trivial: 1, left: 1, files: 5 });
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
    expect(r.out).toContain('4 explained · 1 trivial · 0 left, in 5 files.');
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
    expect(f).toMatchObject({ oldPath: 'docs/notes.md', status: 'R', kind: 'line-endings', changes: [] });
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

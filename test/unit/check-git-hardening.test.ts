// How the checker runs git (src/cli/git.ts, docs/CHANGES-PLAN.md §13.2): a fake git on PATH records every call's
// arguments, environment, working directory and input before handing it to the real git; planted repositories,
// configs and filters that would write a marker file must never run.
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from '../../src/cli/check-widgets.ts';
import { findRepository, gitEnv } from '../../src/cli/git.ts';

const repo = fileURLToPath(new URL('../../', import.meta.url));
let base = '';
let fixture = '';
let fakeDir = '';
let n = 0;
const realGit = execFileSync('sh', ['-c', 'command -v git']).toString().trim();

const cleanEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: cleanEnv, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

interface Call {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  stdin: string;
}

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'cx-hardening-')));
  fixture = join(base, 'fixture');
  execFileSync(process.execPath, [join(repo, 'test/fixtures/git-repo.mjs'), fixture, '--explained'], { env: cleanEnv });
  fakeDir = join(base, 'bin');
  mkdirSync(fakeDir);
  // The fake git: logs one JSON line per call to $SIDESTORY_TEST_LOG, then runs the real git with the same input.
  // SIDESTORY_TEST_VERSION makes `git version` answer an older version.
  writeFileSync(
    join(fakeDir, 'git'),
    `#!${process.execPath}
const fs = require('fs');
const { spawnSync } = require('child_process');
const argv = process.argv.slice(2);
let stdin = '';
try { stdin = fs.readFileSync(0, 'utf8'); } catch {}
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^GIT_/i.test(k)));
fs.appendFileSync(process.env.SIDESTORY_TEST_LOG, JSON.stringify({ argv, cwd: process.cwd(), env, stdin }) + '\\n');
if (process.env.SIDESTORY_TEST_VERSION && argv.includes('version')) { process.stdout.write('git version ' + process.env.SIDESTORY_TEST_VERSION + '\\n'); process.exit(0); }
const r = spawnSync(${JSON.stringify(realGit)}, argv, { input: stdin, stdio: ['pipe', 'inherit', 'inherit'] });
process.exit(r.status === null ? 1 : r.status);
`,
  );
  chmodSync(join(fakeDir, 'git'), 0o755);
}, 60_000);

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

function copy(): string {
  const dir = join(base, `copy${n++}`);
  cpSync(fixture, dir, { recursive: true });
  return dir;
}

/** Runs the checker with the fake git first on PATH and a hostile environment; returns the exit code, output and calls. */
async function run(args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number; out: string; calls: Call[] }> {
  const log = join(base, `log${n++}.jsonl`);
  writeFileSync(log, '');
  const env = {
    ...cleanEnv,
    PATH: `${fakeDir}${delimiter}${process.env.PATH ?? ''}`,
    SIDESTORY_TEST_LOG: log,
    // Inherited git settings a hook calling the checker might leave behind: none may reach git.
    GIT_DIR: join(base, 'nowhere'),
    GIT_WORK_TREE: join(base, 'nowhere'),
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.pager',
    GIT_CONFIG_VALUE_0: `touch ${join(base, 'PAGER-MARKER')}`,
    ...extraEnv,
  };
  const out: string[] = [];
  const code = await main(args, { out: (s) => out.push(s), err: (s) => out.push(s) }, undefined, undefined, { env });
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Call);
  return { code, out: out.join('\n'), calls };
}

describe('every git call', () => {
  it('runs from PATH with an explicit repository, the fixed -c set and a clean environment', async () => {
    const dir = copy();
    const r = await run(['--coverage', '--base', 'main', '--repo', dir]);
    expect(r.code).toBe(3);
    expect(r.calls.length).toBeGreaterThan(3);
    for (const c of r.calls) {
      expect(c.cwd).toBe(dir);
      const i = c.argv.indexOf('--no-pager');
      expect(i).toBe(0);
      expect(c.argv).toContain(`--git-dir=${join(dir, '.git')}`);
      expect(c.argv).toContain(`--work-tree=${dir}`);
      const config = c.argv.flatMap((a, k) => (c.argv[k - 1] === '-c' ? [a] : []));
      expect(config).toEqual(expect.arrayContaining(['core.fsmonitor=false', 'safe.bareRepository=explicit', 'protocol.allow=never', 'log.showSignature=false', 'diff.renameLimit=1000']));
      expect(config.find((x) => x.startsWith('core.hooksPath='))).toMatch(/sidestory-git-/);
      expect(c.env).toEqual({ GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_CEILING_DIRECTORIES: base });
    }
    expect(existsSync(join(base, 'PAGER-MARKER'))).toBe(false);
  });

  it('writes only hex ids to cat-file --batch, never paths', async () => {
    const r = await run(['--coverage', '--base', 'main', '--repo', copy()]);
    const batches = r.calls.filter((c) => c.argv.includes('cat-file'));
    expect(batches.some((c) => c.argv.includes('--batch'))).toBe(true);
    expect(batches.some((c) => c.argv.includes('--batch-check'))).toBe(true);
    for (const c of batches) for (const line of c.stdin.split('\n').filter(Boolean)) expect(line).toMatch(/^[0-9a-f]{40}$/);
  });

  it('the environment helper drops every GIT_ variable, whatever its case', () => {
    expect(gitEnv('/r/x', { GIT_DIR: 'a', git_index_file: 'b', PATH: 'p' })).toEqual({ PATH: 'p', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_CEILING_DIRECTORIES: '/r', LC_ALL: 'C' });
  });
});

describe('refs', () => {
  it('refs starting with "-" and pseudo-refs are refused before git runs', async () => {
    const dir = copy();
    for (const bad of ['-x', '--output=/tmp/x', 'HEAD', 'FETCH_HEAD', 'ORIG_HEAD', 'a..b', 'main@{1}']) {
      const r = await run(['--coverage', `--base=${bad}`, '--repo', dir]);
      expect(r.code, bad).toBe(1);
      expect(r.out).toContain('error base:');
      expect(r.calls, bad).toEqual([]);
    }
    // From a manifest too.
    const file = join(dir, '.sidestory/retry-jitter/manifest.json');
    writeFileSync(file, readFileSync(file, 'utf8').replace('"base": "main"', '"base": "-x"'));
    const r = await run([join(dir, '.sidestory/retry-jitter'), '--coverage']);
    expect(r.code).toBe(1);
    expect(r.calls).toEqual([]);
  });

  it('--head takes full ids only', async () => {
    const r = await run(['--coverage', '--base', 'main', '--head', 'HEAD', '--repo', copy()]);
    expect(r.code).toBe(1);
    expect(r.calls).toEqual([]);
  });
});

describe('the repository is found in JS', () => {
  it('a bare repository planted in .sidestory/x is never used, nor its config run', async () => {
    const dir = copy();
    const planted = join(dir, '.sidestory/x');
    mkdirSync(join(planted, 'objects'), { recursive: true });
    mkdirSync(join(planted, 'refs/heads'), { recursive: true });
    writeFileSync(join(planted, 'HEAD'), 'ref: refs/heads/main\n');
    const marker = join(base, `BARE-MARKER-${n}`);
    writeFileSync(join(planted, 'config'), `[core]\n\tbare = true\n\trepositoryformatversion = 0\n\tfsmonitor = "touch ${marker}"\n\tpager = "touch ${marker}"\n[alias]\n\tdiff = "!touch ${marker}"\n`);
    expect((await findRepository(planted))!.root).toBe(dir);
    const r = await run(['--coverage', '--base', 'main', '--repo', planted], { GIT_DIR: '' });
    expect(r.code).toBe(3);
    for (const c of r.calls) expect(c.argv).toContain(`--git-dir=${join(dir, '.git')}`);
    expect(existsSync(marker)).toBe(false);
  });

  it('a .git file pointing at a folder (worktrees) is followed; one pointing nowhere is not', async () => {
    const dir = join(base, `gitfile${n++}`);
    mkdirSync(join(dir, 'sub'), { recursive: true });
    mkdirSync(join(base, 'real-gitdir'), { recursive: true });
    writeFileSync(join(dir, '.git'), `gitdir: ${join(base, 'real-gitdir')}\n`);
    expect(await findRepository(join(dir, 'sub'))).toEqual({ root: dir, gitDir: join(base, 'real-gitdir') });
    writeFileSync(join(dir, '.git'), 'gitdir: /does/not/exist\n');
    expect((await findRepository(join(dir, 'sub')))?.root).not.toBe(dir);
  });
});

describe('clean filters', () => {
  /** A filter.x.clean that writes a marker, selected by the branch's .gitattributes, with a racily modified file. */
  function withFilter(): { dir: string; marker: string } {
    const dir = copy();
    const marker = join(base, `FILTER-MARKER-${n++}`);
    writeFileSync(join(dir, '.gitattributes'), '*.ts filter=x\n');
    git(dir, 'add', '.gitattributes');
    git(dir, 'commit', '-q', '--no-verify', '-m', 'attributes');
    git(dir, 'config', 'filter.x.clean', `sh -c 'touch ${marker}; cat'`);
    // Same content, new time: git diff must re-read it, which runs the clean filter when one applies.
    const t = new Date(Date.now() + 5000);
    utimesSync(join(dir, 'src/retry/retry.ts'), t, t);
    return { dir, marker };
  }

  it('the scenario is real: plain git diff runs the filter', () => {
    const { dir, marker } = withFilter();
    git(dir, 'diff', '--raw', 'main');
    expect(existsSync(marker)).toBe(true);
  });

  it('committed mode never runs it (tree to tree)', async () => {
    const { dir, marker } = withFilter();
    const r = await run(['--coverage', '--base', 'main', '--committed', '--repo', dir]);
    expect(r.code).toBe(3);
    expect(existsSync(marker)).toBe(false);
  });

  it('working tree mode keeps it from running (git 2.40+: --attr-source)', async () => {
    const { dir, marker } = withFilter();
    const r = await run(['--coverage', '--base', 'main', '--repo', dir]);
    expect(r.code).toBe(3);
    expect(existsSync(marker)).toBe(false);
    const diff = r.calls.find((c) => c.argv.includes('diff'))!;
    expect(diff.argv.find((a) => a.startsWith('--attr-source='))).toMatch(/^--attr-source=[0-9a-f]{40}$/);
  });

  it('on an older git, working tree mode refuses a filter other than git-lfs', async () => {
    const { dir, marker } = withFilter();
    const r = await run(['--coverage', '--base', 'main', '--repo', dir], { SIDESTORY_TEST_VERSION: '2.39.5' });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/error working-tree-refused: git 2\.39 can't keep the filter "x" \(filter\.x\.clean\) from running/);
    expect(r.calls.some((c) => c.argv.includes('diff'))).toBe(false);
    expect(existsSync(marker)).toBe(false);
    // git-lfs's standard filters are fine.
    const lfs = copy();
    git(lfs, 'config', 'filter.lfs.clean', 'git-lfs clean -- %f');
    git(lfs, 'config', 'filter.lfs.process', 'git-lfs filter-process');
    expect((await run(['--coverage', '--base', 'main', '--repo', lfs], { SIDESTORY_TEST_VERSION: '2.39.5' })).code).toBe(3);
  });

  it('info/attributes selecting a filter refuses working tree mode', async () => {
    const dir = copy();
    mkdirSync(join(dir, '.git/info'), { recursive: true });
    writeFileSync(join(dir, '.git/info/attributes'), '* filter=x\n');
    const r = await run(['--coverage', '--base', 'main', '--repo', dir]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('working-tree-refused');
    expect((await run(['--coverage', '--base', 'main', '--committed', '--repo', dir])).code).toBe(3);
  });
});

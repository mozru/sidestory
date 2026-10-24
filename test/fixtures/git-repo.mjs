// The git fixture for the Changes view (docs/CHANGES-PLAN.md §16.1), built deterministically: fixed author, dates
// and no system or global config. `main` has an initial commit; `feature` (checked out) adds, modifies, deletes
// and renames files in three commits; then `main` moves on (a new file, an edit) after the fork, so only a
// three-dot merge diff (merge-base → feature) leaves main's later work out.
// Usage: node test/fixtures/git-repo.mjs <dir> [--many <n>]   (--many adds n changed files under gen/, for perf)
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, unlinkSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('usage: git-repo.mjs <dir> [--many <n>]');
const many = process.argv.includes('--many') ? Number(process.argv[process.argv.indexOf('--many') + 1]) : 0;

let clock = Date.parse('2026-01-01T00:00:00Z') / 1000;
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.com',
};
const run = (...args) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'init.defaultBranch=main', ...args], { cwd: dir, env: { ...env, GIT_AUTHOR_DATE: `${clock} +0000`, GIT_COMMITTER_DATE: `${clock} +0000` }, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const write = (p, text) => {
  mkdirSync(dirname(join(dir, p)), { recursive: true });
  writeFileSync(join(dir, p), text);
};
const lines = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix} line ${i + 1};`).join('\n') + '\n';
const commit = (msg) => {
  clock += 3600;
  run('add', '-A');
  run('commit', '-q', '--no-verify', '-m', msg);
};

rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
run('init', '-q');
write('src/retry/retry.ts', lines('export const retry', 20));
write('old/backoff.ts', lines('export const backoff', 30));
write('legacy/sleep.ts', lines('export const sleep', 24));
write('test/retry.test.ts', lines('test retry', 10));
write('docs/notes.md', '# Notes\n\nOn main.\n');
write('README.md', '# Fixture\n');
commit('Initial');

run('checkout', '-q', '-b', 'feature');
// 1: modify (+3 −1) and add.
const retry = lines('export const retry', 20).split('\n');
retry.splice(4, 1, 'export const retryWithJitter = 1;', 'export const jitter = 2;', 'export const ceiling = 3;', 'export const extra = 4;');
write('src/retry/retry.ts', retry.join('\n'));
write('src/retry/jitter.ts', lines('export const jitter', 19));
commit('Add jitter');
// 2: delete and rename (with a small edit, still a rename at git's 50%).
unlinkSync(join(dir, 'legacy/sleep.ts'));
mkdirSync(join(dir, 'src/retry'), { recursive: true });
renameSync(join(dir, 'old/backoff.ts'), join(dir, 'src/retry/backoff.ts'));
const backoff = lines('export const backoff', 30).split('\n');
backoff[0] = 'export const backoff line 1 (renamed);';
backoff[1] = 'export const backoff line 2 (renamed);';
write('src/retry/backoff.ts', backoff.join('\n'));
commit('Move backoff, drop sleep');
// 3: the test.
write('test/retry.test.ts', lines('test retry', 10) + lines('test jitter', 30));
for (let i = 0; i < many; i++) write(`gen/part-${Math.floor(i / 100)}/file-${i}.ts`, lines(`export const g${i}`, 3));
commit('Test jitter');

// main moves on after the fork: none of this is in feature's merge diff.
run('checkout', '-q', 'main');
write('main-only.ts', 'export const onMain = true;\n');
write('docs/notes.md', '# Notes\n\nOn main, edited after the fork.\n');
commit('Main moves on');
run('checkout', '-q', 'feature');
process.stdout.write(`${run('rev-parse', 'HEAD').trim()}\n`);

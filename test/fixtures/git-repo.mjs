// The git fixture for branch coverage and steps in diffs (docs/CHANGES-PLAN.md §16.1), built deterministically: fixed author, dates
// and no system or global config. `main` has an initial commit; `feature` (checked out) adds, modifies, deletes
// and renames files in three commits; then `main` moves on (a new file, an edit) after the fork, so only a
// three-dot merge diff (merge-base → feature) leaves main's later work out.
// Usage: node test/fixtures/git-repo.mjs <dir> [--many <n>] [--explained]
//   --many adds n changed files under gen/, for perf.
//   --explained adds a fourth commit on feature with .sidestory/retry-jitter/ (base main, version 3) that explains
//   part of the branch (docs/CHANGES-PLAN.md §6.3): jitter.ts and the retry.ts replacement by head-side steps,
//   the deleted legacy/sleep.ts by a base-side step, backoff.ts's renamed lines by a trivial mark with a why (which
//   also covers backoff.ts's move from old/, a one-file move group, CHANGES-PLAN §5.1),
//   and test/retry.test.ts left unexplained, so `check.cjs --coverage --base main` exits 3.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, unlinkSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('usage: git-repo.mjs <dir> [--many <n>]');
const many = process.argv.includes('--many') ? Number(process.argv[process.argv.indexOf('--many') + 1]) : 0;
const explained = process.argv.includes('--explained');

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
if (explained) {
  const quote = (text, start, end) => ({ exact: text.split('\n').slice(start - 1, end).join('\n'), prefix: '', suffix: '', norm: 'ws' });
  const retryNow = retry.join('\n');
  const sleepThen = lines('export const sleep', 24);
  const jitterNow = lines('export const jitter', 19);
  write('.sidestory/retry-jitter/manifest.json', `${JSON.stringify({
    version: 3,
    id: '01JC0RETRYJ1TTER000000000A',
    title: 'Retry with jitter',
    summary: 'Why retries now wait a random time below a growing ceiling.',
    base: 'main',
    anchors: {
      jitter: { file: 'src/retry/jitter.ts', range: [1, 19], quote: quote(jitterNow, 1, 19) },
      'retry-loop': { file: 'src/retry/retry.ts', range: [4, 9], quote: quote(retryNow, 4, 9) },
      'old-sleep': { file: 'legacy/sleep.ts', side: 'base', range: [1, 24], quote: quote(sleepThen, 1, 24) },
      'trivial-1': { file: 'src/retry/backoff.ts', range: [1, 2], trivial: true, why: 'the file moved; only its first lines say so' },
    },
  }, null, 2)}\n`);
  write('.sidestory/retry-jitter/sidestory.html', [
    '<!doctype html>',
    '<html><head><meta charset="utf-8"><title>Retry with jitter</title></head><body>',
    '<h1>Retry with jitter</h1>',
    '<section data-explain-anchor="retry-loop"><h2>The retry loop</h2><p>The fixed delay becomes a ceiling with jitter.</p></section>',
    '<section data-explain-anchor="jitter"><h2>Jitter</h2><p>A random wait below the ceiling.</p></section>',
    '<section data-explain-anchor="old-sleep"><h2>No more sleep</h2><p>The old fixed sleep is gone.</p></section>',
    '</body></html>',
    '',
  ].join('\n'));
  commit('Explain retry jitter');
}

// main moves on after the fork: none of this is in feature's merge diff.
run('checkout', '-q', 'main');
write('main-only.ts', 'export const onMain = true;\n');
write('docs/notes.md', '# Notes\n\nOn main, edited after the fork.\n');
commit('Main moves on');
run('checkout', '-q', 'feature');
process.stdout.write(`${run('rev-parse', 'HEAD').trim()}\n`);

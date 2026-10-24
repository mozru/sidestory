// src/cli/git.ts's process handling (docs/CHANGES-PLAN.md §13.2): no transport even when the repository's config
// allows one (GIT_ALLOW_PROTOCOL), a per-call timeout, the output cap failing once without keeping more, PATH under
// every spelling Windows allows, and working tree reads under the file system path rule.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Git, gitEnv, GitError, pathKeys } from '../../src/cli/git.ts';

const cleanEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: cleanEnv, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const realGit = execFileSync('sh', ['-c', 'command -v git']).toString().trim();

let base = '';
let repo = '';

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'cx-gitrun-')));
  repo = join(base, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'a');
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

const open = (opts: { gitPath?: string } = {}) => new Git({ root: repo, gitDir: join(repo, '.git') }, { gitPath: opts.gitPath ?? realGit, env: cleanEnv });

describe.skipIf(process.platform === 'win32')('running git', () => {
  it("refuses ext:: even when the repository's config allows it (protocol.allow=never alone doesn't)", async () => {
    const marker = join(base, 'EXT-MARKER');
    git(repo, 'config', 'protocol.ext.allow', 'always');
    git(repo, 'config', 'remote.evil.url', `ext::sh -c touch% ${marker}`);
    try {
      // The scenario is real: with only `-c protocol.allow=never`, the per-protocol config wins and the command runs.
      execFileSync('git', ['-c', 'protocol.allow=never', 'fetch', '-q', 'evil'], { cwd: repo, env: cleanEnv, stdio: 'ignore' }).toString();
    } catch {
      // git fails after running the command: the transport speaks no protocol.
    }
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    const g = open();
    try {
      const err = await g.run(['fetch', '-q', 'evil']).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(GitError);
      expect((err as GitError).stderr).toMatch(/transport 'ext' not allowed/);
      expect(existsSync(marker)).toBe(false);
    } finally {
      await g.dispose();
      git(repo, 'config', '--unset', 'protocol.ext.allow');
      git(repo, 'config', '--remove-section', 'remote.evil');
    }
  });

  it('a call that hangs is killed after its timeout', async () => {
    const slow = join(base, 'slow-git');
    writeFileSync(slow, '#!/bin/sh\nsleep 30\n');
    chmodSync(slow, 0o755);
    const g = open({ gitPath: slow });
    const t0 = Date.now();
    try {
      await expect(g.run(['version'], { timeoutMs: 300 })).rejects.toThrow(/no answer after/);
      expect(Date.now() - t0).toBeLessThan(5000);
    } finally {
      await g.dispose();
    }
  });

  it('output past the cap fails once and keeps nothing; exact-size output lands in one buffer', async () => {
    const loud = join(base, 'loud-git');
    writeFileSync(loud, '#!/bin/sh\nhead -c 200000 /dev/zero\n');
    chmodSync(loud, 0o755);
    const g = open({ gitPath: loud });
    try {
      await expect(g.run(['version'], { maxBytes: 1000 })).rejects.toThrow(/output larger than 1000 bytes/);
      const r = await g.run(['version'], { maxBytes: 200_000, exact: true });
      expect(r.stdout.length).toBe(200_000);
      await expect(g.run(['version'], { maxBytes: 199_999, exact: true })).rejects.toThrow(/output larger/);
    } finally {
      await g.dispose();
    }
  });

  it('blobs come back intact from the one exact-size batch buffer', async () => {
    const g = open();
    try {
      const id = git(repo, 'rev-parse', 'HEAD:a.txt');
      const { bytes } = await g.blobs([id]);
      expect(new TextDecoder().decode(bytes.get(id))).toBe('a\n');
    } finally {
      await g.dispose();
    }
  });

  it('working tree reads refuse device names, trailing dots and ":" (NTFS streams) before touching the disk', async () => {
    writeFileSync(join(repo, 'con'), 'x\n');
    writeFileSync(join(repo, 'a.txt:zone'), 'x\n');
    mkdirSync(join(repo, 'sub'), { recursive: true });
    const g = open();
    try {
      expect(await g.readWorkingFile('con')).toEqual({ error: 'unsupported' });
      expect(await g.readWorkingFile('a.txt:zone')).toEqual({ error: 'unsupported' });
      expect(await g.readWorkingFile('sub')).toEqual({ error: 'directory' });
      expect('bytes' in (await g.readWorkingFile('a.txt'))).toBe(true);
    } finally {
      await g.dispose();
      rmSync(join(repo, 'con'));
      rmSync(join(repo, 'a.txt:zone'));
    }
  });
});

describe('PATH in the child environment', () => {
  it('Windows: every spelling of PATH is replaced by one filtered value', () => {
    const env = gitEnv('C:\\repo', { PATH: 'C:\\repo;C:\\Windows', Path: 'C:\\repo\\bin', GIT_DIR: 'x' }, 'win32');
    const keys = Object.keys(env).filter((k) => k.toUpperCase() === 'PATH');
    expect(keys).toEqual(['PATH']);
    expect(env.PATH).not.toContain('C:\\repo');
    expect(env.GIT_ALLOW_PROTOCOL).toBe('none');
  });

  it('pathKeys: an exact PATH first on Windows; only PATH elsewhere', () => {
    expect(pathKeys({ Path: 'a', PATH: 'b', path: 'c' }, 'win32')).toEqual(['PATH', 'Path', 'path']);
    expect(pathKeys({ Path: 'a' }, 'win32')).toEqual(['Path']);
    expect(pathKeys({ Path: 'a', PATH: 'b' }, 'linux')).toEqual(['PATH']);
    expect(pathKeys({ Path: 'a' }, 'darwin')).toEqual([]);
  });
});

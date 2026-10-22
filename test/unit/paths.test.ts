import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { assertSize, realPathInside, TooLargeError } from '../../src/extension/paths.ts';

describe('realPathInside', () => {
  let base = '';
  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'cx-paths-'));
    mkdirSync(join(base, 'repo/src'), { recursive: true });
    mkdirSync(join(base, 'repo2'));
    mkdirSync(join(base, 'outside'));
    writeFileSync(join(base, 'repo/src/a.ts'), 'x');
    writeFileSync(join(base, 'repo2/b.ts'), 'x');
    writeFileSync(join(base, 'outside/secret'), 'x');
    symlinkSync(join(base, 'outside/secret'), join(base, 'repo/src/link-out'));
    symlinkSync(join(base, 'repo/src/a.ts'), join(base, 'repo/src/link-in'));
    symlinkSync(join(base, 'repo'), join(base, 'repo-link'));
  });

  it('accepts files inside the root', async () => {
    expect(await realPathInside(join(base, 'repo/src/a.ts'), join(base, 'repo'))).toMatch(/repo\/src\/a\.ts$/);
  });

  it('follows symlinks that stay inside', async () => {
    expect(await realPathInside(join(base, 'repo/src/link-in'), join(base, 'repo'))).toMatch(/repo\/src\/a\.ts$/);
  });

  it('refuses symlinks that point outside', async () => {
    expect(await realPathInside(join(base, 'repo/src/link-out'), join(base, 'repo'))).toBeNull();
  });

  it('does not treat a sibling with a shared prefix as inside', async () => {
    expect(await realPathInside(join(base, 'repo2/b.ts'), join(base, 'repo'))).toBeNull();
  });

  it('works when the root itself is a symlink', async () => {
    expect(await realPathInside(join(base, 'repo-link/src/a.ts'), join(base, 'repo-link'))).toMatch(/repo\/src\/a\.ts$/);
  });

  it('returns null for missing files', async () => {
    expect(await realPathInside(join(base, 'repo/nope'), join(base, 'repo'))).toBeNull();
  });

  it('assertSize refuses big files', async () => {
    await expect(assertSize(join(base, 'repo/src/a.ts'), 0)).rejects.toBeInstanceOf(TooLargeError);
    await expect(assertSize(join(base, 'repo/src/a.ts'), 10)).resolves.toBeUndefined();
  });
});

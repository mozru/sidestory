import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { assertSize, realPathInside, TooLargeError, writeFileAtomic } from '../../src/extension/paths.ts';

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
    symlinkSync(join(base, 'outside/secret'), join(base, 'repo/src/link-out'), 'file');
    symlinkSync(join(base, 'repo/src/a.ts'), join(base, 'repo/src/link-in'), 'file');
    // A junction works on Windows without extra privileges; elsewhere the type is ignored.
    symlinkSync(join(base, 'repo'), join(base, 'repo-link'), 'junction');
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

describe('writeFileAtomic', () => {
  it('replaces the file and leaves no temporary files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cx-write-'));
    writeFileSync(join(dir, 'm.json'), 'old');
    await writeFileAtomic(join(dir, 'm.json'), 'new');
    expect(readFileSync(join(dir, 'm.json'), 'utf8')).toBe('new');
    expect(readdirSync(dir)).toEqual(['m.json']);
  });

  it('never writes through links planted next to the file or as the file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cx-write-'));
    writeFileSync(join(dir, 'victim'), 'precious');
    writeFileSync(join(dir, 'm.json'), 'old');
    // A planted link at a predictable temp name must not matter.
    for (let i = 0; i < 50; i++) symlinkSync(join(dir, 'victim'), join(dir, `m.json.${i}.tmp`), 'file');
    await writeFileAtomic(join(dir, 'm.json'), 'new');
    expect(readFileSync(join(dir, 'victim'), 'utf8')).toBe('precious');
    symlinkSync(join(dir, 'victim'), join(dir, 'link.json'), 'file');
    await expect(writeFileAtomic(join(dir, 'link.json'), 'x')).rejects.toThrow(/link/);
    expect(readFileSync(join(dir, 'victim'), 'utf8')).toBe('precious');
  });
});

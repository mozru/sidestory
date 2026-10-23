// Discovery exclusions (docs/NAVIGATION-PLAN.md §6.3): the built-in list merged with files.exclude.
import { describe, expect, it } from 'vitest';
import { DEFAULT_EXCLUDES, EXCLUDE_LIMITS, excludePatterns, expandBraces, globMatcher, joinGlobs } from '../../src/core/glob.ts';

describe('excludePatterns', () => {
  it('adds files.exclude entries set to true, and drops false and `when` entries', () => {
    const p = excludePatterns({ '**/gen': true, '**/keep': false, '**/*.js': { when: '$(basename).ts' }, '**/vendor/': true });
    expect(p.slice(0, DEFAULT_EXCLUDES.length)).toEqual(DEFAULT_EXCLUDES);
    expect(p).toContain('**/gen');
    expect(p).toContain('**/gen/**');
    expect(p).toContain('**/vendor');
    expect(p.join()).not.toContain('keep');
    expect(p.join()).not.toContain('*.js');
  });
  it('tolerates a missing or malformed setting', () => {
    expect(excludePatterns(undefined)).toEqual(DEFAULT_EXCLUDES);
    expect(excludePatterns(['x'])).toEqual(DEFAULT_EXCLUDES);
    expect(excludePatterns('x')).toEqual(DEFAULT_EXCLUDES);
  });
});

describe('caps on files.exclude', () => {
  it('takes at most 256 entries, deduplicated, and warns about the rest', () => {
    const many = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`**/gen${i}`, true]));
    const warnings: string[] = [];
    const p = excludePatterns({ ...many, '**/node_modules': true }, (m) => warnings.push(m));
    expect(new Set(p).size).toBe(p.length);
    expect(p.length).toBeLessThanOrEqual(DEFAULT_EXCLUDES.length + 2 * EXCLUDE_LIMITS.entries);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/more than 256 entries/);
  });

  it('joins at most 1,024 alternatives into a glob of bounded length, defaults first', () => {
    const braces = Array.from({ length: 300 }, (_, i) => `**/x${i}/{a,b,c,d,e,f,g,h}`);
    const glob = joinGlobs([...DEFAULT_EXCLUDES, ...braces]);
    expect(glob.split(',').length).toBeLessThanOrEqual(EXCLUDE_LIMITS.alternatives);
    expect(glob.length).toBeLessThanOrEqual(EXCLUDE_LIMITS.globChars);
    for (const d of DEFAULT_EXCLUDES) expect(glob).toContain(d);
    const long = Array.from({ length: 200 }, (_, i) => `**/${'y'.repeat(900)}${i}`);
    expect(joinGlobs(long).length).toBeLessThanOrEqual(EXCLUDE_LIMITS.globChars);
  });
});

describe('braces', () => {
  it('expands groups, nested too, so one glob never nests a brace group', () => {
    expect(expandBraces('a/{b,c}/d')).toEqual(['a/b/d', 'a/c/d']);
    expect(expandBraces('{x,{y,z}}.ts').sort()).toEqual(['x.ts', 'y.ts', 'z.ts']);
    expect(expandBraces('plain')).toEqual(['plain']);
    expect(expandBraces('broken{a,b')).toEqual(['brokena,b']);
  });
  it('caps a pattern at 64 alternatives', () => {
    const big = `{${Array.from({ length: 10 }, (_, i) => i).join(',')}}{${Array.from({ length: 10 }, (_, i) => i).join(',')}}`;
    expect(expandBraces(big).length).toBeLessThanOrEqual(64);
  });
  it('joins into one group with no nested braces', () => {
    const g = joinGlobs(['**/a/**', '**/{b,c}/**']);
    expect(g).toBe('{**/a/**,**/b/**,**/c/**}');
    expect(g.slice(1, -1)).not.toMatch(/[{}]/);
    expect(joinGlobs(['only'])).toBe('only');
  });
});

describe('globMatcher', () => {
  const m = globMatcher(excludePatterns({ '**/gen': true, 'docs/{a,b}': true }));
  it.each([
    ['node_modules/x/.sidestory/a/manifest.json', true],
    ['pkg/node_modules/.sidestory/a/manifest.json', true],
    ['gen/.sidestory/a/manifest.json', true],
    ['src/gen/.sidestory/a/manifest.json', true],
    ['docs/a/.sidestory/x/manifest.json', true],
    ['docs/c/.sidestory/x/manifest.json', false],
    ['.sidestory/a/manifest.json', false],
    ['generated/.sidestory/a/manifest.json', false],
  ])('%s → %s', (path, excluded) => {
    expect(m(path)).toBe(excluded);
  });
  it('supports ? and [] classes', () => {
    const g = globMatcher(['a?c', 'x[0-9]', 'y[!0-9]']);
    expect(g('abc')).toBe(true);
    expect(g('a/c')).toBe(false);
    expect(g('x5')).toBe(true);
    expect(g('ya')).toBe(true);
    expect(g('y5')).toBe(false);
  });

  it('never backtracks: a ReDoS-shaped pattern against a long hostile name stays fast', () => {
    const g = globMatcher([`**/*${'a*'.repeat(20)}b`, '**/**/**/**/**/x']);
    const name = `src/${'a'.repeat(3000)}c/.sidestory/x/manifest.json`;
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) expect(g(name)).toBe(false);
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it('never throws on malformed patterns: a reversed class matches nothing, an unclosed one is literal', () => {
    const g = globMatcher(['[z-a]', 'q[', '**/[]x']);
    expect(g('m')).toBe(false);
    expect(g('q[')).toBe(true);
    expect(() => g('a/b')).not.toThrow();
  });

  it('ignores over-long paths and patterns', () => {
    expect(globMatcher(['**'])('a/'.repeat(3000))).toBe(false);
    expect(globMatcher(['x'.repeat(2000)])('x'.repeat(2000))).toBe(false);
  });
});

import { transform } from 'sucrase';
import { describe, expect, it } from 'vitest';
import { analyzeSource, finishModule } from '../../src/extension/widgets/analyze.ts';
import { insertLoopGuards, LOOP_GUARD_CALL } from '../../src/extension/widgets/loop-guards.ts';
import { LOOP_GUARD_HOOK } from '../../src/shared/widget-imports.ts';

/** The compiler's full pipeline for one module, without imports. */
function compileModule(src: string, file = 'w.tsx'): string {
  const a = analyzeSource(file, src);
  expect(a.errors).toEqual([]);
  const r = finishModule(file, a, new Map());
  if ('error' in r) throw new Error(r.error.message);
  return r.code;
}

/** Runs CommonJS code with a guard hook that counts calls and throws after `limit`. */
function run(code: string, limit = Infinity): { exports: Record<string, unknown>; calls: number } {
  const g = globalThis as Record<string, unknown>;
  let calls = 0;
  g[LOOP_GUARD_HOOK] = () => {
    if (++calls > limit) throw new Error('loop guard tripped');
  };
  try {
    const module = { exports: {} as Record<string, unknown> };
    new Function('require', 'module', 'exports', code)(() => ({}), module, module.exports);
    return { exports: module.exports, calls };
  } finally {
    delete g[LOOP_GUARD_HOOK];
  }
}

const count = (s: string, sub: string) => s.split(sub).length - 1;

describe('loop guards', () => {
  it('guards braced bodies of every loop kind', () => {
    const out = insertLoopGuards('for (;;) { a(); }\nfor (const k in o) { b(); }\nfor (const v of xs) { c(); }\nwhile (x) { d(); }\ndo { e(); } while (x);');
    expect(count(out, LOOP_GUARD_CALL)).toBe(5);
    expect(out.split('\n')).toHaveLength(5);
    expect(out).toContain(`for (;;) {${LOOP_GUARD_CALL} a(); }`);
  });

  it('wraps unbraced bodies so they keep their meaning', () => {
    const out = insertLoopGuards('for (;;) a();\nwhile (x) if (y) b(); else c();\ndo d(); while (x);\nwhile (x);');
    expect(out).toContain(`for (;;) {${LOOP_GUARD_CALL}a();}`);
    expect(out).toContain(`while (x) {${LOOP_GUARD_CALL}if (y) b(); else c();}`);
    expect(out).toContain(`do {${LOOP_GUARD_CALL}d();} while (x);`);
    expect(out).toContain(`while (x){${LOOP_GUARD_CALL};}`);
  });

  it('keeps labels on their loops', () => {
    const out = insertLoopGuards('outer: for (;;) inner: for (;;) continue outer;');
    expect(out).toBe(`outer: for (;;) {${LOOP_GUARD_CALL}inner: for (;;) {${LOOP_GUARD_CALL}continue outer;}}`);
  });

  it('preserves line numbers: guarded output has the same lines as Sucrase output', () => {
    const src = [
      'import { useState } from "react";',
      'export default function W({ n }: { n: number }) {',
      '  let s = 0;',
      '  for (let i = 0; i < n; i++)',
      '    s += i;',
      '  outer: while (s > 0)',
      '    for (const k of [1, 2])',
      '      if (k === 2) continue outer;',
      '      else s -= k;',
      '  do s++',
      '  while (s < 3)',
      '  const [v] = useState(s);',
      '  if (v < 0) throw new Error("line 13");',
      '  return <div>{v}</div>;',
      '}',
    ].join('\n');
    const plain = transform(src, { transforms: ['typescript', 'jsx', 'imports'], jsxRuntime: 'automatic', production: true, disableESTransforms: true }).code;
    const guarded = compileModule(src);
    expect(count(guarded, LOOP_GUARD_CALL)).toBe(4);
    expect(guarded.split('\n')).toHaveLength(plain.split('\n').length);
    expect(guarded.split('\n').findIndex((l) => l.includes('"line 13"'))).toBe(12);
    expect(plain.split('\n').findIndex((l) => l.includes('"line 13"'))).toBe(12);
  });

  it('breaks an infinite loop when the runtime hook throws', () => {
    const code = compileModule('export let n = 0;\nwhile (true) n++;');
    expect(() => run(code, 1000)).toThrow('loop guard tripped');
  });

  it('runs loops to the same results as unguarded code', () => {
    const src = [
      'let a = 0, b = 0, c = 0, d = 0, e = 0;',
      'for (let i = 0; i < 10; i++) if (i % 2) a++; else b++;',
      'outer: for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) { if (j > i) continue outer; c++; }',
      'let k = 0',
      'do k++',
      'while (k < 7)',
      'for (const x of [1, 2, 3]) d += x',
      'for (const key in { p: 1, q: 2 }) e++;',
      'let w = 0; while (w < 4) w++',
      'export const result = { a, b, c, d, e, k, w };',
    ].join('\n');
    const { exports, calls } = run(compileModule(src, 'w.ts'));
    expect(exports.result).toEqual({ a: 5, b: 5, c: 15, d: 6, e: 2, k: 7, w: 4 });
    // for-if 10; outer 5 + inner 19 (the iteration that continues outer counts too); do 7; of 3; in 2; while 4.
    expect(calls).toBe(10 + 5 + 19 + 7 + 3 + 2 + 4);
  });

  it('counts each iteration of nested loops', () => {
    const { calls } = run(compileModule('let s = 0;\nfor (let i = 0; i < 3; i++)\n  for (let j = 0; j < 4; j++)\n    s++;\nexport { s };', 'w.ts'));
    expect(calls).toBe(3 + 12);
  });
});

// data-explain-code links (docs/AUTHORING-PLAN.md §8.1) and the protocol messages around them (§9.1).
import { describe, expect, it } from 'vitest';
import { formatCodeLink, isCodeLink, MAX_CODE_LINKS, parseCodeLink, parseCodeTarget } from '../../src/shared/code-link.ts';
import { fromWebviewSchema } from '../../src/shared/protocol.ts';

describe('parseCodeLink', () => {
  it.each([
    ['rtl/dma_fifo.sv', { path: 'rtl/dma_fifo.sv' }],
    ['rtl/dma_fifo.sv#L34', { path: 'rtl/dma_fifo.sv', target: 'L34' }],
    ['rtl/dma_fifo.sv#L34-L39', { path: 'rtl/dma_fifo.sv', target: 'L34-L39' }],
    ['rtl/dma_fifo.sv#driver(count_q)', { path: 'rtl/dma_fifo.sv', target: 'driver(count_q)' }],
    ['rtl/dma_ctrl.sv#dma_ctrl.driver(state_d).case(IDLE)', { path: 'rtl/dma_ctrl.sv', target: 'dma_ctrl.driver(state_d).case(IDLE)' }],
    ['rtl/dma_top.sv#u_ctrl(.rd_start)', { path: 'rtl/dma_top.sv', target: 'u_ctrl(.rd_start)' }],
    ['rtl/x.sv#driver(x[7:4])', { path: 'rtl/x.sv', target: 'driver(x[7:4])' }],
    ['rtl/x.sv#driver(st).case({a, b})', { path: 'rtl/x.sv', target: 'driver(st).case({a, b})' }],
    ['pkg/a.sv#dma_pkg::req_t', { path: 'pkg/a.sv', target: 'dma_pkg::req_t' }],
    ['  rtl/x.sv#L1  ', { path: 'rtl/x.sv', target: 'L1' }],
    ['rtl/x.sv#', { path: 'rtl/x.sv' }],
  ])('accepts %s', (value, link) => {
    expect(parseCodeLink(value)).toEqual(link);
  });

  it('takes the path from data-explain-code-file when it has none', () => {
    expect(parseCodeLink('#i_order_q', 'rtl/gemm.sv')).toEqual({ path: 'rtl/gemm.sv', target: 'i_order_q' });
    expect(parseCodeLink('', 'rtl/gemm.sv')).toEqual({ path: 'rtl/gemm.sv' });
    expect(parseCodeLink('rtl/own.sv#L2', 'rtl/gemm.sv')).toEqual({ path: 'rtl/own.sv', target: 'L2' });
    expect(parseCodeLink('#i_order_q')).toBeNull();
    expect(parseCodeLink('#x', '../outside.sv')).toBeNull();
  });

  it.each([
    '../secret.sv',
    '/etc/passwd',
    'C:/x.sv',
    'rtl\\x.sv',
    'https://evil.example/x.sv',
    '.git/config',
    'rtl/x.sv#L0',
    'rtl/x.sv#L5-L4',
    'rtl/x.sv#L10000001',
    'rtl/x.sv#L1-L99999999',
    'rtl/x.sv#9bad',
    'rtl/x.sv#driver(x',
    'rtl/x.sv#driver(x])',
    'rtl/x.sv#a b',
    'rtl/x.sv#a#b',
    'rtl/x.sv#a\u0000',
    `rtl/x.sv#${'a'.repeat(201)}`,
    'rtl/x.sv#ä',
  ])('refuses %s', (value) => {
    expect(parseCodeLink(value)).toBeNull();
  });

  it('formats canonically, and only canonical strings are links', () => {
    expect(formatCodeLink({ path: 'a/b.sv', target: 'L3' })).toBe('a/b.sv#L3');
    expect(formatCodeLink({ path: 'a/b.sv' })).toBe('a/b.sv');
    expect(isCodeLink('a/b.sv#L3')).toBe(true);
    expect(isCodeLink('a/b.sv#')).toBe(false);
    expect(isCodeLink(' a/b.sv')).toBe(false);
    expect(isCodeLink('#L3')).toBe(false);
  });

  it('parses line targets', () => {
    expect(parseCodeTarget('L10-L20')).toEqual({ kind: 'lines', start: 10, end: 20 });
    expect(parseCodeTarget('L10000000')).toEqual({ kind: 'lines', start: 10_000_000, end: 10_000_000 });
    expect(parseCodeTarget('i_order_q')).toEqual({ kind: 'symbol', path: 'i_order_q' });
  });
});

describe('protocol: openCode, codeTargets', () => {
  const ok = (m: unknown) => fromWebviewSchema.safeParse(m).success;

  it('accepts what the panel sends', () => {
    expect(ok({ type: 'openCode', path: 'rtl/x.sv' })).toBe(true);
    expect(ok({ type: 'openCode', path: 'rtl/x.sv', target: 'driver(x)' })).toBe(true);
    expect(ok({ type: 'codeTargets', sections: ['top', 'fsm'], refs: ['m-fifo'], links: ['rtl/x.sv#L3', 'rtl/y.sv'] })).toBe(true);
  });

  it.each([
    { type: 'openCode', path: '../x.sv' },
    { type: 'openCode', path: 'rtl/x.sv', target: 'L0' },
    { type: 'openCode', path: 'rtl/x.sv', target: '' },
    { type: 'openCode', path: 'rtl/x.sv', target: 'a'.repeat(300) },
    { type: 'codeTargets', sections: ['top', 'top'], refs: [], links: [] },
    { type: 'codeTargets', sections: ['__proto__x y'], refs: [], links: [] },
    { type: 'codeTargets', sections: [], refs: [], links: ['#L3'] },
    { type: 'codeTargets', sections: [], refs: [], links: ['../x.sv'] },
    { type: 'codeTargets', sections: [], refs: [], links: Array.from({ length: MAX_CODE_LINKS + 1 }, (_, i) => `f${i}.sv`) },
  ])('refuses %j', (m) => {
    expect(ok(m)).toBe(false);
  });
});

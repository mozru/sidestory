// fromWidgetSchema is the panel's check on everything an (untrusted) widget frame sends. It moved from classic zod
// to zod/mini to keep zod out of the panel bundle; these tests hold it to the classic schema it replaced, verbatim.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ANCHOR_ID_RE, isSafeRelativePath, RESERVED_SEGMENT } from '../../src/core/paths.ts';
import * as manifest from '../../src/core/manifest.ts';
import { CAPS } from '../../src/core/threads/caps.ts';
import * as threads from '../../src/core/threads/schema.ts';
import * as protocol from '../../src/shared/protocol.ts';
import { isWidgetSrc, MAX_WIDGETS } from '../../src/shared/widget-imports.ts';
import { fromWidgetSchema, MAX_WIDGET_HEIGHT, MAX_WIDGET_STATE_BYTES } from '../../src/shared/widget-protocol.ts';

// The classic schema as it was (d626718), with the old anchor id schema inlined.
const anchorIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const lines = z.tuple([z.number().int().min(1).max(100_000), z.number().int().min(1).max(100_000)]);
const identifier = z.string().regex(/^[A-Za-z_$][\w$]{0,99}$/);
const classic = z.discriminatedUnion('type', [
  z.object({ type: z.literal('boot') }),
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('height'), px: z.number().finite().min(0).max(MAX_WIDGET_HEIGHT) }),
  z.object({ type: z.literal('highlight'), lines: lines.optional(), anchor: anchorIdSchema.optional(), identifiers: z.array(identifier).max(20).optional() }),
  z.object({ type: z.literal('reveal'), id: z.number().int(), anchor: anchorIdSchema, lines: lines.optional(), highlight: z.array(identifier).max(20).optional() }),
  z.object({ type: z.literal('step'), id: z.number().int(), anchor: anchorIdSchema }),
  z.object({ type: z.literal('key'), id: z.number().int(), action: z.enum(['next', 'prev', 'back']) }),
  z.object({ type: z.literal('state'), json: z.string().max(MAX_WIDGET_STATE_BYTES) }),
  z.object({ type: z.literal('error'), message: z.string().max(2048), file: z.string().max(512).optional(), line: z.number().int().optional() }),
  z.object({ type: z.literal('activity') }),
  z.object({ type: z.literal('input') }),
  z.object({ type: z.literal('focusExit'), dir: z.enum(['forward', 'backward', 'escape', 'pointer', 'shortcut']) }),
  z.object({ type: z.literal('requestCode'), anchor: anchorIdSchema }),
  z.object({ type: z.literal('pong'), n: z.number().int() }),
]);

const show = (m: unknown) => JSON.stringify(m, (_, v) => (typeof v === 'bigint' ? `${v}n` : v))?.slice(0, 120) ?? String(m);

function same(msg: unknown): boolean {
  const a = classic.safeParse(msg);
  const b = fromWidgetSchema.safeParse(msg);
  expect(b.success, show(msg)).toBe(a.success);
  if (a.success && b.success) expect(b.data).toStrictEqual(a.data);
  return a.success;
}

const VALID: unknown[] = [
  { type: 'boot' },
  { type: 'ready' },
  { type: 'height', px: 0 },
  { type: 'height', px: 123.5 },
  { type: 'height', px: MAX_WIDGET_HEIGHT },
  { type: 'highlight' },
  { type: 'highlight', lines: [1, 100_000], anchor: 'a', identifiers: ['x', '$y', '_z9'] },
  { type: 'highlight', identifiers: Array(20).fill('id') },
  { type: 'reveal', id: 3, anchor: 'flow-1', lines: [2, 2], highlight: ['a'] },
  { type: 'reveal', id: -1, anchor: 'A'.repeat(64) },
  { type: 'step', id: 0, anchor: 'b_c' },
  { type: 'key', id: Number.MAX_SAFE_INTEGER, action: 'back' },
  { type: 'state', json: '' },
  { type: 'state', json: 'x'.repeat(MAX_WIDGET_STATE_BYTES) },
  { type: 'error', message: 'boom', file: 'w.tsx', line: 12 },
  { type: 'error', message: 'm'.repeat(2048), file: 'f'.repeat(512) },
  { type: 'activity' },
  { type: 'input' },
  ...['forward', 'backward', 'escape', 'pointer', 'shortcut'].map((dir) => ({ type: 'focusExit', dir })),
  { type: 'requestCode', anchor: 'z' },
  { type: 'pong', n: 7 },
  // Unknown keys are accepted and stripped.
  { type: 'boot', extra: 1, __proto__x: 'y' },
  { type: 'pong', n: 1, more: { deep: true } },
  { type: 'highlight', lines: undefined, anchor: undefined, identifiers: undefined },
  JSON.parse('{"type":"pong","n":2,"__proto__":{"polluted":true}}'),
];

const MALFORMED: unknown[] = [
  null, undefined, 0, 'boot', [], [{ type: 'boot' }], {}, { type: 'nope' }, { type: 1 }, { type: ['boot'] }, { Type: 'boot' },
  { type: 'height' },
  { type: 'height', px: -0.001 },
  { type: 'height', px: MAX_WIDGET_HEIGHT + 0.5 },
  { type: 'height', px: Infinity },
  { type: 'height', px: -Infinity },
  { type: 'height', px: NaN },
  { type: 'height', px: '10' },
  { type: 'height', px: null },
  { type: 'highlight', lines: [0, 1] },
  { type: 'highlight', lines: [1, 100_001] },
  { type: 'highlight', lines: [1.5, 2] },
  { type: 'highlight', lines: [1] },
  { type: 'highlight', lines: [1, 2, 3] },
  { type: 'highlight', lines: { 0: 1, 1: 2, length: 2 } },
  { type: 'highlight', lines: null },
  { type: 'highlight', anchor: '1a' },
  { type: 'highlight', anchor: 'a'.repeat(65) },
  { type: 'highlight', anchor: 'a b' },
  { type: 'highlight', anchor: 'a\n' },
  { type: 'highlight', identifiers: Array(21).fill('id') },
  { type: 'highlight', identifiers: ['1x'] },
  { type: 'highlight', identifiers: ['a'.repeat(101)] },
  { type: 'highlight', identifiers: ['a-b'] },
  { type: 'highlight', identifiers: 'a' },
  { type: 'reveal', id: 1 },
  { type: 'reveal', anchor: 'a' },
  { type: 'reveal', id: 1.5, anchor: 'a' },
  { type: 'reveal', id: 2 ** 53, anchor: 'a' },
  { type: 'reveal', id: -(2 ** 53), anchor: 'a' },
  { type: 'reveal', id: '1', anchor: 'a' },
  { type: 'reveal', id: 1, anchor: 'a', highlight: Array(21).fill('x') },
  { type: 'step', id: 1, anchor: '' },
  { type: 'step', id: 1n, anchor: 'a' },
  { type: 'key', id: 1, action: 'up' },
  { type: 'key', id: 1, action: 'NEXT' },
  { type: 'key', id: 1 },
  { type: 'state', json: 'x'.repeat(MAX_WIDGET_STATE_BYTES + 1) },
  { type: 'state', json: {} },
  { type: 'state' },
  { type: 'error', message: 'm'.repeat(2049) },
  { type: 'error', message: 'm', file: 'f'.repeat(513) },
  { type: 'error', message: 'm', line: 1.1 },
  { type: 'error', message: 'm', line: null },
  { type: 'error' },
  { type: 'focusExit', dir: 'left' },
  { type: 'focusExit' },
  { type: 'requestCode', anchor: '-a' },
  { type: 'pong', n: '1' },
  { type: 'pong', n: Infinity },
  { type: 'pong' },
];

describe('fromWidgetSchema (zod/mini) matches the classic schema', () => {
  it.each(VALID.map((m) => [show(m), m]))('accepts %s', (_, m) => {
    expect(same(m)).toBe(true);
  });

  it.each(MALFORMED.map((m) => [show(m), m]))('rejects %s', (_, m) => {
    expect(same(m)).toBe(false);
  });

  it('agrees on random mutations of valid messages', () => {
    let seed = 1;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const values: unknown[] = [
      undefined, null, true, 0, -0, 1, -1, 0.5, 1e21, 2 ** 53, 2 ** 53 - 1, -(2 ** 53) + 1, 100_000, 100_001, 20_000, 20_001, NaN, Infinity,
      '', 'a', '1', 'a-b', 'a b', '$x', 'next', 'pointer', 'x'.repeat(64), 'x'.repeat(65), 'x'.repeat(2049), [], [1], [1, 2], [0, 2], [1, 2, 3],
      ['a'], Array(21).fill('a'), {}, { type: 'boot' },
    ];
    const keys = ['type', 'px', 'lines', 'anchor', 'identifiers', 'id', 'highlight', 'action', 'json', 'message', 'file', 'line', 'dir', 'n', 'other'];
    let accepted = 0;
    for (let i = 0; i < 20_000; i++) {
      const m = { ...(pick(VALID) as object) } as Record<string, unknown>;
      for (let k = 1 + Math.floor(rnd() * 3); k > 0; k--) {
        const key = pick(keys);
        if (rnd() < 0.2) delete m[key];
        else m[key] = key === 'type' && rnd() < 0.7 ? (pick(VALID) as { type: string }).type : pick(values);
      }
      if (same(m)) accepted++;
    }
    // Both outcomes are well represented.
    expect(accepted).toBeGreaterThan(2000);
    expect(accepted).toBeLessThan(18_000);
  });
});

describe('zod-free modules keep the old exports', () => {
  it('re-exports the same values from the old modules', () => {
    expect(manifest.isSafeRelativePath).toBe(isSafeRelativePath);
    expect(manifest.RESERVED_SEGMENT).toBe(RESERVED_SEGMENT);
    expect(threads.CAPS).toBe(CAPS);
    expect(protocol.isWidgetSrc).toBe(isWidgetSrc);
    expect(protocol.MAX_WIDGETS).toBe(MAX_WIDGETS);
  });

  it('ANCHOR_ID_RE agrees with anchorIdSchema', () => {
    for (const id of ['a', 'A-b_9', 'x'.repeat(64), 'x'.repeat(65), '', '1a', '-a', 'a b', 'a\n', 'é']) {
      expect(ANCHOR_ID_RE.test(id)).toBe(manifest.anchorIdSchema.safeParse(id).success);
    }
  });
});

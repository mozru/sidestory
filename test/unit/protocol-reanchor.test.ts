import { describe, expect, it } from 'vitest';
import { fromWebviewSchema } from '../../src/shared/protocol.ts';

describe('reanchor message', () => {
  it('accepts a valid anchor id', () => {
    expect(fromWebviewSchema.safeParse({ type: 'reanchor', anchorId: 'refill' }).success).toBe(true);
  });

  it.each([{ type: 'reanchor' }, { type: 'reanchor', anchorId: '1bad' }, { type: 'reanchor', anchorId: 'x'.repeat(65) }, { type: 'reanchor', anchorId: 7 }])('refuses %j', (m) => {
    expect(fromWebviewSchema.safeParse(m).success).toBe(false);
  });
});

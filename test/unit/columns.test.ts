import { describe, expect, it } from 'vitest';
import type { GroupView } from '../../src/extension/columns.ts';
import { codeColumnFor } from '../../src/extension/columns.ts';

const text = (column: number, uri: string): GroupView => ({ column, shows: { kind: 'text', uri } });
const explainer = (column: number): GroupView => ({ column, shows: { kind: 'explainer' } });

describe('codeColumnFor', () => {
  it('prefers a group already showing the file', () => {
    expect(codeColumnFor([explainer(1), text(2, 'a'), text(3, 'b')], 1, 'b')).toBe(3);
  });

  it('otherwise uses a group showing other code', () => {
    expect(codeColumnFor([explainer(1), { column: 2, shows: { kind: 'other' } }, text(3, 'a')], 1, 'b')).toBe(3);
  });

  it('never covers another visible explainer: opens a new group instead', () => {
    // Explainer A in group 1; explainer B opened beside it in group 2, over the code.
    expect(codeColumnFor([explainer(1), explainer(2)], 2, 'a')).toBe(3);
    expect(codeColumnFor([explainer(1), explainer(2)], 1, 'a')).toBe(3);
  });

  it('uses an empty or non-code group before opening a new one', () => {
    expect(codeColumnFor([explainer(1), { column: 2, shows: undefined }], 1, 'a')).toBe(2);
    expect(codeColumnFor([explainer(1), { column: 2, shows: { kind: 'other' } }], 1, 'a')).toBe(2);
  });

  it('never uses the panel\'s own group', () => {
    expect(codeColumnFor([text(1, 'a')], 1, 'a')).toBe(2);
  });

  it('stays within nine columns', () => {
    expect(codeColumnFor(Array.from({ length: 9 }, (_, i) => explainer(i + 1)), 9, 'a')).toBe(9);
  });
});

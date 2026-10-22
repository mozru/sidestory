// Position-based text edits on generated code. Edits never add or remove line breaks, so line
// numbers in the edited code are the same as in the source.

export interface TextEdit {
  start: number;
  end: number;
  text: string;
  /** Among edits at the same position: lower goes first. */
  order: number;
}

export function applyEdits(code: string, edits: readonly TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.order - b.order);
  let out = '';
  let at = 0;
  for (const e of sorted) {
    if (e.start < at) throw new Error(`overlapping edits at ${e.start}`);
    if (/[\r\n\u2028\u2029]/.test(e.text)) throw new Error('an edit may not add line breaks');
    out += code.slice(at, e.start) + e.text;
    at = e.end;
  }
  return out + code.slice(at);
}

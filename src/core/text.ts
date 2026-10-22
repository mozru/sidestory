import type { Norm } from './manifest.ts';

export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/** Trim and collapse whitespace; `ws-ci` also ignores case (VHDL). */
export function normalizeLine(line: string, norm: Norm = 'ws'): string {
  const s = line.replace(/\s+/g, ' ').trim();
  return norm === 'ws-ci' ? s.toLowerCase() : s;
}

export function normalizeLines(lines: readonly string[], norm: Norm = 'ws'): string[] {
  return lines.map((l) => normalizeLine(l, norm));
}

/** Identifier-like tokens, for rename-tolerant comparison. */
export function identifiers(text: string, norm: Norm = 'ws'): Set<string> {
  const ids = text.match(/[A-Za-z_$][\w$]*/g) ?? [];
  return new Set(norm === 'ws-ci' ? ids.map((s) => s.toLowerCase()) : ids);
}

/** Code tokens: identifiers, numbers and single punctuation characters. */
export function codeTokens(text: string): string[] {
  return text.match(/[A-Za-z_$][\w$]*|\d[\w.']*|\S/g) ?? [];
}

/**
 * A document's lines, normalized lazily and once, so resolving many anchors
 * against the same text doesn't redo the work per anchor.
 */
export class PreparedText {
  private readonly cache = new Map<Norm, string[]>();
  readonly lines: readonly string[];

  constructor(lines: readonly string[]) {
    this.lines = lines;
  }

  static from(text: string): PreparedText {
    return new PreparedText(splitLines(text));
  }

  normalized(norm: Norm): readonly string[] {
    let n = this.cache.get(norm);
    if (!n) {
      n = normalizeLines(this.lines, norm);
      this.cache.set(norm, n);
    }
    return n;
  }
}

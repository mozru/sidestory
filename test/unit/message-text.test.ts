// Repository values in VS Code's notification messages (show{Information,Warning,Error}Message) render as Markdown
// links: a file named `src/[Fix it](command:…).js` would become a clickable command link. Every interpolated value
// in such a message goes through plainForMessage (or an alias that calls it: msg, modalText), unless it is one of the
// reviewed expressions below that never holds a repository value (counts, fixed words, our own constants).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SAFE_CALL = /^(plainForMessage|msg|modalText)\(/;
/** A choice between fixed words on a count or a flag (`n === 1 ? 'file' : 'files'`), or a count. */
const WORDS = /^[\w.!]+(?: [=!<>]==? (?:[\w.]+|'[^'`$]*')| [+-] [\w.]+)? \? '[^'`$]*' : '[^'`$]*'$/;
const COUNT = /^(?:[\w]+\.length|n|none|errors|warnings|rest)$/;
/** Our own constant maps and strings. */
const CONSTANT = /^(?:WHOLE_WORDS\[[^\]]+\]|TYPECHECK_COMMAND|COPIED|MAX_TRAIL)$/;

/** Reviewed: no repository text can reach these. */
const ALLOWED = new Set<string>([
  'COPIED',
  'MAX_TRAIL',
  'what',
  'note',
  'prompt',
  'errors',
  'warnings',
  'results.length',
  "results.length === 1 ? '' : 's'",
  'written.length',
  "plural(patches.size, 'anchor')",
  "what === 'A widget' ? 'it is' : 'they are'",
  "b.move ? 'moved' : WHOLE_WORDS[f.whole!]",
  // bootstrap.ts: the error loading our own bundle, never repository text; the bootstrap imports nothing to escape it.
  'e instanceof Error ? e.message : String(e)',
]);

function files(dir: string, base = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(join(dir, d.name), `${base}${d.name}/`) : d.name.endsWith('.ts') ? [`${base}${d.name}`] : []));
}

/** The template literal starting at `i` (a backtick): its `${…}` expressions at the top level, nested templates checked too. */
function interpolations(src: string, i: number): { exprs: string[]; end: number } {
  const exprs: string[] = [];
  let j = i + 1;
  while (j < src.length && src[j] !== '`') {
    if (src[j] === '\\') {
      j += 2;
      continue;
    }
    if (src[j] === '$' && src[j + 1] === '{') {
      let depth = 1;
      let k = j + 2;
      const start = k;
      while (k < src.length && depth) {
        const c = src[k];
        if (c === '`') {
          const inner = interpolations(src, k);
          exprs.push(...inner.exprs);
          k = inner.end + 1;
          continue;
        }
        if (c === '{') depth++;
        else if (c === '}') depth--;
        k++;
      }
      exprs.push(src.slice(start, k - 1).replace(/\s+/g, ' ').trim());
      j = k;
      continue;
    }
    j++;
  }
  return { exprs, end: j };
}

describe('notification messages never render repository text as Markdown', () => {
  it('every interpolated value in show*Message goes through plainForMessage, msg or modalText', () => {
    const bad: string[] = [];
    let calls = 0;
    for (const f of files('src/extension')) {
      const src = readFileSync(join('src/extension', f), 'utf8');
      for (const m of src.matchAll(/show(?:Information|Warning|Error)Message\(\s*/g)) {
        const at = m.index! + m[0].length;
        if (src[at] !== '`') continue;
        calls++;
        for (const e of interpolations(src, at).exprs) {
          // A nested template's own text was checked on its own; the expression holding it is a condition around it.
          if (SAFE_CALL.test(e) || WORDS.test(e) || COUNT.test(e) || CONSTANT.test(e) || ALLOWED.has(e) || e.includes('`')) continue;
          bad.push(`${f}: \${${e}}`);
        }
      }
    }
    expect(calls).toBeGreaterThan(20);
    expect(bad).toEqual([]);
  });
});

// Loop guards (docs/WIDGETS-PLAN.md §3): every for / for-in / for-of / while / do-while body gets a call
// to the runtime's hook first thing in each iteration. The runtime keeps one global iteration counter and
// a "last yielded" timestamp refreshed by MessageChannel ticks, and throws from the hook when code has run
// a loop for over ~1 s without yielding. Guards catch accidental hangs only (the watchdog handles the rest).
//
// Unbraced bodies are wrapped (`for (;;) x;` → `for (;;) {g; x;}`), so they keep their meaning; labels stay
// on their loops, since only bodies are touched. Nothing inserted contains a line break, so line numbers
// are preserved.
import { parse, type Node, type Program } from 'acorn';
import { full } from 'acorn-walk';
import { LOOP_GUARD_HOOK } from '../../shared/widget-imports.ts';
import { applyEdits, type TextEdit } from './edits.ts';

export const LOOP_GUARD_CALL = `globalThis.${LOOP_GUARD_HOOK}();`;

const LOOPS = new Set(['ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement']);

/** The insertions that guard every loop in a parsed program. */
export function loopGuardEdits(ast: Program): TextEdit[] {
  const edits: TextEdit[] = [];
  full(ast, (node) => {
    if (!LOOPS.has(node.type)) return;
    const body = (node as Node & { body: Node }).body;
    if (body.type === 'BlockStatement') {
      edits.push({ start: body.start + 1, end: body.start + 1, text: LOOP_GUARD_CALL, order: 1 });
    } else {
      edits.push({ start: body.start, end: body.start, text: `{${LOOP_GUARD_CALL}`, order: 1 });
      edits.push({ start: body.end, end: body.end, text: '}', order: 0 });
    }
  });
  return edits;
}

/** Parses JavaScript and guards its loops. */
export function insertLoopGuards(code: string, sourceType: 'module' | 'script' = 'module'): string {
  const ast = parse(code, { ecmaVersion: 'latest', sourceType, allowHashBang: true });
  return applyEdits(code, loopGuardEdits(ast));
}

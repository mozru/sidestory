// The built-in SystemVerilog / Verilog scanner, lite version (docs/AUTHORING-PLAN.md §4.3, §10.4): a tokenizer plus
// a structural pass, not a parser. It finds what `data-explain-code` links name (§8.1) and what cursor lighting
// rings (§8.2):
//   - declarations: ports (ANSI and non-ANSI), nets and variables, parameters, typedefs and enum members, genvars,
//     modports, clocking blocks, instances, functions and tasks, labelled blocks and assertions;
//   - what drives a signal (`driver(x)`): `always*` blocks, `assign`s and net declaration assignments, with the
//     target rules of §4.2 (concatenations, selects, members, compound assignments, `++`, `<=` as a comparison);
//   - `case` items of those blocks, and the port connections of instances.
// Only the first arm of each `ifdef is scanned. Later arms get a names-only pass, for the "defined in a later
// `ifdef arm" hint. Ends that don't balance close scopes at the next matching end keyword and mark the table
// `partial`.
//
// Hostile input: the scan is linear (each token is looked at a bounded number of times), nesting is capped
// (deeper code is skipped iteratively), and a token budget stops it with a `partial` table. `scanSvSliced` gives
// the event loop back every few milliseconds and stops when asked. Paths are matched by string comparison only:
// nothing here builds a RegExp from repository text or a path.
//
// API
//   scanSv(text, opts?) → SymbolTable                         (sync, whole file)
//   scanSvSliced(text, { sliceMs, stop, pause, budget? }) → Promise<SymbolTable | undefined>   (undefined: stopped)
//   findSvSymbol(table, path) → SvFound | SvNotFound           (§4.2 paths, lite: no runs, `.header` or macros)
//   isResetName(identifier) → boolean                          (the reset-name heuristic of §4.2)
import type { LineRange } from '../manifest.ts';

export const SV_LIMITS = {
  /** Tokens per file (comments included); past this, the table is partial (§4.3). */
  tokens: 20_000_000,
  /** Nesting the structural pass follows; deeper code is skipped and the table is partial. */
  depth: 200,
  /** Names remembered from skipped `ifdef arms, for the hint. */
  skippedNames: 20_000,
  /** A macro call's arguments longer than this aren't skipped as one token (unbalanced parentheses). */
  macroArgChars: 100_000,
  /** Symbols, drivers or connections recorded per file; past this, the table is partial. */
  records: 200_000,
} as const;

export type SvKind =
  | 'module' | 'interface' | 'program' | 'package' | 'class' | 'checker'
  | 'port' | 'param' | 'signal' | 'typedef' | 'enum-member' | 'genvar' | 'modport' | 'clocking'
  | 'instance' | 'function' | 'task' | 'block' | 'assertion';

export type DriverKind = 'always_ff' | 'always_comb' | 'always_latch' | 'always' | 'assign' | 'net';

export interface SvSymbol {
  name: string;
  /** Enclosing scopes, outermost first: the design unit, then labelled blocks (`\0` for an unlabelled one). */
  scope: string[];
  kind: SvKind;
  extent: LineRange;
  /** Ports: their direction, when written (or inherited from the port before). */
  dir?: string;
  /** Instances: the module (or interface) instantiated. */
  type?: string;
}

/** One assignment target: `x`, `x[7:4]` (slice `7 : 4`), `bus.valid` (chain `valid`). */
export interface SvTarget {
  base: string;
  chain: string[];
  /** The first select right after the name, as a token key. */
  slice?: string;
}

export interface SvCaseItem {
  /** Each label as a token key (`2'b10`, `{ a , b }`, `default`). */
  labels: string[];
  extent: LineRange;
}

export interface SvDriver {
  scope: string[];
  /** `label: always_ff …` or `always_ff begin : label`. */
  label?: string;
  kind: DriverKind;
  extent: LineRange;
  targets: SvTarget[];
  /** The `case` statements in the block, each with how many `case`s enclose it (0: outermost). */
  cases: { depth: number; items: SvCaseItem[] }[];
  /** Signals assigned in the functional branch (the `else` of a top-level reset `if`), else the body, in order. */
  functional: string[];
}

export interface SvConnection {
  scope: string[];
  instance: string;
  /** The instance's port: `.port(expr)` or `.port`. */
  port: string;
  extent: LineRange;
  /** Identifiers in the connected expression (`.start(rd_start)` → rd_start; `.start` → start). */
  idents: string[];
}

export interface SymbolTable {
  symbols: SvSymbol[];
  drivers: SvDriver[];
  connections: SvConnection[];
  /** Design units (modules, interfaces, packages …) by name. */
  units: Set<string>;
  /** Identifiers seen only in later `ifdef arms (names only: no scopes). */
  skipped: Set<string>;
  /** Names passed to macro calls used as statements or items (`` `FF(state_q, …) ``), with the first call's line. */
  macroUses: Map<string, { macro: string; line: number }>;
  /** The file didn't scan cleanly (ends that don't balance, too deep, or over budget). */
  partial: boolean;
  /** Why it's partial, for messages. */
  partialReason?: 'syntax' | 'budget' | 'depth' | 'records';
  lineCount: number;
}

export interface ScanOptions {
  /** Token budget (default SV_LIMITS.tokens). */
  budget?: number;
}

// ---- tokens ----

const ID = 1;
const NUM = 2;
const STR = 3;
const OP = 4;
const MACRO = 5;
const SYS = 6;

const CODE = 1;
const COMMENT = 2;

const OPS4 = ['<<<=', '>>>='];
const OPS3 = ['===', '!==', '==?', '!=?', '<<<', '>>>', '<<=', '>>=', '<->', '|->', '|=>', '->>', '#-#', '#=#'];
const OPS2 = new Set(['==', '!=', '<=', '>=', '&&', '||', '**', '<<', '>>', '->', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '++', '--', '::', '##', '.*', '+:', '-:', '~&', '~|', '~^', '^~', '@@', "'{"]);
const ASSIGN_OPS = new Set(['=', '<=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '<<<=', '>>>=']);

/** Directives whose rest of line is skipped. */
const LINE_DIRECTIVES = new Set(['include', 'timescale', 'undef', 'undefineall', 'default_nettype', 'resetall', 'celldefine', 'endcelldefine', 'line', 'pragma', 'begin_keywords', 'end_keywords', 'unconnected_drive', 'nounconnected_drive', 'default_decay_time', 'default_trireg_strength', 'delay_mode_distributed', 'delay_mode_path', 'delay_mode_unit', 'delay_mode_zero', 'protect', 'endprotect']);

const KEYWORDS = new Set(`accept_on alias always always_comb always_ff always_latch and assert assign assume automatic before begin bind
bins binsof bit break buf bufif0 bufif1 byte case casex casez cell chandle checker class clocking cmos config const constraint
context continue cover covergroup coverpoint cross deassign default defparam design disable dist do edge else end endcase
endchecker endclass endclocking endconfig endfunction endgenerate endgroup endinterface endmodule endpackage endprimitive
endprogram endproperty endspecify endsequence endtable endtask enum event eventually expect export extends extern final
first_match for force foreach forever fork forkjoin function generate genvar global highz0 highz1 if iff ifnone
ignore_bins illegal_bins implements implies import incdir include initial inout input inside instance int integer
interconnect interface intersect join join_any join_none large let liblist library local localparam logic longint
macromodule matches medium modport module nand negedge nettype new nexttime nmos nor noshowcancelled not notif0 notif1
null or output package packed parameter pmos posedge primitive priority program property protected pull0 pull1 pulldown
pullup pulsestyle_ondetect pulsestyle_onevent pure rand randc randcase randsequence rcmos real realtime ref reg
reject_on release repeat restrict return rnmos rpmos rtran rtranif0 rtranif1 s_always s_eventually s_nexttime s_until
s_until_with scalared sequence shortint shortreal showcancelled signed small soft solve specify specparam static string
strong strong0 strong1 struct super supply0 supply1 sync_accept_on sync_reject_on table tagged task this throughout time
timeprecision timeunit tran tranif0 tranif1 tri tri0 tri1 triand trior trireg type typedef union unique unique0
unsigned until until_with untyped use uwire var vectored virtual void wait wait_order wand weak weak0 weak1 while
wildcard wire with within wor xnor xor`.split(/\s+/));

const END_KWS = new Set(['end', 'endcase', 'endmodule', 'endinterface', 'endprogram', 'endpackage', 'endclass', 'endchecker', 'endfunction', 'endtask', 'endgenerate', 'join', 'join_any', 'join_none', 'endspecify', 'endgroup', 'endproperty', 'endsequence', 'endclocking', 'endprimitive', 'endconfig', 'endtable']);
const UNITS: Record<string, { end: string; kind: SvKind }> = {
  module: { end: 'endmodule', kind: 'module' },
  macromodule: { end: 'endmodule', kind: 'module' },
  interface: { end: 'endinterface', kind: 'interface' },
  program: { end: 'endprogram', kind: 'program' },
  package: { end: 'endpackage', kind: 'package' },
  class: { end: 'endclass', kind: 'class' },
  checker: { end: 'endchecker', kind: 'checker' },
};
/** Bodies skipped whole, to their end keyword. */
const SKIPPED: Record<string, string> = { specify: 'endspecify', covergroup: 'endgroup', property: 'endproperty', sequence: 'endsequence', primitive: 'endprimitive', config: 'endconfig', table: 'endtable', randsequence: 'endsequence' };
/** Skipped bodies whose name is still recorded (`property p_hand; … endproperty`). */
const NAMED_BODIES: Record<string, SvKind> = { property: 'assertion', sequence: 'assertion', covergroup: 'block', clocking: 'clocking' };
/** Keywords that start a module item: a statement scan stops at them (a missing `;` or `end`). */
/** `assign` too: a procedural continuous assignment is rare, and a missing `end` before an `assign` is common mid-edit. */
const ITEM_STARTS = new Set(['module', 'macromodule', 'program', 'package', 'class', 'always', 'always_ff', 'always_comb', 'always_latch', 'initial', 'final', 'function', 'task', 'generate', 'endgenerate', 'assign']);
const NET_TYPES = new Set(['wire', 'tri', 'tri0', 'tri1', 'wand', 'wor', 'triand', 'trior', 'trireg', 'supply0', 'supply1', 'uwire', 'interconnect']);
const DIRECTIONS = new Set(['input', 'output', 'inout', 'ref']);
const DATA_START = new Set(['reg', 'logic', 'bit', 'byte', 'shortint', 'int', 'longint', 'integer', 'time', 'real', 'shortreal', 'realtime', 'string', 'chandle', 'event', 'var', 'const', 'static', 'automatic', 'rand', 'randc', 'signed', 'unsigned', 'enum', 'struct', 'union', 'specparam', 'type', 'nettype', ...NET_TYPES]);
const GATES = new Set(['and', 'nand', 'or', 'nor', 'xor', 'xnor', 'buf', 'not', 'bufif0', 'bufif1', 'notif0', 'notif1', 'pullup', 'pulldown', 'tran', 'tranif0', 'tranif1', 'rtran', 'rtranif0', 'rtranif1', 'nmos', 'pmos', 'rnmos', 'rpmos', 'cmos', 'rcmos']);
const TO_SEMICOLON = new Set(['import', 'export', 'timeunit', 'timeprecision', 'defparam', 'bind', 'alias', 'let', 'nettype', 'specparam', 'global', 'extern', 'pure', 'constraint', 'return', 'break', 'continue', 'disable', 'force', 'release', 'deassign']);

/** Labels kept per case item (`A, B, C:`); more is no real case. */
const MAX_LABELS = 64;

const isIdentStart = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const isIdentChar = (c: number) => isIdentStart(c) || (c >= 48 && c <= 57) || c === 36;
const isDigit = (c: number) => c >= 48 && c <= 57;
const isSpace = (c: number) => c === 32 || c === 9 || c === 12 || c === 11;

class TokenArrays {
  kind: Uint8Array;
  start: Int32Array;
  end: Int32Array;
  n = 0;
  constructor(cap: number) {
    this.kind = new Uint8Array(cap);
    this.start = new Int32Array(cap);
    this.end = new Int32Array(cap);
  }
  push(k: number, s: number, e: number): void {
    if (this.n === this.kind.length) {
      const cap = this.n * 2;
      const kind = new Uint8Array(cap);
      kind.set(this.kind);
      const start = new Int32Array(cap);
      start.set(this.start);
      const end = new Int32Array(cap);
      end.set(this.end);
      this.kind = kind;
      this.start = start;
      this.end = end;
    }
    this.kind[this.n] = k;
    this.start[this.n] = s;
    this.end[this.n] = e;
    this.n++;
  }
}

interface Lexed {
  toks: TokenArrays;
  lineStarts: Int32Array;
  flags: Uint8Array;
  skipped: Set<string>;
  partial: boolean;
  overBudget: boolean;
}

/** Yield to the caller every this many units of work (characters or tokens). */
const TICK = 0x3fff;

function* lex(src: string, budget: number): Generator<void, Lexed> {
  const n = src.length;
  // Line starts first (one cheap pass), so lines are found by binary search and flags sized once.
  const starts: number[] = [0];
  for (let i = 0; i < n; i++) {
    const c = src.charCodeAt(i);
    if (c === 10 || (c === 13 && src.charCodeAt(i + 1) !== 10)) starts.push(i + 1);
    if ((i & 0xfffff) === 0xfffff) yield;
  }
  const lineStarts = Int32Array.from(starts);
  const flags = new Uint8Array(lineStarts.length + 2);
  const toks = new TokenArrays(Math.max(64, Math.min(1 << 20, n >> 2)));
  const skipped = new Set<string>();
  let partial = false;
  let overBudget = false;
  let line = 1; // 1-based line of position i
  /** Lines from `line` to the line of `to` get `flag`; returns the line of `to`. */
  const markTo = (from: number, to: number, flag: number) => {
    flags[line] = flags[line]! | flag;
    for (let j = from; j < to; j++) {
      const c = src.charCodeAt(j);
      if (c === 10 || (c === 13 && src.charCodeAt(j + 1) !== 10)) {
        line++;
        flags[line] = flags[line]! | flag;
      }
    }
  };
  // `ifdef: how many conditionals are open in the scanned text, and (when > 0) the depth of a skipped region.
  let open = 0;
  let skip = 0;
  let count = 0;
  const emit = (k: number, s: number, e: number) => {
    if (++count > budget) {
      overBudget = true;
      return;
    }
    if (skip > 0) {
      if (k === ID && skipped.size < SV_LIMITS.skippedNames) {
        const name = src.slice(s, e);
        if (!KEYWORDS.has(name)) skipped.add(name);
      }
      markTo(s, e, CODE);
      return;
    }
    markTo(s, e, CODE);
    toks.push(k, s, e);
  };
  let i = 0;
  let work = 0;
  /** Characters looked at for macro arguments: capped, so unclosed macro calls can't make the scan quadratic. */
  let macroWork = 0;
  const macroBudget = 2 * n + 1_000_000;
  while (i < n && !overBudget) {
    if ((++work & TICK) === 0) yield;
    const c = src.charCodeAt(i);
    if (c === 10 || c === 13) {
      i += c === 13 && src.charCodeAt(i + 1) === 10 ? 2 : 1;
      line++;
      continue;
    }
    if (isSpace(c)) {
      i++;
      continue;
    }
    const d = src.charCodeAt(i + 1);
    if (c === 47 && d === 47) {
      // line comment
      let j = i + 2;
      while (j < n && src.charCodeAt(j) !== 10 && src.charCodeAt(j) !== 13) j++;
      flags[line] = flags[line]! | COMMENT;
      i = j;
      continue;
    }
    if (c === 47 && d === 42) {
      const close = src.indexOf('*/', i + 2);
      const j = close < 0 ? n : close + 2;
      markTo(i, j, COMMENT);
      i = j;
      continue;
    }
    if (c === 40 && d === 42 && src.charCodeAt(i + 2) !== 41) {
      // attribute (* … *), not @(*)
      const close = src.indexOf('*)', i + 2);
      const j = close < 0 ? n : close + 2;
      markTo(i, j, COMMENT);
      i = j;
      continue;
    }
    if (c === 34) {
      // string, with escapes; ends at the closing quote or the end of the line
      let j = i + 1;
      while (j < n) {
        const e = src.charCodeAt(j);
        if (e === 92) j += 2;
        else if (e === 34) {
          j++;
          break;
        } else if (e === 10 || e === 13) break;
        else j++;
      }
      emit(STR, i, Math.min(j, n));
      i = Math.min(j, n);
      continue;
    }
    if (c === 92) {
      // escaped identifier: to the next whitespace
      let j = i + 1;
      while (j < n) {
        const e = src.charCodeAt(j);
        if (isSpace(e) || e === 10 || e === 13) break;
        j++;
      }
      emit(ID, i, j);
      i = j;
      continue;
    }
    if (c === 96) {
      // directive or macro use
      let j = i + 1;
      while (j < n && isIdentChar(src.charCodeAt(j))) j++;
      const name = src.slice(i + 1, j);
      if (name === 'define') {
        // to the end of the line, following line continuations
        while (j < n) {
          const e = src.charCodeAt(j);
          if (e === 92 && (src.charCodeAt(j + 1) === 10 || src.charCodeAt(j + 1) === 13)) {
            j += src.charCodeAt(j + 1) === 13 && src.charCodeAt(j + 2) === 10 ? 3 : 2;
            continue;
          }
          if (e === 10 || e === 13) break;
          j++;
        }
        markTo(i, j, CODE);
        i = j;
        continue;
      }
      if (name === 'ifdef' || name === 'ifndef' || name === 'elsif' || name === 'else' || name === 'endif') {
        markTo(i, j, CODE);
        if (name === 'ifdef' || name === 'ifndef') {
          if (skip > 0) skip++;
          else open++;
        } else if (name === 'endif') {
          if (skip > 1) skip--;
          else if (skip === 1) {
            skip = 0;
            open--;
          } else if (open > 0) open--;
          else partial = true;
        } else if (skip === 0) {
          // `elsif / `else of a scanned arm: the rest of this conditional is skipped
          if (open > 0) skip = 1;
          else partial = true;
        }
        // `ifdef NAME / `elsif NAME: the macro name isn't code
        if (name !== 'else' && name !== 'endif') {
          while (j < n && isSpace(src.charCodeAt(j))) j++;
          while (j < n && isIdentChar(src.charCodeAt(j))) j++;
        }
        i = j;
        continue;
      }
      if (LINE_DIRECTIVES.has(name)) {
        while (j < n && src.charCodeAt(j) !== 10 && src.charCodeAt(j) !== 13) j++;
        markTo(i, j, CODE);
        i = j;
        continue;
      }
      // a macro use: opaque, with its balanced arguments
      let k = j;
      while (k < n && isSpace(src.charCodeAt(k))) k++;
      let end = j;
      if (src.charCodeAt(k) === 40 && macroWork < macroBudget) {
        let depth = 0;
        let m = k;
        const limit = Math.min(n, k + SV_LIMITS.macroArgChars, k + macroBudget - macroWork);
        for (; m < limit; m++) {
          const e = src.charCodeAt(m);
          if (e === 40) depth++;
          else if (e === 41 && --depth === 0) break;
          else if (e === 34) {
            m++;
            while (m < limit && src.charCodeAt(m) !== 34 && src.charCodeAt(m) !== 10) m += src.charCodeAt(m) === 92 ? 2 : 1;
          }
        }
        macroWork += m - k;
        if (m < limit) end = m + 1;
        else partial = true;
      }
      emit(MACRO, i, end);
      i = end;
      continue;
    }
    if (c === 36 && isIdentChar(d)) {
      let j = i + 1;
      while (j < n && isIdentChar(src.charCodeAt(j))) j++;
      emit(SYS, i, j);
      i = j;
      continue;
    }
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentChar(src.charCodeAt(j))) j++;
      emit(ID, i, j);
      i = j;
      continue;
    }
    if (isDigit(c)) {
      let j = i + 1;
      while (j < n && (isDigit(src.charCodeAt(j)) || src.charCodeAt(j) === 95)) j++;
      if (src.charCodeAt(j) === 46 && isDigit(src.charCodeAt(j + 1))) {
        j++;
        while (j < n && (isDigit(src.charCodeAt(j)) || src.charCodeAt(j) === 95)) j++;
      }
      if ((src.charCodeAt(j) | 32) === 101 && (isDigit(src.charCodeAt(j + 1)) || ((src.charCodeAt(j + 1) === 43 || src.charCodeAt(j + 1) === 45) && isDigit(src.charCodeAt(j + 2))))) {
        j += 2;
        while (j < n && isDigit(src.charCodeAt(j))) j++;
      }
      // time units (10ns, 1step)
      let u = j;
      while (u < n && isIdentStart(src.charCodeAt(u))) u++;
      if (u > j && /^(s|ms|us|ns|ps|fs|step)$/.test(src.slice(j, u))) j = u;
      // a size before a based literal: 8'hFF, 8 'h FF
      let k = j;
      while (k < n && isSpace(src.charCodeAt(k))) k++;
      if (src.charCodeAt(k) === 39) {
        const based = basedEnd(src, k + 1);
        if (based > 0) j = based;
      }
      emit(NUM, i, j);
      i = j;
      continue;
    }
    if (c === 39) {
      const based = basedEnd(src, i + 1);
      if (based > 0) {
        emit(NUM, i, based);
        i = based;
        continue;
      }
      const e = src.charCodeAt(i + 1);
      if ((e === 48 || e === 49 || (e | 32) === 120 || (e | 32) === 122) && !isIdentChar(src.charCodeAt(i + 2))) {
        emit(NUM, i, i + 2);
        i += 2;
        continue;
      }
    }
    // operators: longest match
    let len = 1;
    if (OPS4.includes(src.slice(i, i + 4))) len = 4;
    else if (OPS3.includes(src.slice(i, i + 3))) len = 3;
    else if (OPS2.has(src.slice(i, i + 2))) len = 2;
    emit(OP, i, i + len);
    i += len;
  }
  if (open > 0 || skip > 0) partial = true;
  return { toks, lineStarts, flags, skipped, partial, overBudget };
}

/** After a `'`: the end of a based literal's digits (`'hFF`, `'sb1`), or 0 if there isn't one. */
function basedEnd(src: string, at: number): number {
  let j = at;
  if ((src.charCodeAt(j) | 32) === 115) j++;
  const b = src.charCodeAt(j) | 32;
  if (b !== 98 && b !== 111 && b !== 100 && b !== 104) return 0;
  j++;
  while (j < src.length && isSpace(src.charCodeAt(j))) j++;
  const s = j;
  while (j < src.length) {
    const e = src.charCodeAt(j);
    if (isDigit(e) || e === 95 || e === 63 || ((e | 32) >= 97 && (e | 32) <= 102) || (e | 32) === 120 || (e | 32) === 122) j++;
    else break;
  }
  return j > s ? j : 0;
}

// ---- the structural pass ----

/** What a procedural block collects while its statements are parsed. */
interface Collect {
  targets: SvTarget[];
  keys: Set<string>;
  cases: { depth: number; items: SvCaseItem[] }[];
  caseDepth: number;
  /** Where in the block: the reset branch, the functional branch, or neither. */
  branch: 'reset' | 'functional' | 'body';
  functional: string[];
  inFunctional: Set<string>;
  bodyOrder: string[];
  inBody: Set<string>;
  /** Variables declared inside the block: not drivers of anything outside it. */
  locals: Set<string>;
  /** Non-clock edge signals of the sensitivity list (resets). */
  resetEdges: Set<string>;
}

/** A connection before its extent is worked out: tokens a..b. */
type PendingConnection = Omit<SvConnection, 'extent'> & { a: number; b: number };

class Parser {
  private readonly src: string;
  private readonly kind: Uint8Array;
  private readonly start: Int32Array;
  private readonly end: Int32Array;
  private readonly n: number;
  private readonly lineStarts: Int32Array;
  private readonly flags: Uint8Array;
  pos = 0;
  partial = false;
  reason: SymbolTable['partialReason'];
  private depth = 0;
  private work = 0;
  /** End keywords the open scopes wait for, with counts. */
  private readonly expect = new Map<string, number>();
  readonly symbols: SvSymbol[] = [];
  readonly drivers: SvDriver[] = [];
  readonly connections: SvConnection[] = [];
  readonly units = new Set<string>();
  readonly macroUses = new Map<string, { macro: string; line: number; score: number }>();
  /** Counts unlabelled blocks, so each gets its own scope name. */
  private anon = 0;

  constructor(src: string, lexed: Lexed) {
    this.src = src;
    this.kind = lexed.toks.kind;
    this.start = lexed.toks.start;
    this.end = lexed.toks.end;
    this.n = lexed.toks.n;
    this.lineStarts = lexed.lineStarts;
    this.flags = lexed.flags;
  }

  // -- token helpers --
  private t(i: number): string {
    return i < this.n ? this.src.slice(this.start[i], this.end[i]) : '';
  }
  private is(i: number, w: string): boolean {
    return i < this.n && this.end[i]! - this.start[i]! === w.length && this.src.startsWith(w, this.start[i]);
  }
  private isId(i: number): boolean {
    return i < this.n && this.kind[i] === ID;
  }
  /** An identifier that isn't a keyword. */
  private isName(i: number): boolean {
    return this.isId(i) && !KEYWORDS.has(this.t(i));
  }
  /** The names a macro call passes (`` `FF(state_q, state_d, '0) ``), for the "macros aren't followed" hint. */
  private noteMacro(i: number): void {
    if (this.macroUses.size >= SV_LIMITS.skippedNames) return;
    const text = this.src.slice(this.start[i], Math.min(this.end[i]!, this.start[i]! + 2000));
    const open = text.indexOf('(');
    if (open < 0) return;
    const macro = text.slice(1, open).trim();
    const line = this.lineAt(i);
    const first = /^\(\s*([A-Za-z_][A-Za-z0-9_$]*)/.exec(text.slice(open))?.[1];
    const flop = /^(FF|DFF|REG|FLOP)/i.test(macro);
    // names outside strings (`uvm_info("…")`)
    for (const m of text.slice(open).replace(/"(?:[^"\\]|\\.)*"/g, '""').matchAll(/[A-Za-z_][A-Za-z0-9_$]*/g)) {
      if (KEYWORDS.has(m[0])) continue;
      // How likely this call assigns the name: its first argument in a flop macro, then any flop macro, then a mention.
      const score = (flop ? 2 : 0) + (m[0] === first ? 1 : 0);
      const had = this.macroUses.get(m[0]);
      if (!had || score > had.score) this.macroUses.set(m[0], { macro, line, score });
    }
  }
  /** An interface known from this file (`axi_if bus` in a port list is an interface port). */
  private unitNamed(name: string): boolean {
    return this.units.has(name);
  }
  private isEndKw(i: number): boolean {
    return i < this.n && this.kind[i] === ID && END_KWS.has(this.t(i));
  }
  lineOf(offset: number): number {
    const ls = this.lineStarts;
    let lo = 0;
    let hi = ls.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ls[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }
  private lineAt(i: number): number {
    return this.lineOf(this.start[Math.min(i, this.n - 1)] ?? 0);
  }
  private endLineAt(i: number): number {
    return this.lineOf(Math.max(0, (this.end[Math.min(i, this.n - 1)] ?? 1) - 1));
  }
  /** Per line, the first line of the comment block directly above it (itself when there is none): one pass. */
  private commentTop: Int32Array | undefined;
  /** The extent from token `a` to token `b` (inclusive), with the comment block directly above. */
  private extent(a: number, b: number, comments = true): LineRange {
    let s = this.lineAt(a);
    if (comments) {
      if (!this.commentTop) {
        const f = this.flags;
        const top = new Int32Array(f.length);
        for (let l = 1; l < f.length; l++) top[l] = l > 1 && f[l - 1] === COMMENT ? (l > 2 && f[l - 2] === COMMENT ? top[l - 1]! : l - 1) : l;
        this.commentTop = top;
      }
      s = this.commentTop[s] ?? s;
    }
    return { start: s, end: Math.max(s, this.endLineAt(Math.max(a, b))) };
  }
  private tick(): boolean {
    return (++this.work & 0x7ff) === 0;
  }
  private markPartial(reason: NonNullable<SymbolTable['partialReason']>): void {
    this.partial = true;
    this.reason ??= reason;
  }
  /** Case items, targets and pending connections: they count toward the records cap too. */
  private extraRecords = 0;
  /** Whether there's room for `n` more records; marks the table partial when there isn't. */
  private room(n = 1): boolean {
    if (this.symbols.length + this.drivers.length + this.connections.length + this.extraRecords + n > SV_LIMITS.records) {
      this.markPartial('records');
      return false;
    }
    return true;
  }
  private record<T>(list: T[], x: T): void {
    if (this.room()) list.push(x);
  }
  private push(kw: string): void {
    this.expect.set(kw, (this.expect.get(kw) ?? 0) + 1);
  }
  private pop(kw: string): void {
    const c = (this.expect.get(kw) ?? 1) - 1;
    if (c) this.expect.set(kw, c);
    else this.expect.delete(kw);
  }

  /**
   * At an end keyword that isn't ours: true when an enclosing scope waits for it (unwind to it); otherwise a
   * stray end is skipped. Both mark the table partial.
   */
  private foreignEnd(): boolean {
    this.markPartial('syntax');
    if (this.expect.has(this.t(this.pos))) return true;
    this.pos++;
    return false;
  }

  /** From an opening bracket at `pos`, past its match. Stops (partial) at an end keyword or item start. */
  private *skipBalanced(): Generator<void, void> {
    let depth = 0;
    while (this.pos < this.n) {
      if (this.tick()) yield;
      const i = this.pos;
      if (this.kind[i] === OP) {
        const c = this.src.charCodeAt(this.start[i]!);
        const len = this.end[i]! - this.start[i]!;
        if (c === 40 || c === 91 || c === 123 || (len === 2 && this.is(i, "'{"))) depth++;
        else if ((c === 41 || c === 93 || c === 125) && len === 1) {
          depth--;
          if (depth <= 0) {
            this.pos++;
            return;
          }
        }
      } else if (this.kind[i] === ID && (END_KWS.has(this.t(i)) || ITEM_STARTS.has(this.t(i)))) {
        this.markPartial('syntax');
        return;
      }
      this.pos++;
    }
    this.markPartial('syntax');
  }

  /** Bracket depth change of token i: +1 for ( [ { '{, -1 for ) ] }, else 0. */
  private delta(i: number): number {
    if (this.kind[i] !== OP) return 0;
    const len = this.end[i]! - this.start[i]!;
    const c = this.src.charCodeAt(this.start[i]!);
    if (len === 1) return c === 40 || c === 91 || c === 123 ? 1 : c === 41 || c === 93 || c === 125 ? -1 : 0;
    return len === 2 && this.is(i, "'{") ? 1 : 0;
  }

  /**
   * From `pos` to the `;` that ends the statement (at bracket depth 0), which is consumed. Returns the index of
   * the `;` (or of the last token scanned, if the statement ends at an end keyword or a module item: partial).
   */
  private *toSemicolon(stopAtItems = true): Generator<void, number> {
    let depth = 0;
    while (this.pos < this.n) {
      if (this.tick()) yield;
      const i = this.pos;
      const k = this.kind[i];
      if (k === OP) {
        depth += this.delta(i);
        if (depth < 0) depth = 0;
        if (depth === 0 && this.is(i, ';')) {
          this.pos++;
          return i;
        }
      } else if (k === ID && (END_KWS.has(this.t(i)) || (stopAtItems && ITEM_STARTS.has(this.t(i))))) {
        this.markPartial('syntax');
        return Math.max(0, i - 1);
      }
      this.pos++;
    }
    this.markPartial('syntax');
    return this.n - 1;
  }

  // -- items: what a module, package, interface or generate region holds --

  *file(): Generator<void, void> {
    yield* this.items([], null);
    while (this.pos < this.n) {
      // stray end keywords at the top level
      this.markPartial('syntax');
      this.pos++;
      yield* this.items([], null);
    }
  }

  /** Items until `endKw` (not consumed), an end keyword an enclosing scope waits for, or the end of input. */
  private *items(scope: string[], endKw: string | null): Generator<void, void> {
    while (this.pos < this.n) {
      if (this.tick()) yield;
      if (this.isEndKw(this.pos)) {
        if (endKw && this.is(this.pos, endKw)) return;
        if (this.foreignEnd()) return;
        continue;
      }
      const before = this.pos;
      yield* this.item(scope);
      if (this.pos === before) {
        this.markPartial('syntax');
        this.pos++;
      }
    }
  }

  private *item(scope: string[], label?: { name: string; at: number }): Generator<void, void> {
    const p = this.pos;
    const k = this.kind[p];
    if (k === OP) {
      if (this.is(p, ';')) this.pos++;
      else yield* this.toSemicolon();
      return;
    }
    if (k === MACRO) {
      this.noteMacro(p);
      this.pos++;
      if (this.is(this.pos, ';')) this.pos++;
      return;
    }
    if (k !== ID) {
      yield* this.toSemicolon();
      return;
    }
    const w = this.t(p);
    // a label: `g_lane: for …`, `seq: always_ff …`, `a_ok: assert property …`
    if (!KEYWORDS.has(w) && this.is(p + 1, ':') && !label) {
      this.pos += 2;
      yield* this.item(scope, { name: w, at: p });
      return;
    }
    const from = label?.at ?? p;
    if (w === 'extern' || w === 'pure' || w === 'import' || w === 'export') {
      // prototypes and DPI imports: `extern function …;`, `import "DPI-C" function …;`
      yield* this.toSemicolon(false);
      return;
    }
    if (w === 'virtual' || w === 'interface' && this.is(p + 1, 'class')) {
      // virtual class / interface class / virtual function …: the next keyword decides
      if (this.is(p + 1, 'class') || this.is(p + 1, 'function') || this.is(p + 1, 'task')) {
        this.pos++;
        yield* this.item(scope, label);
        return;
      }
    }
    const unit = UNITS[w];
    if (unit) {
      yield* this.designUnit(scope, unit.kind, unit.end, from);
      return;
    }
    if (w === 'function' || w === 'task' || ((w === 'static' || w === 'protected' || w === 'local') && (this.is(p + 1, 'function') || this.is(p + 1, 'task')))) {
      if (w !== 'function' && w !== 'task') this.pos++;
      yield* this.subroutine(scope, from);
      return;
    }
    if (w === 'always' || w === 'always_ff' || w === 'always_comb' || w === 'always_latch') {
      yield* this.driverBlock(scope, w, label, from);
      return;
    }
    if (w === 'initial' || w === 'final') {
      this.pos++;
      yield* this.statement(undefined);
      if (label) this.addSymbol(label.name, scope, 'block', from, this.pos - 1);
      return;
    }
    if (w === 'assign') {
      yield* this.continuousAssign(scope, from);
      return;
    }
    if (w === 'generate') {
      this.pos++;
      this.push('endgenerate');
      yield* this.items(scope, 'endgenerate');
      this.pop('endgenerate');
      if (this.is(this.pos, 'endgenerate')) this.pos++;
      return;
    }
    if (w === 'for' || w === 'if' || w === 'case') {
      yield* this.generateConstruct(scope, label, from);
      return;
    }
    if (w === 'begin') {
      yield* this.generateBlock(scope, label, from);
      return;
    }
    if (w === 'default' || w === 'global') {
      if (this.is(p + 1, 'clocking')) {
        this.pos++;
        yield* this.skipBody(scope, 'clocking', 'endclocking', from);
      } else yield* this.toSemicolon();
      return;
    }
    if (w === 'clocking') {
      yield* this.skipBody(scope, 'clocking', 'endclocking', from);
      return;
    }
    const body = SKIPPED[w];
    if (body) {
      yield* this.skipBody(scope, NAMED_BODIES[w], body, from);
      return;
    }
    if (w === 'assert' || w === 'assume' || w === 'cover' || w === 'restrict' || w === 'expect') {
      yield* this.statement(undefined);
      if (label) this.addSymbol(label.name, scope, 'assertion', from, this.pos - 1);
      return;
    }
    if (w === 'modport') {
      yield* this.modport(scope, from);
      return;
    }
    if (w === 'constraint') {
      // constraint name { … }
      this.pos++;
      while (this.pos < this.n && !this.is(this.pos, '{') && !this.is(this.pos, ';') && !this.isEndKw(this.pos)) this.pos++;
      if (this.is(this.pos, '{')) yield* this.skipBalanced();
      else if (this.is(this.pos, ';')) this.pos++;
      return;
    }
    if (w === 'typedef' || w === 'parameter' || w === 'localparam' || w === 'genvar' || DIRECTIONS.has(w) || DATA_START.has(w)) {
      yield* this.declaration(scope, from);
      return;
    }
    if (TO_SEMICOLON.has(w) || GATES.has(w)) {
      yield* this.toSemicolon();
      return;
    }
    if (!KEYWORDS.has(w)) {
      yield* this.userTyped(scope, from);
      return;
    }
    yield* this.toSemicolon();
  }

  private addSymbol(name: string, scope: string[], kind: SvKind, a: number, b: number, extra?: Partial<SvSymbol>, comments = true): void {
    this.record(this.symbols, { name, scope, kind, extent: this.extent(a, b, comments), ...extra });
  }

  /** module / interface / package … name [header] ; items end… [: name] */
  private *designUnit(scope: string[], kind: SvKind, endKw: string, from: number): Generator<void, void> {
    this.pos++;
    if (this.is(this.pos, 'automatic') || this.is(this.pos, 'static')) this.pos++;
    const nameAt = this.pos;
    const name = this.isId(nameAt) ? this.t(nameAt) : '';
    if (name) this.pos++;
    const path = name ? [...scope, name] : [...scope, `\0${this.anon++}`];
    if (name) this.units.add(name);
    // the header, to its `;`: package imports, parameters, ports
    while (this.pos < this.n) {
      if (this.tick()) yield;
      if (this.is(this.pos, 'import')) {
        yield* this.toSemicolon();
        continue;
      }
      if (this.is(this.pos, '#') && this.is(this.pos + 1, '(') && (kind === 'module' || kind === 'interface' || kind === 'program' || kind === 'checker')) {
        this.pos++;
        yield* this.portList(path, 'param');
        continue;
      }
      if (this.is(this.pos, '(') && (kind === 'module' || kind === 'interface' || kind === 'program' || kind === 'checker')) {
        yield* this.portList(path, 'port');
        continue;
      }
      if (this.is(this.pos, ';')) {
        this.pos++;
        break;
      }
      if (this.isEndKw(this.pos) || (this.isId(this.pos) && ITEM_STARTS.has(this.t(this.pos)))) {
        this.markPartial('syntax');
        break;
      }
      if (this.delta(this.pos) > 0) yield* this.skipBalanced();
      else this.pos++;
    }
    this.push(endKw);
    this.depth++;
    if (this.depth > SV_LIMITS.depth) yield* this.skipDeep(endKw);
    else yield* this.items(path, endKw);
    this.depth--;
    this.pop(endKw);
    let last = this.pos - 1;
    if (this.is(this.pos, endKw)) {
      last = this.pos;
      this.pos++;
      if (this.is(this.pos, ':') && this.isId(this.pos + 1)) {
        last = this.pos + 1;
        this.pos += 2;
      }
    } else this.markPartial('syntax');
    if (name) this.addSymbol(name, scope, kind, from, last, undefined, false);
  }

  /** Past nesting too deep to follow: skips to the matching `endKw` by counting, iteratively. */
  private *skipDeep(endKw: string): Generator<void, void> {
    this.markPartial('depth');
    while (this.pos < this.n) {
      if (this.tick()) yield;
      if (this.is(this.pos, endKw)) return;
      this.pos++;
    }
  }

  /** `( … )` of ports, or `#( … )` of parameters: one symbol per name, with its line(s). */
  private *portList(scope: string[], kind: 'port' | 'param'): Generator<void, void> {
    // pos is at `(`
    this.pos++;
    let segStart = this.pos;
    let depth = 0;
    let dir: string | undefined;
    const segments: [number, number][] = [];
    while (this.pos < this.n) {
      if (this.tick()) yield;
      const i = this.pos;
      if (this.isEndKw(i) || (this.isId(i) && ITEM_STARTS.has(this.t(i)))) {
        this.markPartial('syntax');
        if (i > segStart) segments.push([segStart, i - 1]);
        break;
      }
      const dd = this.delta(i);
      if (dd < 0 && depth === 0) {
        if (i > segStart) segments.push([segStart, i - 1]);
        this.pos++;
        break;
      }
      depth += dd;
      if (depth === 0 && this.is(i, ',')) {
        segments.push([segStart, i - 1]);
        segStart = i + 1;
      }
      this.pos++;
    }
    // Non-ANSI (`module m(a, b, c);`): the names are declared in the body; nothing to record here.
    const ansi = kind === 'param' || segments.some(([a, b]) => b > a || DIRECTIONS.has(this.t(a)) || DATA_START.has(this.t(a)));
    if (!ansi) return;
    for (const [a, b] of segments) {
      if (this.tick()) yield;
      if (DIRECTIONS.has(this.t(a))) dir = this.t(a);
      // an interface port (`axi_if.mst bus`, `axi_if bus`) has no direction, and resets the one inherited
      else if (this.isName(a) && (this.is(a + 1, '.') || this.isName(a + 1)) && !DATA_START.has(this.t(a))) dir = this.is(a + 1, '.') || this.unitNamed(this.t(a)) ? undefined : dir;
      let name = '';
      let nameAt = -1;
      let d = 0;
      for (let j = a; j <= b; j++) {
        if (d === 0 && this.kind[j] === OP && this.is(j, '=')) break;
        if (d === 0 && this.is(j, '.') && this.isId(j + 1) && j === a) {
          // .name(expr) explicit port
          name = this.t(j + 1);
          nameAt = j + 1;
          break;
        }
        if (d === 0 && this.isId(j) && !KEYWORDS.has(this.t(j))) {
          name = this.t(j);
          nameAt = j;
        }
        d += this.delta(j);
      }
      if (name && nameAt >= 0) this.addSymbol(name, scope, kind, a, b, kind === 'port' && dir ? { dir } : undefined);
    }
  }

  /** A declaration statement: one symbol per declared name, plus a driver for `wire x = …`. */
  private *declaration(scope: string[], from: number): Generator<void, void> {
    const a = this.pos;
    const first = this.t(a);
    const semi = yield* this.toSemicolon();
    const b = semi;
    const kind: SvKind = first === 'typedef' ? 'typedef' : first === 'parameter' || first === 'localparam' ? 'param' : first === 'genvar' ? 'genvar' : DIRECTIONS.has(first) ? 'port' : 'signal';
    const net = NET_TYPES.has(first) || (DIRECTIONS.has(first) && NET_TYPES.has(this.t(a + 1)));
    const extra = kind === 'port' ? { dir: first } : undefined;
    const end = this.is(semi, ';') ? semi - 1 : semi;
    if (kind === 'typedef') {
      // typedef … name; the name is the last identifier at depth 0
      let name = '';
      let d = 0;
      for (let j = a + 1; j <= end; j++) {
        if (this.tick()) yield;
        if (d === 0 && this.isName(j)) name = this.t(j);
        d += this.delta(j);
      }
      if (name) this.addSymbol(name, scope, 'typedef', from, b);
    }
    // enum members, anywhere in the statement: `enum … { A, B = 2, C }`
    // One pass: every token is looked at once (an `enum` with no `{`, or braces that never close, ends the scan).
    for (let j = a; j <= end; j++) {
      if (this.tick()) yield;
      if (!this.is(j, 'enum')) continue;
      let k = j + 1;
      while (k <= end && !this.is(k, '{')) k++;
      if (k > end) break;
      let d = 0;
      let expectName = true;
      let m = k;
      for (; m <= end; m++) {
        if (this.tick()) yield;
        const dd = this.delta(m);
        if (d === 1 && expectName && this.isName(m)) {
          this.addSymbol(this.t(m), scope, 'enum-member', from, b);
          expectName = false;
        }
        if (d === 1 && this.is(m, ',')) expectName = true;
        d += dd;
        if (d === 0 && m > k) break;
      }
      j = m;
    }
    if (kind === 'typedef') return;
    // names: per comma-separated declarator at depth 0, the last identifier before `=`
    let d = 0;
    let name = '';
    let assigned = false;
    const flush = () => {
      if (name) {
        this.addSymbol(name, scope, kind, from, b, extra);
        if (net && assigned) this.record(this.drivers, { scope, kind: 'net', extent: this.extent(from, b), targets: [{ base: name, chain: [] }], cases: [], functional: [name] });
      }
      name = '';
      assigned = false;
    };
    for (let j = a; j <= end; j++) {
      if (this.tick()) yield;
      if (d === 0 && this.is(j, ',')) {
        flush();
        continue;
      }
      if (d === 0 && this.is(j, '=')) assigned = true;
      // not a type's own parts: pkg::type, if_name.modport
      if (d === 0 && !assigned && this.isName(j) && !(this.is(j + 1, '::') || this.is(j - 1, '::') || this.is(j + 1, '.') || this.is(j - 1, '.'))) name = this.t(j);
      d += this.delta(j);
    }
    flush();
  }

  /** `modport a (…), b (…);` */
  private *modport(scope: string[], from: number): Generator<void, void> {
    const a = this.pos;
    const semi = yield* this.toSemicolon(false);
    let d = 0;
    for (let j = a + 1; j < semi; j++) {
      if (this.tick()) yield;
      if (d === 0 && this.isName(j) && this.is(j + 1, '(')) this.addSymbol(this.t(j), scope, 'modport', from, semi);
      d += this.delta(j);
    }
  }

  /** `clocking cb @(…); … endclocking`, `specify … endspecify` and the like: skipped, the name recorded. */
  private *skipBody(scope: string[], recordAs: SvKind | undefined, endKw: string, from: number): Generator<void, void> {
    this.pos++;
    const nameAt = this.pos;
    while (this.pos < this.n) {
      if (this.tick()) yield;
      if (this.is(this.pos, endKw)) break;
      if (this.isEndKw(this.pos) && this.expect.has(this.t(this.pos))) {
        this.markPartial('syntax');
        return;
      }
      if (this.isId(this.pos) && ITEM_STARTS.has(this.t(this.pos)) && this.t(this.pos) !== 'function' && this.t(this.pos) !== 'task') {
        this.markPartial('syntax');
        return;
      }
      this.pos++;
    }
    let last = this.pos;
    if (this.is(this.pos, endKw)) {
      this.pos++;
      if (this.is(this.pos, ':') && this.isId(this.pos + 1)) {
        last = this.pos + 1;
        this.pos += 2;
      }
    } else this.markPartial('syntax');
    if (recordAs && this.isName(nameAt)) this.addSymbol(this.t(nameAt), scope, recordAs, from, last);
  }

  /** A statement that starts with a name: a declaration with a user type, or instances. */
  private *userTyped(scope: string[], from: number): Generator<void, void> {
    const a = this.pos;
    let j = a + 1;
    // pkg::type, if_name.modport
    while ((this.is(j, '::') || this.is(j, '.')) && this.isId(j + 1)) j += 2;
    // #( parameters )
    if (this.is(j, '#') && this.is(j + 1, '(')) {
      this.pos = j + 1;
      yield* this.skipBalanced();
      j = this.pos;
    } else if (this.is(j, '#')) {
      j += 2; // #5 (a delay on a gate-like instance)
    }
    if (!this.isName(j)) {
      this.pos = a;
      // `my_t [3:0] x;` (packed dimensions on a user type) is a declaration; anything else, a statement
      if (this.is(j, '[')) yield* this.declaration(scope, from);
      else yield* this.toSemicolon();
      return;
    }
    // name [unpacked dims] ( → instance; otherwise a declaration
    let k = j + 1;
    while (this.is(k, '[')) {
      this.pos = k;
      yield* this.skipBalanced();
      k = this.pos;
    }
    if (!this.is(k, '(')) {
      this.pos = a;
      yield* this.declaration(scope, from);
      return;
    }
    const type = this.t(a);
    const insts: { name: string; conns: PendingConnection[] }[] = [];
    this.pos = j;
    while (this.pos < this.n) {
      if (this.tick()) yield;
      if (!this.isName(this.pos)) break;
      const inst = { name: this.t(this.pos), conns: [] as PendingConnection[] };
      insts.push(inst);
      this.pos++;
      while (this.is(this.pos, '[')) yield* this.skipBalanced();
      if (!this.is(this.pos, '(')) break;
      yield* this.connections_(scope, inst.name, inst.conns);
      if (this.is(this.pos, ',')) {
        this.pos++;
        continue;
      }
      break;
    }
    let last = this.pos - 1;
    if (this.is(this.pos, ';')) {
      last = this.pos;
      this.pos++;
    } else this.markPartial('syntax');
    for (const inst of insts) {
      this.addSymbol(inst.name, scope, 'instance', from, last, { type });
      for (const c of inst.conns) this.record(this.connections, { scope: c.scope, instance: c.instance, port: c.port, idents: c.idents, extent: this.extent(c.a, c.b) });
    }
  }

  /** An instance's `( … )`: named connections `.port(expr)` and `.port`; positional ones aren't addressable. */
  private *connections_(scope: string[], instance: string, out: PendingConnection[]): Generator<void, void> {
    this.pos++; // (
    let segStart = this.pos;
    let depth = 0;
    const segments: [number, number][] = [];
    while (this.pos < this.n) {
      if (this.tick()) yield;
      const i = this.pos;
      if (this.isEndKw(i) || (this.isId(i) && ITEM_STARTS.has(this.t(i)))) {
        this.markPartial('syntax');
        break;
      }
      const dd = this.delta(i);
      if (dd < 0 && depth === 0) {
        if (i > segStart) segments.push([segStart, i - 1]);
        this.pos++;
        break;
      }
      depth += dd;
      if (depth === 0 && this.is(i, ',')) {
        segments.push([segStart, i - 1]);
        segStart = i + 1;
      }
      this.pos++;
    }
    for (const [a, b] of segments) {
      if (this.tick()) yield;
      if (!this.is(a, '.') || !this.isId(a + 1)) continue;
      const port = this.t(a + 1);
      const idents: string[] = [];
      if (b === a + 1) idents.push(port);
      else for (let j = a + 2; j <= b; j++) if (this.isName(j) && idents.length < 32) idents.push(this.t(j));
      if (!this.room(out.length + 1)) break;
      out.push({ scope, instance, port, idents, a, b });
    }
  }

  /** for / if / case at module level: a generate construct, whose blocks may be labelled scopes. */
  private *generateConstruct(scope: string[], label: { name: string; at: number } | undefined, from: number): Generator<void, void> {
    const w = this.t(this.pos);
    let named: string | undefined;
    this.pos++;
    if (this.is(this.pos, '(')) yield* this.skipBalanced();
    if (w === 'case') {
      this.push('endcase');
      while (this.pos < this.n) {
        if (this.tick()) yield;
        if (this.is(this.pos, 'endcase')) break;
        if (this.isEndKw(this.pos)) {
          if (this.foreignEnd()) break;
          continue;
        }
        // labels to `:`, then an item
        if (this.is(this.pos, 'default')) {
          this.pos++;
          if (this.is(this.pos, ':')) this.pos++;
        } else {
          let d = 0;
          while (this.pos < this.n && !(d === 0 && this.is(this.pos, ':'))) {
            if (this.isEndKw(this.pos)) break;
            d += this.delta(this.pos);
            this.pos++;
          }
          if (this.is(this.pos, ':')) this.pos++;
        }
        const before = this.pos;
        yield* this.generateItem(scope, undefined);
        if (this.pos === before) this.pos++;
      }
      this.pop('endcase');
      if (this.is(this.pos, 'endcase')) this.pos++;
      else this.markPartial('syntax');
    } else {
      named = yield* this.generateItem(scope, label);
      if (w === 'if' && this.is(this.pos, 'else')) {
        this.pos++;
        yield* this.generateItem(scope, undefined);
      }
    }
    // a label before the construct names it, unless its block took the label already
    if (label && named !== label.name) this.addSymbol(label.name, scope, 'block', from, this.pos - 1);
  }

  /** Returns the name of the block it recorded, if any. */
  private *generateItem(scope: string[], outer: { name: string; at: number } | undefined): Generator<void, string | undefined> {
    if (this.is(this.pos, 'begin')) return yield* this.generateBlock(scope, outer, outer?.at ?? this.pos);
    if (this.is(this.pos, 'if') || this.is(this.pos, 'for') || this.is(this.pos, 'case')) {
      this.depth++;
      if (this.depth > SV_LIMITS.depth) {
        this.markPartial('depth');
        yield* this.toSemicolon();
      } else yield* this.generateConstruct(scope, undefined, this.pos);
      this.depth--;
      return undefined;
    }
    yield* this.item(scope);
    return undefined;
  }

  /** begin [: label] items end [: label], in a generate region: a scope. */
  private *generateBlock(scope: string[], outer: { name: string; at: number } | undefined, from: number): Generator<void, string | undefined> {
    this.pos++; // begin
    let name = outer?.name;
    if (this.is(this.pos, ':') && this.isId(this.pos + 1)) {
      name = this.t(this.pos + 1);
      this.pos += 2;
    }
    const path = [...scope, name ?? `\0${this.anon++}`];
    this.push('end');
    this.depth++;
    if (this.depth > SV_LIMITS.depth) yield* this.skipDeep('end');
    else yield* this.items(path, 'end');
    this.depth--;
    this.pop('end');
    let last = this.pos - 1;
    if (this.is(this.pos, 'end')) {
      last = this.pos;
      this.pos++;
      if (this.is(this.pos, ':') && this.isId(this.pos + 1)) {
        last = this.pos + 1;
        this.pos += 2;
      }
    } else this.markPartial('syntax');
    if (name) this.addSymbol(name, scope, 'block', from, last);
    return name;
  }

  /** function / task: the name, then its body, to endfunction / endtask. Prototypes have no body. */
  private *subroutine(scope: string[], from: number): Generator<void, void> {
    const kw = this.t(this.pos);
    const endKw = kw === 'function' ? 'endfunction' : 'endtask';
    this.pos++;
    // the name: the last identifier before `(` or `;` at depth 0
    let name = '';
    while (this.pos < this.n) {
      if (this.tick()) yield;
      if (this.is(this.pos, '(') || this.is(this.pos, ';')) break;
      if (this.isEndKw(this.pos)) break;
      if (this.delta(this.pos) > 0) {
        yield* this.skipBalanced();
        continue;
      }
      if (this.isId(this.pos) && (!KEYWORDS.has(this.t(this.pos)) || this.is(this.pos, 'new'))) name = this.t(this.pos);
      this.pos++;
    }
    if (this.is(this.pos, '(')) yield* this.skipBalanced();
    if (this.is(this.pos, ';')) this.pos++;
    this.push(endKw);
    this.depth++;
    if (this.depth > SV_LIMITS.depth) yield* this.skipDeep(endKw);
    else {
      while (this.pos < this.n) {
        if (this.tick()) yield;
        if (this.is(this.pos, endKw)) break;
        if (this.isEndKw(this.pos)) {
          if (this.foreignEnd()) break;
          continue;
        }
        if (this.isId(this.pos) && ITEM_STARTS.has(this.t(this.pos))) {
          this.markPartial('syntax');
          break;
        }
        const before = this.pos;
        yield* this.statement(undefined);
        if (this.pos === before) this.pos++;
      }
    }
    this.depth--;
    this.pop(endKw);
    let last = this.pos - 1;
    if (this.is(this.pos, endKw)) {
      last = this.pos;
      this.pos++;
      if (this.is(this.pos, ':') && this.isId(this.pos + 1)) {
        last = this.pos + 1;
        this.pos += 2;
      }
    } else this.markPartial('syntax');
    if (name) this.addSymbol(name, scope, kw === 'function' ? 'function' : 'task', from, last);
  }

  /** assign [strength] [#delay] a = …, b = …; */
  private *continuousAssign(scope: string[], from: number): Generator<void, void> {
    this.pos++;
    if (this.is(this.pos, '(')) yield* this.skipBalanced();
    if (this.is(this.pos, '#')) {
      this.pos++;
      if (this.is(this.pos, '(')) yield* this.skipBalanced();
      else this.pos++;
    }
    const a = this.pos;
    const semi = yield* this.toSemicolon();
    const end = this.is(semi, ';') ? semi - 1 : semi;
    const targets: SvTarget[] = [];
    let d = 0;
    let segStart = a;
    let seenEq = false;
    for (let j = a; j <= end + 1; j++) {
      if (this.tick()) yield;
      const atEnd = j > end || (d === 0 && this.is(j, ','));
      if (atEnd) {
        segStart = j + 1;
        seenEq = false;
        continue;
      }
      if (d === 0 && !seenEq && this.is(j, '=')) {
        seenEq = true;
        this.targetsOf(segStart, j - 1, targets, undefined);
      }
      d += this.delta(j);
    }
    if (targets.length) this.record(this.drivers, { scope, kind: 'assign', extent: this.extent(from, semi), targets: dedupe(targets), cases: [], functional: [...new Set(targets.map((t) => t.base))] });
  }

  /** always* [@(…)] statement: a driver of every signal it assigns. */
  private *driverBlock(scope: string[], kw: string, label: { name: string; at: number } | undefined, from: number): Generator<void, void> {
    this.pos++;
    const resetEdges = new Set<string>();
    // the sensitivity list, for reset edges: `@(posedge clk or negedge rst_n)`
    if (this.is(this.pos, '@') && this.is(this.pos + 1, '(')) {
      const at = this.pos + 1;
      this.pos = at;
      yield* this.skipBalanced();
      const edges: string[] = [];
      for (let j = at; j < this.pos; j++) if ((this.is(j, 'posedge') || this.is(j, 'negedge') || this.is(j, 'edge')) && this.isName(j + 1)) edges.push(this.t(j + 1));
      const clock = edges.find((e) => /cl(oc)?k/i.test(e)) ?? edges[0];
      for (const e of edges) if (e !== clock) resetEdges.add(e);
    } else if (this.is(this.pos, '@')) {
      this.pos++;
      if (this.is(this.pos, '*') || this.isId(this.pos)) this.pos++;
    }
    let blockLabel = label?.name;
    if (!blockLabel && this.is(this.pos, 'begin') && this.is(this.pos + 1, ':') && this.isId(this.pos + 2)) blockLabel = this.t(this.pos + 2);
    const c: Collect = { targets: [], keys: new Set(), cases: [], caseDepth: 0, branch: 'body', functional: [], inFunctional: new Set(), bodyOrder: [], inBody: new Set(), locals: new Set(), resetEdges };
    yield* this.blockBody(c);
    const targets = c.targets.filter((t) => !c.locals.has(t.base));
    const order = (c.functional.length ? c.functional : c.bodyOrder).filter((x) => !c.locals.has(x));
    const last = this.pos - 1;
    this.record(this.drivers, { scope, label: blockLabel, kind: kw as DriverKind, extent: this.extent(from, last), targets: dedupe(targets), cases: c.cases, functional: [...new Set(order)] });
    if (blockLabel) this.addSymbol(blockLabel, scope, 'block', from, last);
  }

  /** The block's statement, finding the top-level reset `if`: its `else` is the functional branch (§4.2). */
  private *blockBody(c: Collect): Generator<void, void> {
    if (!this.is(this.pos, 'begin')) {
      yield* this.topStatement(c);
      return;
    }
    this.pos++;
    if (this.is(this.pos, ':') && this.isId(this.pos + 1)) this.pos += 2;
    this.push('end');
    while (this.pos < this.n) {
      if (this.tick()) yield;
      if (this.is(this.pos, 'end')) break;
      if (this.isEndKw(this.pos)) {
        if (this.foreignEnd()) break;
        continue;
      }
      if (this.isId(this.pos) && ITEM_STARTS.has(this.t(this.pos))) {
        this.markPartial('syntax');
        break;
      }
      const before = this.pos;
      yield* this.topStatement(c);
      if (this.pos === before) this.pos++;
    }
    this.pop('end');
    if (this.is(this.pos, 'end')) {
      this.pos++;
      if (this.is(this.pos, ':') && this.isId(this.pos + 1)) this.pos += 2;
    } else this.markPartial('syntax');
  }

  private *topStatement(c: Collect): Generator<void, void> {
    let p = this.pos;
    if (this.is(p, 'unique') || this.is(p, 'unique0') || this.is(p, 'priority')) p++;
    if (!this.is(p, 'if') || !this.is(p + 1, '(')) {
      yield* this.statement(c);
      return;
    }
    // if (cond): a reset when the condition names one
    this.pos = p + 1;
    const condAt = this.pos;
    yield* this.skipBalanced();
    let reset = false;
    for (let j = condAt; j < this.pos; j++) if (this.isName(j) && (isResetName(this.t(j)) || c.resetEdges.has(this.t(j)))) reset = true;
    if (!reset) {
      yield* this.statement(c);
      if (this.is(this.pos, 'else')) {
        this.pos++;
        yield* this.statement(c);
      }
      return;
    }
    const outer = c.branch;
    c.branch = 'reset';
    yield* this.statement(c);
    if (this.is(this.pos, 'else')) {
      this.pos++;
      // `else if (srst)`: a chain of resets; the functional branch is the last else. The chain counts as nesting.
      c.branch = 'functional';
      this.depth++;
      try {
        if (this.depth > SV_LIMITS.depth) {
          this.markPartial('depth');
          yield* this.flatSkip();
        } else yield* this.topStatement(c);
      } finally {
        this.depth--;
      }
    }
    c.branch = outer;
  }

  /** One procedural statement. `c` collects targets and case items (undefined: not a driver block). */
  private *statement(c: Collect | undefined): Generator<void, void> {
    if (this.tick()) yield;
    this.depth++;
    try {
      if (this.depth > SV_LIMITS.depth) {
        this.markPartial('depth');
        yield* this.flatSkip();
        return;
      }
      const p = this.pos;
      if (p >= this.n) return;
      const k = this.kind[p];
      if (k === OP) {
        if (this.is(p, ';')) {
          this.pos++;
          return;
        }
        if (this.is(p, '@')) {
          this.pos++;
          if (this.is(this.pos, '(')) yield* this.skipBalanced();
          else if (this.is(this.pos, '*') || this.isId(this.pos)) {
            this.pos++;
            while (this.is(this.pos, '.') && this.isId(this.pos + 1)) this.pos += 2;
          }
          yield* this.statement(c);
          return;
        }
        if (this.is(p, '#') || this.is(p, '##')) {
          this.pos++;
          if (this.is(this.pos, '(')) yield* this.skipBalanced();
          else this.pos++;
          yield* this.statement(c);
          return;
        }
        if (this.is(p, '++') || this.is(p, '--') || this.is(p, '{')) {
          yield* this.simple(c);
          return;
        }
        yield* this.toSemicolon();
        return;
      }
      if (k === MACRO) {
        this.noteMacro(p);
        this.pos++;
        if (this.is(this.pos, ';')) this.pos++;
        return;
      }
      if (k !== ID) {
        yield* this.toSemicolon();
        return;
      }
      const w = this.t(p);
      if (END_KWS.has(w) || ITEM_STARTS.has(w)) return; // the caller decides
      if (!KEYWORDS.has(w) && this.is(p + 1, ':')) {
        this.pos += 2;
        yield* this.statement(c);
        return;
      }
      switch (w) {
        case 'begin':
        case 'fork': {
          this.pos++;
          if (this.is(this.pos, ':') && this.isId(this.pos + 1)) this.pos += 2;
          const ends = w === 'begin' ? ['end'] : ['join', 'join_any', 'join_none'];
          for (const e of ends) this.push(e);
          while (this.pos < this.n) {
            if (this.tick()) yield;
            if (ends.some((e) => this.is(this.pos, e))) break;
            if (this.isEndKw(this.pos)) {
              if (this.foreignEnd()) break;
              continue;
            }
            if (this.isId(this.pos) && ITEM_STARTS.has(this.t(this.pos))) {
              this.markPartial('syntax');
              break;
            }
            const before = this.pos;
            yield* this.statement(c);
            if (this.pos === before) this.pos++;
          }
          for (const e of ends) this.pop(e);
          if (ends.some((e) => this.is(this.pos, e))) {
            this.pos++;
            if (this.is(this.pos, ':') && this.isId(this.pos + 1)) this.pos += 2;
          } else this.markPartial('syntax');
          return;
        }
        case 'unique':
        case 'unique0':
        case 'priority':
          this.pos++;
          yield* this.statement(c);
          return;
        case 'if':
          this.pos++;
          if (this.is(this.pos, '(')) yield* this.skipBalanced();
          yield* this.statement(c);
          if (this.is(this.pos, 'else')) {
            this.pos++;
            yield* this.statement(c);
          }
          return;
        case 'case':
        case 'casez':
        case 'casex':
        case 'randcase':
          yield* this.caseStatement(c);
          return;
        case 'for':
        case 'foreach':
        case 'while':
        case 'repeat':
          this.pos++;
          if (this.is(this.pos, '(')) yield* this.skipBalanced();
          yield* this.statement(c);
          return;
        case 'forever':
          this.pos++;
          yield* this.statement(c);
          return;
        case 'do':
          this.pos++;
          yield* this.statement(c);
          if (this.is(this.pos, 'while')) yield* this.toSemicolon();
          return;
        case 'wait':
          this.pos++;
          if (this.is(this.pos, 'fork')) {
            yield* this.toSemicolon();
            return;
          }
          if (this.is(this.pos, '(')) yield* this.skipBalanced();
          yield* this.statement(c);
          return;
        case 'assert':
        case 'assume':
        case 'cover':
        case 'restrict':
        case 'expect': {
          this.pos++;
          if (this.is(this.pos, 'property') || this.is(this.pos, 'sequence') || this.is(this.pos, 'final')) this.pos++;
          if (this.is(this.pos, '#')) this.pos += 2;
          if (this.is(this.pos, '(')) yield* this.skipBalanced();
          if (this.is(this.pos, ';')) {
            this.pos++;
            return;
          }
          if (!this.is(this.pos, 'else')) yield* this.statement(undefined);
          if (this.is(this.pos, 'else')) {
            this.pos++;
            yield* this.statement(undefined);
          }
          return;
        }
        default:
          yield* this.simple(c);
      }
    } finally {
      this.depth--;
    }
  }

  /** Too deep: skip to the next `;` or end keyword without recursing. */
  private *flatSkip(): Generator<void, void> {
    let nest = 0;
    while (this.pos < this.n) {
      if (this.tick()) yield;
      if (this.is(this.pos, 'begin') || this.is(this.pos, 'fork') || this.is(this.pos, 'case') || this.is(this.pos, 'casez') || this.is(this.pos, 'casex')) nest++;
      else if (this.isEndKw(this.pos)) {
        if (nest === 0) return;
        nest--;
      } else if (nest === 0 && this.is(this.pos, ';')) {
        this.pos++;
        return;
      }
      this.pos++;
    }
  }

  /** case (expr) [inside] items endcase: each item's labels and extent, for `.case(LABEL)` (§4.2). */
  private *caseStatement(c: Collect | undefined): Generator<void, void> {
    this.pos++;
    if (this.is(this.pos, '(')) yield* this.skipBalanced();
    if (this.is(this.pos, 'inside') || this.is(this.pos, 'matches')) this.pos++;
    const rec = c ? { depth: c.caseDepth, items: [] as SvCaseItem[] } : undefined;
    if (c && rec) c.cases.push(rec);
    if (c) c.caseDepth++;
    this.push('endcase');
    while (this.pos < this.n) {
      if (this.tick()) yield;
      if (this.is(this.pos, 'endcase')) break;
      if (this.isEndKw(this.pos)) {
        if (this.foreignEnd()) break;
        continue;
      }
      if (this.isId(this.pos) && ITEM_STARTS.has(this.t(this.pos))) {
        this.markPartial('syntax');
        break;
      }
      const itemAt = this.pos;
      const labels: string[] = [];
      if (this.is(this.pos, 'default')) {
        labels.push('default');
        this.pos++;
        if (this.is(this.pos, ':')) this.pos++;
      } else {
        let d = 0;
        let labelStart = this.pos;
        while (this.pos < this.n) {
          if (this.tick()) yield;
          const i = this.pos;
          if (d === 0 && this.is(i, ':')) break;
          if (this.isEndKw(i) || (d === 0 && this.is(i, ';'))) break;
          if (d === 0 && this.is(i, ',')) {
            if (labels.length < MAX_LABELS) labels.push(this.key(labelStart, i - 1));
            else this.markPartial('records');
            labelStart = i + 1;
          }
          d += this.delta(i);
          if (d < 0) d = 0;
          this.pos++;
        }
        if (!this.is(this.pos, ':')) {
          this.markPartial('syntax');
          if (this.is(this.pos, ';')) this.pos++;
          continue;
        }
        if (labels.length < MAX_LABELS) labels.push(this.key(labelStart, this.pos - 1));
        this.pos++;
      }
      const before = this.pos;
      yield* this.statement(c);
      if (this.pos === before && !this.is(this.pos, 'endcase')) this.pos++;
      if (rec && this.room()) {
        this.extraRecords++;
        rec.items.push({ labels, extent: this.extent(itemAt, this.pos - 1) });
      }
    }
    this.pop('endcase');
    if (c) c.caseDepth--;
    if (this.is(this.pos, 'endcase')) this.pos++;
    else this.markPartial('syntax');
  }

  /** Tokens a..b as a key: texts joined by single spaces. */
  private key(a: number, b: number): string {
    const parts: string[] = [];
    for (let j = a; j <= b && parts.length < 64; j++) parts.push(this.t(j));
    return parts.join(' ');
  }

  /** A simple statement to its `;`: its assignment targets, or the declared names of a local declaration. */
  private *simple(c: Collect | undefined): Generator<void, void> {
    const a = this.pos;
    const semi = yield* this.toSemicolon();
    if (!c) return;
    const end = this.is(semi, ';') ? semi - 1 : semi;
    // a local declaration: `logic [3:0] b;`, `automatic int i = 0;`
    const first = this.t(a);
    if (DATA_START.has(first) || (this.isName(a) && this.isName(a + 1)) || (this.isName(a) && this.is(a + 1, '::'))) {
      let d = 0;
      let name = '';
      let assigned = false;
      for (let j = a; j <= end + 1; j++) {
        if (j > end || (d === 0 && this.is(j, ','))) {
          if (name) c.locals.add(name);
          name = '';
          assigned = false;
          continue;
        }
        if (d === 0 && this.is(j, '=')) assigned = true;
        if (d === 0 && !assigned && this.isName(j)) name = this.t(j);
        d += this.delta(j);
      }
      return;
    }
    let d = 0;
    let op = -1;
    for (let j = a; j <= end; j++) {
      if (d === 0 && this.kind[j] === OP && ASSIGN_OPS.has(this.t(j))) {
        op = j;
        break;
      }
      d += this.delta(j);
    }
    let lhsA = a;
    let lhsB = op - 1;
    if (op < 0) {
      // x++ / ++x
      if (this.is(a, '++') || this.is(a, '--')) {
        lhsA = a + 1;
        lhsB = end;
      } else if (this.is(end, '++') || this.is(end, '--')) lhsB = end - 1;
      else return;
    }
    const found: SvTarget[] = [];
    this.targetsOf(lhsA, lhsB, found, c.locals);
    for (const t of found) {
      const key = targetKey(t);
      if (!c.keys.has(key) && this.room()) {
        this.extraRecords++;
        c.keys.add(key);
        c.targets.push(t);
      }
      // the order of first assignments: each name once
      if (c.branch === 'functional' && !c.inFunctional.has(t.base)) {
        c.inFunctional.add(t.base);
        c.functional.push(t.base);
      }
      if (c.branch !== 'reset' && !c.inBody.has(t.base)) {
        c.inBody.add(t.base);
        c.bodyOrder.push(t.base);
      }
    }
  }

  /** The targets of an assignment's left side a..b: a name with selects and members, or a concatenation. */
  private targetsOf(a: number, b: number, out: SvTarget[], locals: Set<string> | undefined, depth = 0): void {
    if (b < a) return;
    if (depth > 16) {
      this.markPartial('depth'); // concatenations nested this deep aren't real assignment targets
      return;
    }
    if (this.is(a, '{') || this.is(a, "'{")) {
      let d = 0;
      let segStart = a + 1;
      for (let j = a; j <= b; j++) {
        const dd = this.delta(j);
        if (d === 1 && (this.is(j, ',') || (dd < 0 && j === b))) {
          this.targetsOf(segStart, j - 1, out, locals, depth + 1);
          segStart = j + 1;
        }
        d += dd;
      }
      return;
    }
    if (!this.isName(a)) return;
    const t: SvTarget = { base: this.t(a), chain: [] };
    let j = a + 1;
    let first = true;
    while (j <= b) {
      if (this.is(j, '[')) {
        const s = j;
        let d = 0;
        for (; j <= b; j++) {
          d += this.delta(j);
          if (d === 0) break;
        }
        if (first && !t.chain.length) t.slice = this.key(s + 1, j - 1);
        first = false;
        j++;
        continue;
      }
      if (this.is(j, '.') && this.isId(j + 1)) {
        t.chain.push(this.t(j + 1));
        first = false;
        j += 2;
        continue;
      }
      return; // something else: not an assignment target (a declaration, a call)
    }
    if (locals?.has(t.base)) return;
    out.push(t);
  }
}

function targetKey(t: SvTarget): string {
  return `${t.base}\0${t.chain.join('.')}\0${t.slice ?? ''}`;
}

function dedupe(ts: SvTarget[]): SvTarget[] {
  const seen = new Set<string>();
  return ts.filter((t) => {
    const k = targetKey(t);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---- running it ----

function* scanGen(text: string, opts: ScanOptions = {}): Generator<void, SymbolTable> {
  const lexed = yield* lex(text, opts.budget ?? SV_LIMITS.tokens);
  const p = new Parser(text, lexed);
  try {
    yield* p.file();
  } catch {
    // A bug or an input the caps missed (a stack overflow): keep what was found, as a partial table.
    p.partial = true;
    p.reason ??= 'depth';
  }
  const partial = p.partial || lexed.partial || lexed.overBudget;
  const reason = lexed.overBudget ? 'budget' : p.reason ?? (lexed.partial ? 'syntax' : undefined);
  return {
    symbols: p.symbols,
    drivers: p.drivers,
    connections: p.connections,
    units: p.units,
    skipped: lexed.skipped,
    macroUses: p.macroUses,
    partial,
    partialReason: partial ? reason ?? 'syntax' : undefined,
    lineCount: lexed.lineStarts.length,
  };
}

/** Scans a whole file synchronously (the checker; tests). */
export function scanSv(text: string, opts: ScanOptions = {}): SymbolTable {
  const g = scanGen(text, opts);
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}

/**
 * Scans in slices of `sliceMs`, giving the event loop back between them (the extension host). Returns undefined
 * when `stop()` says the result is no longer wanted (a newer document version arrived).
 */
export async function scanSvSliced(text: string, opts: ScanOptions & { sliceMs: number; stop: () => boolean; pause: () => Promise<void> }): Promise<SymbolTable | undefined> {
  const g = scanGen(text, opts);
  let sliceStart = Date.now();
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
    if (Date.now() - sliceStart > opts.sliceMs) {
      await opts.pause();
      if (opts.stop()) return undefined;
      sliceStart = Date.now();
    }
  }
}

/** Whether a file is SystemVerilog or Verilog, by its language (in VS Code) or its extension. */
export function isSvPath(path: string, languageId?: string): boolean {
  if (languageId === 'systemverilog' || languageId === 'verilog') return true;
  // `.v` is also Coq: the extension decides only when the language isn't known
  return (languageId === undefined || languageId === 'plaintext') && /\.(sv|svh|svi|v|vh)$/i.test(path);
}

// ---- the reset heuristic (§4.2) ----

/**
 * Whether an identifier names a reset: one of its segments (split on `_` and at case changes) matches
 * `n?(rst|reset)[nb]?i?`, `a/s` + that, or `por[n]`. `rst_n`, `rst_ni`, `aresetn`, `ARESETn`, `por_n`, `nrst` and
 * `resetb` do; `first_q` and `wr_burst_len` don't, since `rst` is only part of a word there.
 */
export function isResetName(id: string): boolean {
  if (id.length > 128) return false;
  // split at `_`, and where a lower-case letter or digit is followed by an upper-case one, keeping a trailing n
  // (`ARESETn`) with its word
  const words = id.split('_').flatMap((w) => w.replace(/([a-z0-9])([A-Z])/g, '$1\0$2').split('\0'));
  return words.some((w) => /^[as]?n?(rst|reset)[nb]?i?$|^porn?$/i.test(w));
}

// ---- finding a path (§4.2, lite) ----

export type SvFound = {
  ok: true;
  extent: LineRange;
  /** What the path named. */
  kind: SvKind | DriverKind | 'case-item' | 'connection';
  /** An info note: a kind form that matched only as `driver()`. */
  note?: string;
};

export type SvNotFound = {
  ok: false;
  reason: 'syntax' | 'missing' | 'ambiguous';
  /** A sentence for the reader or the author: what was looked for, and a hint. */
  message: string;
  /** For ambiguity: where the candidates are. */
  candidates?: LineRange[];
  /** The table is partial, so a miss may be the scanner's. */
  partial?: boolean;
};

type Seg =
  | { kind: 'name'; name: string }
  | { kind: 'fn'; fn: string; target: SvTarget }
  | { kind: 'case'; key: string }
  | { kind: 'conn'; instance: string; port: string };

const NAME = /^(?:[A-Za-z_][\w$]*|\\\S+)$/;
const KIND_FORMS = new Set(['driver', 'always_ff', 'always_comb', 'always_latch', 'always', 'assign']);

/** Splits a path at `.` and `::` outside brackets; null on a syntax error. */
export function parseSvPath(path: string): Seg[] | null {
  if (path.length === 0 || path.length > 200) return null;
  const pieces: string[] = [];
  let depth = 0;
  let s = 0;
  for (let i = 0; i < path.length; i++) {
    const ch = path[i]!;
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (--depth < 0) return null;
    } else if (depth === 0 && path[0] !== '\\' && (ch === '.' || (ch === ':' && path[i + 1] === ':'))) {
      pieces.push(path.slice(s, i));
      if (ch === ':') i++;
      s = i + 1;
    }
  }
  if (depth !== 0) return null;
  pieces.push(path.slice(s));
  const segs: Seg[] = [];
  for (const piece of pieces) {
    if (NAME.test(piece)) {
      segs.push({ kind: 'name', name: piece });
      continue;
    }
    const open = piece.indexOf('(');
    if (open <= 0 || !piece.endsWith(')')) return null;
    const head = piece.slice(0, open);
    const inner = piece.slice(open + 1, -1).trim();
    if (!inner) return null;
    if (KIND_FORMS.has(head)) {
      const target = parseTarget(inner);
      if (!target) return null;
      segs.push({ kind: 'fn', fn: head, target });
    } else if (head === 'case') {
      segs.push({ kind: 'case', key: tokenKey(inner) });
    } else if (NAME.test(head) && inner.startsWith('.') && NAME.test(inner.slice(1).trim())) {
      segs.push({ kind: 'conn', instance: head, port: inner.slice(1).trim() });
    } else return null;
  }
  // shapes: names…, then a name, a fn (optionally followed by one case), or a connection
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    const last = i === segs.length - 1;
    if (s.kind === 'case' && (i === 0 || segs[i - 1]!.kind !== 'fn' || !last)) return null;
    if (s.kind === 'fn' && !(last || (i === segs.length - 2 && segs[i + 1]!.kind === 'case'))) return null;
    if (s.kind === 'conn' && !last) return null;
  }
  return segs;
}

/** The tokens of a short text as a key, as case labels are keyed. */
export function tokenKey(text: string): string {
  const lexed = scanSvTokens(text);
  return lexed.join(' ');
}

function scanSvTokens(text: string): string[] {
  const g = lex(text.slice(0, 400), 1000);
  let r = g.next();
  while (!r.done) r = g.next();
  const l = r.value;
  const out: string[] = [];
  for (let i = 0; i < l.toks.n && out.length < 64; i++) out.push(text.slice(l.toks.start[i], l.toks.end[i]));
  return out;
}

function parseTarget(inner: string): SvTarget | null {
  const toks = scanSvTokens(inner);
  if (!toks.length || !NAME.test(toks[0]!)) return null;
  const t: SvTarget = { base: toks[0]!, chain: [] };
  let j = 1;
  while (j < toks.length) {
    if (toks[j] === '[' && !t.chain.length && t.slice === undefined) {
      let d = 0;
      const s = j;
      for (; j < toks.length; j++) {
        if (toks[j] === '[' || toks[j] === '(' || toks[j] === '{') d++;
        else if (toks[j] === ']' || toks[j] === ')' || toks[j] === '}') d--;
        if (d === 0) break;
      }
      if (d !== 0) return null;
      t.slice = toks.slice(s + 1, j).join(' ');
      j++;
      continue;
    }
    if (toks[j] === '.' && toks[j + 1] && NAME.test(toks[j + 1]!)) {
      t.chain.push(toks[j + 1]!);
      j += 2;
      continue;
    }
    return null;
  }
  return t;
}

function scopeMatches(table: SymbolTable, scope: readonly string[], prefix: readonly string[]): boolean {
  if (prefix.length === 0) return true;
  if (table.units.has(prefix[0]!)) return scope.length === prefix.length && prefix.every((p, i) => scope[i] === p);
  if (scope.length < prefix.length) return false;
  const off = scope.length - prefix.length;
  return prefix.every((p, i) => scope[off + i] === p);
}

const shown = (path: string) => `\`${path}\``;

/** Lookups by name, built once per table, so many links into one file stay cheap whatever the file holds. */
interface TableIndex {
  symbols: Map<string, SvSymbol[]>;
  drivers: Map<string, SvDriver[]>;
  connections: Map<string, SvConnection[]>;
  connectedIdents: Map<string, SvConnection[]>;
  /** Case labels → the drivers whose outermost case has them. */
  caseLabels: Map<string, SvDriver[]>;
}
const indexes = new WeakMap<SymbolTable, TableIndex>();
const caseIndexes = new WeakMap<SvDriver, Map<string, { item: SvCaseItem; depth: number }[]>>();
/** Index lists are whole (the records cap bounds them): a scoped name past the first few must still be found. */
function addTo<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const l = m.get(k);
  if (!l) m.set(k, [v]);
  else if (l[l.length - 1] !== v) l.push(v);
}

function indexOf(table: SymbolTable): TableIndex {
  let ix = indexes.get(table);
  if (ix) return ix;
  ix = { symbols: new Map(), drivers: new Map(), connections: new Map(), connectedIdents: new Map(), caseLabels: new Map() };
  for (const s of table.symbols) addTo(ix.symbols, s.name, s);
  for (const d of table.drivers) {
    for (const b of new Set(d.targets.map((t) => t.base))) addTo(ix.drivers, b, d);
    for (const c of d.cases) if (c.depth === 0) for (const it of c.items) for (const l of it.labels) {
      addTo(ix.caseLabels, l, d); // drivers come in order, so a repeat is always the last entry
    }
  }
  for (const c of table.connections) {
    addTo(ix.connections, `${c.instance}\0${c.port}`, c);
    for (const i of c.idents) addTo(ix.connectedIdents, i, c);
  }
  indexes.set(table, ix);
  return ix;
}

function caseIndexOf(d: SvDriver): Map<string, { item: SvCaseItem; depth: number }[]> {
  let m = caseIndexes.get(d);
  if (m) return m;
  m = new Map();
  for (const c of d.cases) for (const item of c.items) for (const l of item.labels) addTo(m, l, { item, depth: c.depth });
  caseIndexes.set(d, m);
  return m;
}

const lines = (r: LineRange) => (r.start === r.end ? `${r.start}` : `${r.start}–${r.end}`);
const named = (scope: readonly string[]) => scope.filter((s) => !s.startsWith('\0'));

/** Finds what a symbol path names in a scanned file. */
export function findSvSymbol(table: SymbolTable, path: string): SvFound | SvNotFound {
  const segs = parseSvPath(path);
  if (!segs) return { ok: false, reason: 'syntax', message: `${shown(path)} isn't a symbol path (a name, driver(x), driver(x).case(LABEL) or u_inst(.port), optionally after the module).` };
  const ix = indexOf(table);
  const prefix = segs.flatMap((s, i) => (s.kind === 'name' && i < segs.length - 1 ? [s.name] : []));
  const last = segs.at(-1)!;
  const partial = table.partial || undefined;
  const miss = (what: string, hint?: string): SvNotFound => ({
    ok: false,
    reason: 'missing',
    partial,
    message: `${what} not found${hint ? `: ${hint}` : ''}${partial ? ` (the file didn't scan cleanly${table.partialReason === 'budget' ? ': it is too large' : ''}, so this may be the scanner's mistake)` : ''}.`,
  });
  const ambiguous = (what: string, cands: LineRange[], hint: string): SvNotFound => ({
    ok: false,
    reason: 'ambiguous',
    partial,
    candidates: cands.slice(0, 5),
    message: `${what} is ambiguous (lines ${cands.slice(0, 5).map(lines).join(', ')}${cands.length > 5 ? ' …' : ''}): ${hint}.`,
  });
  const instanceHint = () => {
    for (let i = 0; i < prefix.length; i++) {
      const inst = ix.symbols.get(prefix[i]!)?.find((s) => s.kind === 'instance');
      if (inst?.type) {
        const rest = path.slice(path.indexOf(prefix[i]!) + prefix[i]!.length + 1);
        return `paths are by module, not instance: ${inst.name} is a ${inst.type}, so link the file that defines ${inst.type} with ${shown(`#${rest}`)}`;
      }
    }
    return undefined;
  };
  const otherHints = (name: string) => {
    const hints: string[] = [];
    // only for names the scanned arms don't declare: a name merely used in a later arm says nothing
    if (table.skipped.has(name) && !ix.symbols.has(name)) hints.push('it is in a later `ifdef arm, which is not scanned yet');
    // only for names nothing else in the file accounts for (not an input, not driven elsewhere)
    const macro = ix.symbols.get(name)?.some((s) => s.kind === 'port' && s.dir === 'input') || ix.drivers.has(name) ? undefined : table.macroUses.get(name);
    if (macro) hints.push(`it is an argument of \`${macro.macro} on line ${macro.line}, and macros aren't followed yet: link ${shown(`#L${macro.line}`)}`);
    return hints;
  };
  /** Up to 6 matches: enough to tell one from several, and to list a few. */
  const pick = <T>(list: readonly T[] | undefined, ok: (x: T) => boolean): T[] => {
    const out: T[] = [];
    for (const x of list ?? []) if (ok(x) && out.push(x) >= 6) break;
    return out;
  };

  if (last.kind === 'name') {
    const cands = pick(ix.symbols.get(last.name), (s) => scopeMatches(table, s.scope, prefix));
    if (cands.length === 1) return { ok: true, extent: cands[0]!.extent, kind: cands[0]!.kind };
    if (cands.length > 1) {
      // A non-ANSI port and its type declaration (`output q; reg q;`) are one name.
      const ports = cands.filter((s) => s.kind === 'port');
      const sameScope = cands.every((s) => s.scope.join('.') === cands[0]!.scope.join('.'));
      if (sameScope && ports.length === 1 && cands.every((s) => s.kind === 'port' || s.kind === 'signal')) return { ok: true, extent: ports[0]!.extent, kind: 'port' };
      const scopes = [...new Set(cands.map((s) => named(s.scope.slice(1)).join('.')).filter(Boolean))];
      return ambiguous(shown(path), cands.map((s) => s.extent), scopes.length > 1 ? `name its block, as ${shown(`${scopes[0]}.${last.name}`)}` : 'it is declared more than once; prefix the module or the block label');
    }
    const inner = pick(ix.symbols.get(last.name), () => true).filter((s) => named(s.scope.slice(1)).length);
    const hints = otherHints(last.name);
    if (inner.length && prefix.length) hints.push(`there is one inside a block: ${shown(`${[...named(inner[0]!.scope), last.name].join('.')}`)}`);
    const inst = instanceHint();
    if (inst) hints.push(inst);
    return miss(shown(path), hints.join('; ') || undefined);
  }
  if (last.kind === 'conn') {
    const cands = pick(ix.connections.get(`${last.instance}\0${last.port}`), (c) => scopeMatches(table, c.scope, prefix));
    if (cands.length === 1) return { ok: true, extent: cands[0]!.extent, kind: 'connection' };
    if (cands.length > 1) return ambiguous(shown(path), cands.map((c) => c.extent), 'more than one instance has that name; prefix the module or the generate block label');
    const inst = ix.symbols.get(last.instance)?.some((s) => s.kind === 'instance');
    return miss(shown(path), inst ? `${last.instance} has no named connection .${last.port}(…) (positional and .* connections can't be linked)` : otherHints(last.instance)[0] ?? `there is no instance ${last.instance}`);
  }
  // driver(x), always_ff(x) …, optionally .case(LABEL)
  const fnSeg = (last.kind === 'case' ? segs.at(-2) : last) as Extract<Seg, { kind: 'fn' }>;
  const q = fnSeg.target;
  const label = prefix.length ? prefix.at(-1) : undefined;
  const targetMatches = (d: SvDriver) => d.targets.some((t) => t.base === q.base && q.chain.every((c, i) => t.chain[i] === c) && (q.slice === undefined || t.slice === q.slice));
  const inScope = (d: SvDriver) => scopeMatches(table, d.scope, prefix) || (label !== undefined && d.label === label && scopeMatches(table, [...d.scope, d.label], prefix));
  const all = pick(ix.drivers.get(q.base), (d) => inScope(d) && targetMatches(d));
  let cands = fnSeg.fn === 'driver' ? all : all.filter((d) => d.kind === fnSeg.fn);
  let note: string | undefined;
  if (!cands.length && all.length && fnSeg.fn !== 'driver') {
    cands = all;
    note = `${q.base} is driven by ${all.length === 1 ? `an ${all[0]!.kind}` : 'other kinds of blocks'}, not ${fnSeg.fn}: write driver(${q.base})`;
  }
  const what = shown(path);
  if (cands.length === 0) {
    const hints: string[] = [];
    const port = ix.symbols.get(q.base)?.find((s) => s.kind === 'port' && scopeMatches(table, s.scope, prefix));
    if (port && port.dir === 'input') hints.push(`${q.base} is an input port: link ${shown(`#${q.base}`)}`);
    const conns = pick(ix.connectedIdents.get(q.base), (c) => scopeMatches(table, c.scope, prefix));
    if (conns.length) {
      const list = conns.slice(0, 3).map((c) => shown(`#${c.instance}(.${c.port})`)).join(', ');
      hints.push(`${q.base} is connected at ${list}${conns.length > 3 ? ' …' : ''}, and driver() doesn't follow instance ports: link the connection, or the driver in the child module's file`);
    }
    hints.push(...otherHints(q.base));
    const inst = instanceHint();
    if (inst) hints.push(inst);
    if (!hints.length && !ix.symbols.has(q.base)) hints.push(`nothing in the file declares ${q.base}`);
    return miss(`What drives ${q.base} (${what})`, hints.join('; ') || undefined);
  }
  if (cands.length > 1) {
    const mine = cands.map((d) => d.targets.filter((t) => t.base === q.base));
    const slices = mine.flatMap((ts) => ts.filter((t) => t.slice !== undefined).map((t) => t.slice!));
    const members = mine.map((ts) => ts.find((t) => t.chain.length > q.chain.length)?.chain[q.chain.length]);
    const scopes = cands.map((d) => d.label ?? named(d.scope.slice(1)).at(-1));
    let hint: string;
    if (q.slice === undefined && slices.length >= cands.length) hint = `blocks drive different slices; name one, as driver(${q.base}[${slices[0]}])`;
    else if (members.every((m) => m !== undefined) && new Set(members).size === members.length) hint = `blocks drive different members; name one, as driver(${[q.base, ...q.chain, members[0]].join('.')})`;
    else if (scopes.every((x) => x !== undefined) && new Set(scopes).size === scopes.length) hint = `name the block, as ${scopes[0]}.driver(${q.base})`;
    else if (cands.every((d) => d.kind === 'assign' || d.kind === 'net')) hint = `more than one assign drives it; link one by its lines, as #L${lines(cands[0]!.extent).replace('–', '-L')}`;
    else hint = 'more than one block drives it; add a label (`begin : seq`) and prefix it, as seq.driver(x)';
    return ambiguous(`What drives ${q.base} (${what})`, cands.map((d) => d.extent), hint);
  }
  const d = cands[0]!;
  if (last.kind !== 'case') return { ok: true, extent: d.extent, kind: d.kind, note };
  const found = caseIndexOf(d).get(last.key) ?? [];
  const outer = found.filter((f) => f.depth === 0);
  if (outer.length === 1) return { ok: true, extent: outer[0]!.item.extent, kind: 'case-item', note };
  if (outer.length > 1) return ambiguous(what, outer.map((f) => f.item.extent), 'the label is in more than one outermost case of the block; link the lines instead');
  if (found.length) return ambiguous(what, found.map((f) => f.item.extent), 'the label is only in a nested case; link the lines instead');
  // A common slip: naming the case's selector (state_q) rather than what the arms assign (state_d).
  const elsewhere = (ix.caseLabels.get(last.key) ?? []).find((o) => o !== d);
  const other = elsewhere && defaultDriverName(elsewhere);
  return miss(what, other ? `the block that drives ${q.base} has no case item ${last.key}, but the one that drives ${other} has: ${shown(`driver(${other}).case(${last.key})`)}` : `no item of the block's outermost case has the label ${last.key}`);
}

/**
 * The name Pin and Re-anchor would write for a block (§4.2): a `highlight` signal it drives, else the first
 * signal it assigns in the functional branch.
 */
export function defaultDriverName(d: SvDriver, highlight: readonly string[] = []): string | undefined {
  const bases = new Set(d.targets.map((t) => t.base));
  return highlight.find((h) => bases.has(h)) ?? d.functional[0] ?? d.targets[0]?.base;
}

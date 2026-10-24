// The SystemVerilog scanner lite (docs/AUTHORING-PLAN.md §4.3, §4.10, §10.4): the corpus with its expected
// tables, the path rules of §4.2, the reset heuristic, and the cost protections on hostile input.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultDriverName, findSvSymbol, isResetName, scanSv, scanSvSliced, type SymbolTable } from '../../src/core/symbols/sv.ts';

const FIXTURES = 'test/unit/fixtures/sv';
const STREAM_DMA = 'examples/stream-dma/rtl';

/** The table as readable text, for the expected files next to the corpus. */
function dump(t: SymbolTable): string {
  const scope = (s: string[]) => s.map((x) => (x.startsWith('\0') ? '<unlabelled>' : x)).join('.');
  const lines = [`partial: ${t.partial}${t.partialReason ? ` (${t.partialReason})` : ''}`];
  for (const s of t.symbols) lines.push(`S ${s.kind} ${[scope(s.scope), s.name].filter(Boolean).join('.')} ${s.extent.start}-${s.extent.end}${s.dir ? ` dir=${s.dir}` : ''}${s.type ? ` type=${s.type}` : ''}`);
  for (const d of t.drivers) {
    const targets = d.targets.map((x) => `${x.base}${x.slice !== undefined ? `[${x.slice}]` : ''}${x.chain.map((c) => `.${c}`).join('')}`);
    lines.push(`D ${d.kind} ${scope(d.scope)}${d.label ? ` label=${d.label}` : ''} ${d.extent.start}-${d.extent.end} drives=${targets.join(',')} functional=${d.functional.join(',')}`);
    for (const c of d.cases) lines.push(`  case depth=${c.depth}: ${c.items.map((i) => `${i.labels.join(' | ')} @${i.extent.start}-${i.extent.end}`).join('; ')}`);
  }
  for (const c of t.connections) lines.push(`C ${scope(c.scope)} ${c.instance}(.${c.port}) ${c.extent.start}-${c.extent.end} = ${c.idents.join(',')}`);
  if (t.skipped.size) lines.push(`skipped arms: ${[...t.skipped].sort().join(' ')}`);
  return `${lines.join('\n')}\n`;
}

const read = (path: string) => readFileSync(path, 'utf8');
const scan = (path: string) => scanSv(read(path));
const find = (path: string, q: string) => findSvSymbol(scan(path), q);
const lines = (path: string, q: string) => {
  const r = find(path, q);
  return r.ok ? [r.extent.start, r.extent.end] : r.reason;
};

describe('the corpus', () => {
  const corpus = readdirSync(FIXTURES).filter((f) => /\.s?v$/.test(f));
  it.each(corpus)('%s scans to its expected table', async (f) => {
    await expect(dump(scan(join(FIXTURES, f)))).toMatchFileSnapshot(join('fixtures/sv/expected', `${f}.txt`));
  });
  const dma = readdirSync(STREAM_DMA).filter((f) => f.endsWith('.sv'));
  it('has all eight stream-dma modules', () => expect(dma).toHaveLength(8));
  it.each(dma)('stream-dma %s scans cleanly to its expected table', async (f) => {
    const t = scan(join(STREAM_DMA, f));
    expect(t.partial).toBe(false);
    await expect(dump(t)).toMatchFileSnapshot(join('fixtures/sv/expected/stream-dma', `${f}.txt`));
  });
  it('bit_reader.sv scans cleanly; its block-local variables are not drivers', async () => {
    const t = scan('fixtures/sample-workspace/rtl/bit_reader.sv');
    expect(t.partial).toBe(false);
    const d = t.drivers.find((x) => x.kind === 'always_ff')!;
    expect(d.targets.map((x) => x.base).sort()).toEqual(['buf_q', 'cnt_q']);
    expect(defaultDriverName(d)).toBe('buf_q');
    await expect(dump(t)).toMatchFileSnapshot('fixtures/sv/expected/bit_reader.sv.txt');
  });
});

describe('paths (§4.2, lite)', () => {
  const ctrl = `${STREAM_DMA}/dma_ctrl.sv`;
  const top = `${STREAM_DMA}/dma_top.sv`;
  it('names, unqualified when unique, or after the module', () => {
    expect(lines(ctrl, 'state_q')).toEqual([49, 49]);
    expect(lines(ctrl, 'dma_ctrl.state_q')).toEqual([49, 49]);
    expect(lines(ctrl, 'BW')).toEqual([11, 11]);
    expect(lines(ctrl, 'state_e')).toEqual([45, 47]);
    expect(lines(ctrl, 'IDLE')).toEqual([45, 47]);
    expect(lines(ctrl, 'dma_ctrl')).toEqual([10, 160]);
    expect(lines(top, 'u_fifo')).toEqual([110, 114]);
    expect(lines(ctrl, 'other.state_q')).toBe('missing');
  });
  it('ports take their line, with the comment block directly above', () => {
    expect(lines(ctrl, 'start')).toEqual([16, 17]); // "// from / to the CSRs" sits above it
    expect(lines(ctrl, 'len_zero')).toEqual([18, 18]);
  });
  it('driver(x): the always block or assign, with its comments', () => {
    expect(lines(ctrl, 'driver(state_d)')).toEqual([61, 134]);
    expect(lines(ctrl, 'driver(state_q)')).toEqual([136, 155]);
    expect(lines(ctrl, 'driver(credit_ok)')).toEqual([56, 59]);
    expect(lines(ctrl, 'dma_ctrl.driver(busy)')).toEqual([157, 157]);
  });
  it('the kind forms: matching, and a mismatch that still resolves with a note', () => {
    expect(lines(ctrl, 'always_comb(state_d)')).toEqual([61, 134]);
    const r = find(ctrl, 'always_ff(state_d)');
    expect(r.ok && r.note).toMatch(/always_comb/);
  });
  it('case items of the outermost case', () => {
    expect(lines(ctrl, 'driver(state_d).case(WAIT_DATA)')).toEqual([89, 98]);
    expect(lines(ctrl, 'driver(state_d).case(default)')).toEqual([125, 125]);
    expect(lines(ctrl, 'driver(state_d).case(NOPE)')).toBe('missing');
  });
  it('port connections, and what driver() says for a net only an instance drives', () => {
    expect(lines(top, 'u_ctrl(.rd_start)')).toEqual([85, 85]);
    expect(lines(top, 'dma_top.u_rd_port(.start)')).toEqual([103, 103]);
    const r = find(top, 'driver(rd_start)');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain('`#u_ctrl(.rd_start)`');
    const input = find(`${STREAM_DMA}/dma_rd_port.sv`, 'driver(rd_rsp_valid)');
    expect(!input.ok && input.message).toMatch(/rd_rsp_valid is an input port: link `#rd_rsp_valid`/);
  });
  it('instance paths get a "by module, not instance" hint', () => {
    const r = find(top, 'dma_top.u_ctrl.state_q');
    expect(!r.ok && r.message).toMatch(/by module, not instance: u_ctrl is a dma_ctrl/);
  });
  it('generate blocks and labels scope names', () => {
    const g = `${FIXTURES}/generate.sv`;
    expect(lines(g, 'g_lane.driver(lane_q)')).toEqual([15, 16]);
    expect(lines(g, 'gen_packer.g_lane.g_reg.driver(out_q)')).toEqual([19, 19]);
    expect(lines(g, 'driver(lane_q)')).toEqual([15, 16]); // unique in the file
    expect(lines(g, 'g_lane')).toEqual([13, 24]);
    expect(lines(g, 'g_named')).toEqual([44, 47]);
    // the same name in two blocks: ambiguous until a block names it
    expect(lines(g, 'mode_q')).toBe('ambiguous');
    expect(lines(g, 'g_mode0.mode_q')).toEqual([28, 28]);
    expect(lines(g, 'driver(lane_out)')).toBe('ambiguous');
    expect(lines(g, 'g_comb.driver(lane_out)')).toEqual([22, 22]);
    expect(lines(g, 'driver(wide)')).toEqual([40, 40]); // inside an unlabelled block: only unqualified
    expect(lines(g, 'gen_packer.driver(wide)')).toBe('missing');
  });
  it('packages, interfaces, modports, clocking blocks and member targets', () => {
    const f = `${FIXTURES}/interface_pkg.sv`;
    expect(lines(f, 'dma_pkg::req_t')).toEqual([4, 7]);
    expect(lines(f, 'dma_pkg::clamp_len')).toEqual([11, 13]);
    expect(lines(f, 'RMW')).toEqual([8, 8]);
    expect(lines(f, 'axi_if.mst')).toEqual([27, 27]);
    expect(lines(f, 'cb')).toEqual([21, 25]);
    expect(lines(f, 'driver(bus.ready)')).toEqual([36, 36]);
    expect(lines(f, 'driver(bus)')).toEqual([36, 36]);
    expect(lines(f, 'driver(req_q.addr)')).toEqual([37, 37]);
    expect(lines(f, 'driver(bus.valid)')).toBe('missing');
  });
  it('labelled blocks, assertions, functions, tasks and instances with named and implicit connections', () => {
    const f = `${FIXTURES}/misc.sv`;
    expect(lines(f, 'seq')).toEqual([15, 17]);
    expect(lines(f, 'seq.driver(dout)')).toEqual([15, 17]);
    expect(lines(f, 'misc.seq.driver(dout)')).toEqual([15, 17]);
    expect(lines(f, 'pipe_reg.driver(stage_d)')).toEqual([19, 19]);
    expect(lines(f, 'a_no_ovf')).toEqual([29, 30]);
    expect(lines(f, 'next_len')).toEqual([21, 23]);
    expect(lines(f, 'pulse')).toEqual([25, 27]);
    expect(lines(f, 'u_fifo(.wdata)')).toEqual([35, 36]);
    expect(lines(f, 'u_fifo(.full)')).toEqual([37, 37]);
    expect(lines(f, 'u_pos(.clk)')).toBe('missing'); // positional
    // the macro's flop isn't a driver in the lite scanner; the extern prototype didn't swallow the class
    expect(lines(f, 'driver(stage_q)')).toBe('missing');
    expect(lines(f, 'packet')).toEqual([46, 51]);
  });
  it('slices: separate drivers, ambiguous without a slice key', () => {
    const f = `${FIXTURES}/drivers.sv`;
    const r = find(f, 'driver(word)');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(/driver\(word\[7 : 4\]\)/);
    expect(lines(f, 'driver(word[7:4])')).toEqual([22, 23]);
    expect(lines(f, 'driver(word[3:0])')).toEqual([24, 24]);
  });
  it('syntax errors are reported, never thrown', () => {
    for (const q of ['', 'driver()', 'driver(x', 'a..b', 'case(IDLE)', 'driver(x).case(A).more', 'u(.p).x', 'x.header(', '1abc']) {
      const r = findSvSymbol(scanSv('module m; endmodule'), q);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toBe('syntax');
    }
  });
});

describe('what counts as driving a signal (§4.2)', () => {
  const t = scan(`${FIXTURES}/drivers.sv`);
  const drives = (base: string) => t.drivers.filter((d) => d.targets.some((x) => x.base === base)).map((d) => d.extent.start);
  it('`<=` in a condition is a comparison, not a driver of cnt_q', () => {
    expect(drives('hit_q')).toEqual([15]);
    expect(drives('cnt_q')).toEqual([26]);
  });
  it('every element of a concatenation target', () => {
    expect(drives('carry')).toEqual([20]);
    expect(drives('sum')).toEqual([20]);
  });
  it('compound assignments, ++, for loops and intra-assignment delays', () => {
    expect(drives('idx')).toEqual([40]);
    expect(drives('acc_q')).toEqual([26]);
    expect(drives('i')).toEqual([]);
  });
  it('signals in the reset and the functional branches; a chain of resets; the default name', () => {
    const d = t.drivers.find((x) => x.extent.start === 26)!;
    expect(d.functional).toEqual(['acc_q', 'first_q', 'cnt_q']);
    expect(defaultDriverName(d)).toBe('acc_q');
    expect(defaultDriverName(d, ['first_q'])).toBe('first_q');
  });
  it('always without begin, if / else chains, non-ANSI ports, a net declaration assignment', () => {
    const f = `${FIXTURES}/non_ansi.v`;
    expect(lines(f, 'driver(q)')).toEqual([12, 20]);
    expect(lines(f, 'driver(wrap)')).toEqual([10, 10]);
    expect(lines(f, 'q')).toEqual([7, 7]); // `output [7:0] q;` and `reg [7:0] q;` are one name
  });
});

describe('case items', () => {
  const f = `${FIXTURES}/cases.sv`;
  it('several labels, default, unique0 and priority', () => {
    expect(lines(f, 'driver(state_d).case(IDLE)')).toEqual([17, 17]);
    expect(lines(f, 'driver(state_d).case(WAIT)')).toEqual([17, 17]);
    expect(lines(f, 'driver(state_d).case(RUN)')).toEqual([18, 23]);
    expect(lines(f, 'driver(state_d).case(default)')).toEqual([24, 24]);
  });
  it('a label only in a nested case is ambiguous', () => {
    expect(lines(f, "driver(state_d).case(2'b01)")).toBe('ambiguous');
  });
  it('one-hot case (1\'b1) with expression labels, compared as tokens', () => {
    expect(lines(f, 'driver(onehot_d).case(onehot_q[IDLE_BIT])')).toEqual([31, 31]);
    expect(lines(f, 'driver(onehot_d).case( onehot_q [ RUN_BIT ] )')).toEqual([32, 32]);
    expect(lines(f, "driver(mux).case({1'b1,1'b0})")).toEqual([39, 39]);
    expect(lines(f, "driver(mux).case([2'd0:2'd1])")).toEqual([38, 38]);
  });
});

describe('`ifdef arms', () => {
  const f = `${FIXTURES}/ifdef.sv`;
  it('only the first arm is scanned, so the scope stack never desyncs', () => {
    const t = scan(f);
    expect(t.partial).toBe(false);
    expect(lines(f, 'driver(q)')).toEqual([9, 15]);
  });
  it('a name declared in two arms is one name, and a later-arm name gets the hint', () => {
    expect(lines(f, 'dbg_seen')).toEqual([18, 18]);
    const r = find(f, 'trace_only');
    expect(!r.ok && r.message).toMatch(/later `ifdef arm/);
    const d = find(f, 'driver(trace_only)');
    expect(!d.ok && d.message).toMatch(/later `ifdef arm/);
  });
});

describe('lexing: comments, strings, attributes, escaped names, literals, macros', () => {
  const f = `${FIXTURES}/lexing.sv`;
  it('scans cleanly; nothing in a comment or string is code', () => {
    const t = scan(f);
    expect(t.partial).toBe(false);
    expect([...t.units]).toEqual(['lexing']);
    expect(t.symbols.map((s) => s.name)).not.toContain('fake');
  });
  it('escaped identifiers, attributes and macro uses', () => {
    expect(lines(f, '\\bus[0]')).toEqual([3, 3]);
    expect(lines(f, 'clk')).toEqual([4, 4]);
    expect(lines(f, 'driver(keep_me)')).toEqual([18, 18]);
    expect(lines(f, 'driver(out_q)')).toEqual([19, 21]);
  });
});

describe('recovery', () => {
  it('an unbalanced file is partial; the next module is still found; a miss says so', () => {
    const f = `${FIXTURES}/unbalanced.sv`;
    const t = scan(f);
    expect(t.partial).toBe(true);
    expect(lines(f, 'after_it.driver(b)')).toEqual([18, 18]);
    expect(lines(f, 'driver(held)')).toEqual([14, 14]); // the missing `end`s close at the assign
    const r = find(f, 'nothing_here');
    expect(!r.ok && r.partial && r.message).toMatch(/didn't scan cleanly/);
  });
});

describe('the reset-name heuristic (§4.2)', () => {
  it.each(['rst', 'rst_n', 'rst_ni', 'rstn', 'arst_n', 'aresetn', 'ARESETn', 'areset', 'srst', 'srst_n', 'por_n', 'porn', 'nrst', 'nreset', 'rstb', 'resetb', 'sys_rst_n', 'RESET', 'i_rst', 'rst_i', 'core_reset_n', 'dmaRst'])('%s is a reset', (id) => expect(isResetName(id)).toBe(true));
  it.each(['first_q', 'wr_burst_len', 'burst', 'clk', 'restart', 'presetn_like', 'thirst', 'rstx', 'Burst'])('%s is not', (id) => expect(isResetName(id)).toBe(false));
  it('a whole segment counts even in a name that isn\'t a reset (reset_done_q): a heuristic, for choosing a name only', () => {
    expect(isResetName('reset_done_q')).toBe(true);
  });
  it('a non-clock edge in the sensitivity list counts as a reset whatever its name', () => {
    const t = scanSv(`module m(input clk, input kill, input d, output logic q);
  always_ff @(posedge clk or posedge kill) begin
    if (kill) q <= 1'b0;
    else q <= d;
  end
endmodule`);
    expect(t.drivers[0]!.functional).toEqual(['q']);
    expect(t.drivers[0]!.targets.map((x) => x.base)).toEqual(['q']);
  });
});

describe('cost on hostile input (§4.3, §4.9)', () => {
  it('stops at the token budget with a partial table', () => {
    const t = scanSv('module m; logic a; logic b; logic c; endmodule', { budget: 5 });
    expect(t.partial).toBe(true);
    expect(t.partialReason).toBe('budget');
  });
  it('deep nesting is skipped, not recursed into', () => {
    const t = scanSv(`module m; always_comb ${'begin '.repeat(50_000)}x = 1;${' end'.repeat(50_000)}\nassign y = 1;\nendmodule`);
    expect(t.partial).toBe(true);
    expect(findSvSymbol(t, 'driver(y)').ok).toBe(true);
  });
  it('a 10 MB file scans in slices, gives the event loop back, and stops when asked', async () => {
    const unit = 'module m; always_ff @(posedge clk) begin if (a <= b) begin x <= {y, z}; end end\n assign w = (* attr *) v; // c\nendmodule\n';
    const text = unit.repeat(Math.ceil(10_000_000 / unit.length));
    expect(text.length).toBeGreaterThanOrEqual(10_000_000);
    let pauses = 0;
    let maxGap = 0;
    let last = Date.now();
    const t = await scanSvSliced(text, {
      sliceMs: 15,
      stop: () => false,
      pause: async () => {
        pauses++;
        maxGap = Math.max(maxGap, Date.now() - last);
        await new Promise((r) => setImmediate(r));
        last = Date.now();
      },
    });
    expect(t).toBeDefined();
    expect(pauses).toBeGreaterThan(3);
    expect(maxGap).toBeLessThan(250);
    let stops = 0;
    const stopped = await scanSvSliced(text, { sliceMs: 5, stop: () => ++stops > 1, pause: () => new Promise((r) => setImmediate(r)) });
    expect(stopped).toBeUndefined();
  }, 60_000);
  it.each([
    ['unbalanced brackets', '('.repeat(1_000_000)],
    ['begin, over and over', 'begin '.repeat(500_000)],
    ['an unterminated comment', `module m; /*${'x'.repeat(1_000_000)}`],
    ['macro calls that never close', '`FOO('.repeat(100_000)],
    ['labels everywhere', 'a: '.repeat(300_000)],
    ['instances without end', 'module m; '.concat('t u ( .a(b), '.repeat(100_000))],
    ['case labels', `module m; always_comb case (x) ${'a, '.repeat(200_000)}`],
  ])('%s: linear, and partial', (_name, text) => {
    const t0 = Date.now();
    const t = scanSv(text);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(t.partial).toBe(true);
  });
});

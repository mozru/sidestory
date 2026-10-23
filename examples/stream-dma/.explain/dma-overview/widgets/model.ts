// A cycle-by-cycle model of dma_top (rtl/*.sv), written to follow the RTL line for line: each cycle
// computes the combinational signals from the registers, then updates the registers. The bus slaves
// behave like the testbench's (tb/dma_tb.sv), with a read latency and optional stalls or an error.

export type State = 'IDLE' | 'LOAD' | 'READ_BURST' | 'WAIT_DATA' | 'WRITE_BURST' | 'WAIT_WRITE' | 'DONE' | 'ERROR';
export type Scenario = 'smooth' | 'wr-stall' | 'rd-slow' | 'rd-error';

export const MAX_BURST = 16;
export const FIFO_DEPTH = 32;
export const AF_LEVEL = FIFO_DEPTH - MAX_BURST;

export interface Config {
  src: number;
  dst: number;
  len: number;
  scenario: Scenario;
}

/** What happened in one cycle: the state during it, and every signal the diagram shows. */
export interface Cycle {
  n: number;
  state: State;
  next: State;
  // control strobes and handshakes (combinational, this cycle)
  start: boolean;
  load: boolean;
  rdStart: boolean;
  rdDone: boolean;
  rdErr: boolean;
  wrStart: boolean;
  wrDone: boolean;
  rdBusy: boolean;
  wrBusy: boolean;
  drain: boolean;
  doneSet: boolean;
  errSet: boolean;
  creditOk: boolean;
  almostFull: boolean;
  fifoFull: boolean;
  rdReq: boolean; // rd_req_valid && rd_req_ready
  wrReq: boolean;
  rdBeat: number | null; // index of the read beat pushed into the FIFO
  pop: number | null; // index of the beat the packer took
  emit: number | null; // index of the output beat sent to the write port
  wrBeat: number | null; // index of the beat written to the bus
  rdStall: boolean; // read port wants beats but the FIFO is full
  wrStall: boolean; // write port has a beat but the bus isn't ready
  prime: boolean;
  // registers (value during this cycle)
  fifo: number[];
  inRcvd: number;
  outIssued: number;
  rdAddr: number;
  rdLeft: number;
  wrAddr: number;
  wrLeft: number;
  rdBurst: number;
  wrBurst: number;
  rdPortLeft: number;
  wrPortLeft: number;
  done: boolean;
  err: boolean;
  irq: boolean;
  errCode: number;
}

const beatsOf = (base: number, len: number) => ((base & 7) + len + 7) >> 3;
const burstOf = (addr: number, left: number) => {
  const to4k = 512 - ((addr >> 3) & 511);
  return Math.min(MAX_BURST, to4k, left);
};

/** Runs one transfer from the start pulse until the engine is idle again (at most `limit` cycles). */
export function simulate(cfg: Config, limit = 1200): Cycle[] {
  const { src, dst, len, scenario } = cfg;
  const out: Cycle[] = [];
  // registers
  let state: State = 'IDLE';
  let inRcvd = 0, outIssued = 0, extra = false, errCode = 0;
  let rdAddr = 0, rdLeft = 0, wrAddr = 0, wrLeft = 0; // address generators
  let rpReq = false, rpLeft = 0, rpErr = false; // dma_rd_port
  let wpReq = false, wpRsp = false, wpLeft = 0; // dma_wr_port
  let fifo: number[] = [];
  let pkPrime = false, pkInLeft = 0, pkOutLeft = 0; // dma_packer
  let done = false, err = false;
  // bus slaves
  let sRdLeft = 0, sRdLat = 0, sWrLeft = 0, sWrRsp = false;
  let rdBeats = 0, outBeats = 0, wrBeats = 0;
  let idleAfter = 0;

  for (let n = 0; n < limit; n++) {
    const start = n === 1;
    // ---- address generators (comb)
    const rdHas = rdLeft !== 0, wrHas = wrLeft !== 0;
    const rdBurst = rdHas ? burstOf(rdAddr, rdLeft) : 0;
    const wrBurst = wrHas ? burstOf(wrAddr, wrLeft) : 0;
    // ---- FIFO flags
    const fifoFull = fifo.length === FIFO_DEPTH;
    const almostFull = fifo.length > AF_LEVEL;
    // ---- read slave and dma_rd_port
    const rdStallBus = scenario === 'rd-slow' && n % 2 === 1;
    const rspValid = sRdLeft > 0 && sRdLat === 0 && !rdStallBus;
    const rspReady = rpLeft !== 0 && !fifoFull;
    const rdBeatFire = rspValid && rspReady;
    const rspErr = scenario === 'rd-error' && rdBeatFire && rdBeats === 30;
    const rdDone = rdBeatFire && rpLeft === 1;
    const rdErr = rpErr || rspErr;
    const rdReq = rpReq && sRdLeft === 0;
    // ---- write port, packer
    const wrStallBus = scenario === 'wr-stall' && n % 3 !== 0;
    const wrDatReady = sWrLeft > 0 && !wrStallBus;
    const sending = wpLeft !== 0;
    const pkReady = wrDatReady && sending;
    const flush = pkInLeft === 0;
    const inValid = fifo.length > 0;
    const rdBusy = rpReq || rpLeft !== 0;
    const wrBusy = wpReq || sending || wpRsp;
    const drain = state === 'ERROR';
    const inReady = drain || (!flush && (pkPrime || (pkReady && pkOutLeft !== 0)));
    const outValid = drain || (!pkPrime && pkOutLeft !== 0 && (inValid || flush));
    const take = inValid && inReady;
    const emit = outValid && pkReady;
    const wrReq = wpReq && sWrLeft === 0 && !sWrRsp;
    const wrDone = wpRsp && sWrRsp;
    // ---- dma_ctrl (comb)
    const creditOk = !rdHas || inRcvd >= outIssued + wrBurst + (extra ? 1 : 0);
    let next: State = state;
    let load = false, rdStart = false, wrStart = false, doneSet = false, errSet = false;
    let errCodeD = errCode;
    switch (state) {
      case 'IDLE': if (start) next = 'LOAD'; break;
      case 'LOAD':
        load = true;
        if (len === 0) { errCodeD = 1; next = 'ERROR'; } else next = 'READ_BURST';
        break;
      case 'READ_BURST':
        if (!rdHas || almostFull) next = 'WRITE_BURST';
        else { rdStart = true; next = 'WAIT_DATA'; }
        break;
      case 'WAIT_DATA':
        if (rdDone) {
          if (rdErr) { errCodeD = 2; next = 'ERROR'; } else next = creditOk ? 'WRITE_BURST' : 'READ_BURST';
        }
        break;
      case 'WRITE_BURST':
        if (!wrHas) next = wrBusy ? 'WAIT_WRITE' : 'DONE';
        else if (wrBusy) next = 'WAIT_WRITE';
        else if (creditOk) { wrStart = true; next = 'READ_BURST'; } else next = 'READ_BURST';
        break;
      case 'WAIT_WRITE':
        if (wrDone) next = 'READ_BURST'; // the model's write responses never fail
        break;
      case 'DONE': doneSet = true; next = 'IDLE'; break;
      case 'ERROR':
        if (!rdBusy && !wrBusy) { errSet = true; next = 'IDLE'; }
        break;
    }

    const cyc: Cycle = {
      n, state, next, start, load, rdStart, rdBusy, wrBusy, drain, rdDone, rdErr: rdDone && rdErr, wrStart, wrDone, doneSet, errSet, creditOk, almostFull, fifoFull,
      rdReq, wrReq,
      rdBeat: rdBeatFire ? rdBeats : null,
      pop: take ? fifo[0]! : null,
      emit: emit ? outBeats : null,
      wrBeat: emit ? wrBeats : null,
      rdStall: rpLeft !== 0 && fifoFull,
      wrStall: sending && outValid && sWrLeft > 0 && !wrDatReady,
      prime: pkPrime,
      fifo: [...fifo], inRcvd, outIssued, rdAddr, rdLeft, wrAddr, wrLeft, rdBurst, wrBurst, rdPortLeft: rpLeft, wrPortLeft: wpLeft,
      done, err, irq: done || err, errCode,
    };
    out.push(cyc);

    // ---- register updates (posedge clk)
    if (start) { done = false; err = false; }
    if (doneSet) done = true;
    if (errSet) err = true;
    errCode = errCodeD;
    if (load) {
      inRcvd = 0; outIssued = 0; extra = (dst & 7) < (src & 7);
      rdAddr = src & ~7; rdLeft = beatsOf(src, len); wrAddr = dst & ~7; wrLeft = beatsOf(dst, len);
      pkPrime = extra; pkInLeft = rdLeft; pkOutLeft = wrLeft;
    } else {
      if (rdBeatFire) inRcvd++;
      if (wrStart) outIssued += wrBurst;
    }
    if (rdStart && rdHas) { rdAddr += rdBurst * 8; rdLeft -= rdBurst; }
    if (wrStart && wrHas) { wrAddr += wrBurst * 8; wrLeft -= wrBurst; }
    // read port and slave
    if (rdStart) { rpReq = true; rpLeft = rdBurst; rpErr = false; }
    else {
      if (rdReq) { rpReq = false; sRdLeft = rpLeft; sRdLat = 3; }
      if (rdBeatFire) { rpLeft--; rpErr = rpErr || rspErr; }
    }
    if (sRdLat > 0 && !rdReq) sRdLat--;
    if (rdBeatFire) sRdLeft--;
    // packer and FIFO
    if (!load && !drain) {
      if (take) { pkInLeft--; pkPrime = false; }
      if (emit) pkOutLeft--;
    }
    if (load) fifo = [];
    if (take) fifo = fifo.slice(1);
    if (rdBeatFire) { fifo = [...fifo, rdBeats]; rdBeats++; }
    if (emit) { outBeats++; wrBeats++; }
    // write port and slave
    if (wrStart) { wpReq = true; wpLeft = wrBurst; }
    else {
      if (wrReq) { wpReq = false; sWrLeft = wpLeft; }
      if (emit) { wpLeft--; if (wpLeft === 0) wpRsp = true; }
      if (wpRsp && sWrRsp) wpRsp = false;
    }
    if (emit) { sWrLeft--; if (sWrLeft === 0) sWrRsp = true; }
    else if (sWrRsp) sWrRsp = false;

    state = next;
    if (state === 'IDLE' && n > 1) {
      if (++idleAfter > 2) break;
    }
  }
  return out;
}

export const TRANSFER: Config = { src: 0x0fa5, dst: 0x2002, len: 400, scenario: 'smooth' };
export const hex = (v: number) => `0x${v.toString(16).padStart(4, '0')}`;

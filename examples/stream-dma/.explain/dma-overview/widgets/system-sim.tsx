// The whole engine, cycle by cycle: the overview's block diagram (same geometry as the static SVG, from
// layout.json) driven by a model of the RTL (model.ts). Beats move along the data wires, control wires light
// up while their strobe or handshake is active, the FIFO fills, and the editor highlights the code that is
// "running": the FSM's case item on the simulation step, the active instance on the control and data-path steps.
import { type KeyboardEvent, useEffect, useMemo } from 'react';
import { motion } from 'motion/react';
import { Pause, Play, RotateCcw, StepBack, StepForward } from 'lucide-react';
import { highlight, reveal, useAnchorCode, useIsMyStepActive, useMyAnchor, useReducedMotion, useStepValue, useVisible, useWidgetState } from 'explainer';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import layout from './layout.json';
import { AF_LEVEL, type Cycle, FIFO_DEPTH, hex, type Scenario, simulate, TRANSFER } from './model';

type Focus = 'all' | 'control' | 'data' | 'backpressure' | 'errors';
type Wire = { id: string; kind: 'data' | 'addr' | 'ctl'; pts: number[][]; label: string; at: number[] | null; anchor: string; both: boolean; tag: string };
type Block = { id: string; x: number; y: number; w: number; h: number; title: string; sub: string; kind: string; ref: string | null; lines: string[] };

const L = layout as unknown as { viewBox: number[]; blocks: Block[]; wires: Wire[] };

const SCENARIOS: { value: Scenario; label: string }[] = [
  { value: 'smooth', label: 'No stalls' },
  { value: 'wr-stall', label: 'Write bus stalls (ready 1 in 3)' },
  { value: 'rd-slow', label: 'Slow reads (valid 1 in 2)' },
  { value: 'rd-error', label: 'Read error on beat 30' },
];

/** Which wires each focus keeps bright; the rest fade. */
const FOCUS: Record<Exclude<Focus, 'all'>, (w: Wire) => boolean> = {
  control: (w) => w.kind !== 'data' && w.tag !== 'ready',
  data: (w) => w.kind === 'data' || w.tag === 'ready',
  backpressure: (w) => ['almost_full', 'fifo_full', 'rd_rsp_ready', 'pk_ready', 'wr_dat_ready', 'fifo_pop', 'c_wrp', 'c_rdp'].includes(w.id),
  errors: (w) => ['status', 'irq', 'c_rdp', 'c_wrp', 'c_pack', 'rd_rsp_data'].includes(w.id),
};
const FOCUS_BLOCKS: Record<Exclude<Focus, 'all'>, string[]> = {
  control: ['cpu', 'csr', 'ctrl', 'rdag', 'wrag'],
  data: ['rdbus', 'rdp', 'fifo', 'pack', 'wrp', 'wrbus'],
  backpressure: ['ctrl', 'fifo', 'rdp', 'pack', 'wrp', 'wrbus'],
  errors: ['cpu', 'csr', 'ctrl', 'rdp', 'pack', 'wrp'],
};

/** What a wire is doing this cycle: 'on' (strobe, handshake, beat), 'stall' (backpressure), or idle. */
function wireState(id: string, c: Cycle): 'on' | 'stall' | null {
  switch (id) {
    case 'rd_rsp_data': case 'fifo_wdata': return c.rdBeat !== null ? 'on' : null;
    case 'fifo_rdata': return c.pop !== null ? 'on' : null;
    case 'packed_data': case 'wr_dat_data': return c.emit !== null ? 'on' : null;
    case 'rd_rsp_ready': return c.rdStall ? 'stall' : c.rdBeat !== null ? 'on' : null;
    case 'fifo_full': return c.fifoFull ? 'stall' : null;
    case 'fifo_pop': return c.pop !== null ? 'on' : null;
    case 'pk_ready': case 'wr_dat_ready': return c.wrStall ? 'stall' : c.emit !== null ? 'on' : null;
    case 'csr_bus': case 'start': return c.start ? 'on' : null;
    case 'rd_req': return c.rdReq ? 'on' : null;
    case 'wr_req': return c.wrReq ? 'on' : null;
    case 'src_cfg': case 'dst_cfg': return c.load ? 'on' : null;
    case 'rd_burst': return c.rdStart ? 'on' : null;
    case 'wr_burst': return c.wrStart ? 'on' : null;
    case 'status': return c.doneSet || c.errSet ? 'on' : null;
    case 'irq': return c.irq ? 'on' : null;
    case 'c_rdag': return c.load || c.rdStart ? 'on' : null;
    case 'c_rdp': return c.rdStart || c.rdDone ? (c.rdErr ? 'stall' : 'on') : null;
    case 'almost_full': return c.almostFull ? 'stall' : c.rdBeat !== null ? 'on' : null;
    case 'c_pack': return c.load ? 'on' : c.drain ? 'stall' : null;
    case 'c_wrp': return c.wrStart || c.wrDone ? 'on' : null;
    case 'c_wrag': return c.load || c.wrStart ? 'on' : null;
    default: return null;
  }
}

const COLOR = { data: 'var(--chart-1)', addr: 'var(--chart-4)', ctl: 'var(--chart-2)', stall: 'var(--chart-5)' };

/** Lines (1-based, relative to the anchor) of each `u_name (` instance up to its `);`. */
function instances(text: string | undefined): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {};
  if (!text) return out;
  const lines = text.split('\n');
  lines.forEach((l, i) => {
    const m = /\b(u_\w+)\s*\(/.exec(l);
    if (!m) return;
    let end = i;
    while (end < lines.length - 1 && !/^\s*\);/.test(lines[end]!)) end++;
    out[m[1]!] = [i + 1, end + 1];
  });
  return out;
}

/** Lines of each case item (`STATE:` up to the next item) in the FSM's case statement. */
function caseItems(text: string | undefined): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {};
  if (!text) return out;
  const lines = text.split('\n');
  const starts: [string, number][] = [];
  lines.forEach((l, i) => {
    const m = /^\s*([A-Z][A-Z_]*)\s*:/.exec(l);
    if (m) starts.push([m[1]!, i]);
  });
  starts.forEach(([s, i], k) => {
    const next = starts[k + 1]?.[1] ?? lines.length - 1;
    out[s] = [i + 1, Math.max(i + 1, next)];
  });
  return out;
}

const lineOf = (text: string | undefined, re: RegExp): number | null => {
  const i = text ? text.split('\n').findIndex((l) => re.test(l)) : -1;
  return i >= 0 ? i + 1 : null;
};

export default function SystemSim({ focus: focusProp, scenario: scenarioProp = 'smooth', autoplay = false }: { focus?: Focus; scenario?: Scenario; autoplay?: boolean }) {
  const [scenario, setScenario] = useWidgetState<Scenario>('scenario', scenarioProp);
  const [cycle, setCycle] = useWidgetState('cycle', 0);
  const [playing, setPlaying] = useWidgetState('playing', autoplay);
  const [speed, setSpeed] = useWidgetState('speed', '6');
  const [follow, setFollow] = useWidgetState('follow', true);
  const reduced = useReducedMotion();
  const visible = useVisible();
  const active = useIsMyStepActive();
  const mine = useMyAnchor();
  const stepFocus = useStepValue<Focus>({ control: 'control', datapath: 'data', backpressure: 'backpressure', errors: 'errors' }, 'all');
  const focus: Focus = focusProp ?? (follow ? stepFocus : 'all');

  const trace = useMemo(() => simulate({ ...TRANSFER, scenario }), [scenario]);
  const n = Math.min(cycle, trace.length - 1);
  const c = trace[n]!;
  const last = n >= trace.length - 1;

  // ---- the code each section is about, to highlight what's "running"
  const fsm = useAnchorCode('fsm');
  const control = useAnchorCode('control');
  const datapath = useAnchorCode('datapath');
  const bp = useAnchorCode('backpressure');
  const errs = useAnchorCode('errors');
  const fsmItems = useMemo(() => caseItems(fsm?.status === 'ok' ? fsm.text : undefined), [fsm]);
  const ctlInst = useMemo(() => instances(control?.status === 'ok' ? control.text : undefined), [control]);
  const dpInst = useMemo(() => instances(datapath?.status === 'ok' ? datapath.text : undefined), [datapath]);
  const bpText = bp?.status === 'ok' ? bp.text : undefined;
  const errText = errs?.status === 'ok' ? errs.text : undefined;

  const target = useMemo((): number | [number, number] | null => {
    switch (mine) {
      case 'fsm': return fsmItems[c.state] ?? null;
      case 'control': {
        const u = c.rdStart ? 'u_rd_agen' : c.wrStart ? 'u_wr_agen' : c.start || c.doneSet || c.errSet ? 'u_csr' : 'u_ctrl';
        return ctlInst[u] ?? null;
      }
      case 'datapath': {
        const u = c.emit !== null ? 'u_wr_port' : c.pop !== null ? 'u_packer' : c.rdBeat !== null ? 'u_rd_port' : c.fifo.length ? 'u_fifo' : null;
        return u ? dpInst[u] ?? null : null;
      }
      case 'backpressure':
        return c.fifoFull ? lineOf(bpText, /assign\s+full/) : c.almostFull ? lineOf(bpText, /almost_full/) : null;
      case 'errors':
        return c.errSet ? lineOf(errText, /if \(err_set\)/) : c.doneSet ? lineOf(errText, /if \(done_set\)/) : c.start ? lineOf(errText, /if \(start\)/) : null;
      default: return null;
    }
  }, [mine, c, fsmItems, ctlInst, dpInst, bpText, errText]);

  const key = Array.isArray(target) ? target.join('-') : String(target);
  useEffect(() => {
    if (!active) return;
    if (target === null) highlight();
    else highlight(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, key]);

  // ---- play
  useEffect(() => {
    if (!playing || !visible || last) return;
    const id = setInterval(() => setCycle((v) => Math.min(v + 1, trace.length - 1)), 1000 / Number(speed));
    return () => clearInterval(id);
  }, [playing, visible, last, speed, trace.length, setCycle]);
  useEffect(() => {
    if (playing && last) setPlaying(false);
  }, [playing, last, setPlaying]);

  const bright = (w: Wire) => focus === 'all' || FOCUS[focus](w);
  const brightBlock = (id: string) => focus === 'all' || FOCUS_BLOCKS[focus].includes(id);
  const dur = 0.85 / Number(speed);
  const [vx, vy, vw, vh] = L.viewBox as [number, number, number, number];

  return (
    <div className="flex flex-col gap-2 p-2" data-testid="system-sim">
      <svg viewBox={`${vx} ${vy} ${vw} ${vh - 40}`} className="h-auto w-full font-mono" role="img"
        aria-label={`Cycle ${n}: dma_ctrl is in ${c.state}; FIFO holds ${c.fifo.length} of ${FIFO_DEPTH} beats${c.almostFull ? ', almost full' : ''}.`}>
        {L.wires.map((w) => {
          const s = wireState(w.id, c);
          const base = COLOR[w.kind];
          const color = s === 'stall' ? COLOR.stall : base;
          const width = w.kind === 'data' ? 5 : w.kind === 'addr' ? 2.5 : s ? 2.5 : 1.5;
          const d = 'M' + w.pts.map((p) => p.join(',')).join(' L');
          const [a, b] = [w.pts[w.pts.length - 2]!, w.pts[w.pts.length - 1]!];
          const ang = Math.atan2(b[1]! - a[1]!, b[0]! - a[0]!);
          const hs = w.kind === 'data' ? 5.5 : 4.5;
          const head = (p: number[], q: number[], t: number) =>
            `${q[0]},${q[1]} ${q[0]! - hs * 1.6 * Math.cos(t) - hs * Math.sin(t)},${q[1]! - hs * 1.6 * Math.sin(t) + hs * Math.cos(t)} ${q[0]! - hs * 1.6 * Math.cos(t) + hs * Math.sin(t)},${q[1]! - hs * 1.6 * Math.sin(t) - hs * Math.cos(t)}`;
          const ang0 = Math.atan2(w.pts[0]![1]! - w.pts[1]![1]!, w.pts[0]![0]! - w.pts[1]![0]!);
          return (
            <g key={w.id} opacity={bright(w) ? (s || w.kind === 'data' ? 1 : 0.55) : 0.12}>
              <path d={d} fill="none" stroke={color} strokeWidth={width} strokeDasharray={w.kind === 'ctl' && !s ? '5 4' : undefined} strokeLinejoin="round" />
              <polygon points={head(a, b, ang)} fill={color} />
              {w.both && <polygon points={head(w.pts[1]!, w.pts[0]!, ang0)} fill={color} />}
              {w.label && w.at && w.label.split('|').map((t, i) => (
                <text key={i} x={w.at![0]} y={w.at![1]! + i * 12} textAnchor={w.anchor as 'start' | 'middle' | 'end'} fontSize={10.5}
                  fill={s ? color : 'var(--muted-foreground)'} fontWeight={s ? 700 : 400}>{t}{s === 'stall' && i === 0 ? ' ⚠' : ''}</text>
              ))}
            </g>
          );
        })}
        {/* beats in flight on the data wires */}
        {L.wires.filter((w) => w.kind === 'data' && wireState(w.id, c) === 'on' && bright(w)).map((w) => {
          const [p, q] = [w.pts[0]!, w.pts[w.pts.length - 1]!];
          const beat = w.id === 'rd_rsp_data' || w.id === 'fifo_wdata' ? c.rdBeat : w.id === 'fifo_rdata' ? c.pop : c.emit;
          const mid = (p[0]! + q[0]!) / 2;
          return (
            <motion.g key={`${w.id}-${n}`} initial={{ x: reduced ? mid : p[0]! + 6 }} animate={{ x: reduced ? mid : q[0]! - 22 }} transition={{ duration: reduced ? 0 : dur, ease: 'linear' }}>
              <rect x={-2} y={p[1]! - 9} width={22} height={18} rx={4} fill="var(--background)" stroke={COLOR.data} strokeWidth={1.5} />
              <text x={9} y={p[1]! + 4} textAnchor="middle" fontSize={10} fill="var(--foreground)">{beat}</text>
            </motion.g>
          );
        })}
        {L.blocks.map((b) => {
          const clickable = !!b.ref;
          const accent = b.kind === 'data' ? COLOR.data : b.kind === 'ctl' ? COLOR.ctl : b.kind === 'addr' ? COLOR.addr : 'var(--border)';
          const cx = b.x + b.w / 2;
          return (
            <g key={b.id} opacity={brightBlock(b.id) ? 1 : 0.35}
              {...(clickable ? {
                role: 'button', tabIndex: 0, 'aria-label': `${b.title} (${b.sub}): show its code`, className: 'cursor-pointer outline-none [&:focus-visible>rect:first-child]:stroke-ring',
                onClick: () => void reveal(b.ref!),
                onKeyDown: (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void reveal(b.ref!); } },
              } : {})}>
              <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={6} fill="var(--card)" stroke={b.kind === 'ext' ? 'var(--muted-foreground)' : 'var(--border)'}
                strokeDasharray={b.kind === 'ext' ? '3 3' : undefined} strokeWidth={1.2} className={clickable ? 'hover:stroke-ring' : undefined} />
              {b.kind !== 'ext' && <rect x={b.x} y={b.y} width={b.w} height={5} rx={2} fill={accent} />}
              <text x={cx} y={b.y + 24} textAnchor="middle" fontSize={13} fontWeight={600} fill="var(--foreground)">{b.title}</text>
              <text x={cx} y={b.y + 40} textAnchor="middle" fontSize={11} fill="var(--muted-foreground)">{b.sub}</text>
              <BlockBody b={b} c={c} />
            </g>
          );
        })}
      </svg>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" aria-label="Back one cycle" disabled={n === 0} onClick={() => { setPlaying(false); setCycle(Math.max(0, n - 1)); }}><StepBack /></Button>
        <Button size="sm" aria-label={playing ? 'Pause' : 'Play'} data-testid="play" onClick={() => { if (last) setCycle(0); setPlaying(!playing); }}>
          {playing ? <Pause /> : <Play />}{playing ? 'Pause' : 'Play'}
        </Button>
        <Button size="sm" variant="outline" aria-label="Next cycle" data-testid="step" disabled={last} onClick={() => { setPlaying(false); setCycle(n + 1); }}><StepForward /></Button>
        <Button size="sm" variant="ghost" aria-label="Reset" onClick={() => { setPlaying(false); setCycle(0); }}><RotateCcw /></Button>
        <Slider className="min-w-[120px] flex-1" aria-label="Cycle" min={0} max={trace.length - 1} step={1} value={[n]} onValueChange={(v) => { setPlaying(false); setCycle(v[0] ?? 0); }} />
        <span className="text-sm tabular-nums text-muted-foreground" aria-live="polite" data-testid="cycle">cycle {n} / {trace.length - 1}</span>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <Label htmlFor="scenario" className="text-sm">Bus</Label>
          <Select value={scenario} onValueChange={(v) => { setScenario(v as Scenario); setCycle(0); setPlaying(false); }}>
            <SelectTrigger id="scenario" className="w-64" data-testid="scenario"><SelectValue /></SelectTrigger>
            <SelectContent>{SCENARIOS.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="speed" className="text-sm">Speed</Label>
          <Select value={speed} onValueChange={setSpeed}>
            <SelectTrigger id="speed" className="w-28"><SelectValue /></SelectTrigger>
            <SelectContent>{['2', '4', '6', '8'].map((s) => <SelectItem key={s} value={s}>{s} cycles/s</SelectItem>)}</SelectContent>
          </Select>
        </div>
        {focusProp === undefined && (
          <div className="flex items-center gap-2">
            <Switch id="follow" checked={follow} onCheckedChange={setFollow} />
            <Label htmlFor="follow" className="text-sm">Emphasize the current step's path</Label>
          </div>
        )}
      </div>
      <Waves trace={trace} n={n} />
      <p className="text-xs text-muted-foreground">
        Copying {TRANSFER.len} bytes from {hex(TRANSFER.src)} to {hex(TRANSFER.dst)}: the source's first read burst stops at the 4 KB boundary, and the
        bytes shift by {((TRANSFER.dst & 7) - (TRANSFER.src & 7) + 8) % 8} lanes. Click a block to see its code.
      </p>
    </div>
  );
}

/** Live values inside each block. */
function BlockBody({ b, c }: { b: Block; c: Cycle }) {
  const cx = b.x + b.w / 2;
  const t = (y: number, s: string, strong = false, fill = 'var(--muted-foreground)') => (
    <text x={cx} y={b.y + y} textAnchor="middle" fontSize={strong ? 14 : 10.5} fontWeight={strong ? 700 : 400} fill={fill}>{s}</text>
  );
  switch (b.id) {
    case 'ctrl': {
      const fill = c.state === 'ERROR' ? 'var(--chart-5)' : c.state === 'DONE' ? 'var(--chart-3)' : 'var(--chart-2)';
      return (
        <>
          <rect x={b.x + 20} y={b.y + 52} width={b.w - 40} height={30} rx={15} fill="none" stroke={fill} strokeWidth={2} />
          {t(72, c.state, true, 'var(--foreground)')}
          {t(102, `credit_ok ${c.creditOk ? 1 : 0} · in ${c.inRcvd} · out ${c.outIssued}`)}
          {t(118, c.drain ? 'drain' : c.wrBusy ? 'write burst in flight' : '')}
        </>
      );
    }
    case 'fifo': {
      const w = b.w - 24, x = b.x + 12, y = b.y + 84;
      const af = x + (w * AF_LEVEL) / FIFO_DEPTH;
      return (
        <>
          <rect x={x} y={y} width={w} height={16} rx={3} fill="none" stroke="var(--border)" />
          <rect x={x} y={y} width={(w * c.fifo.length) / FIFO_DEPTH} height={16} rx={3} fill={c.almostFull ? 'var(--chart-5)' : 'var(--chart-1)'} opacity={0.75} />
          <line x1={af} x2={af} y1={y - 4} y2={y + 20} stroke="var(--foreground)" strokeDasharray="2 2" />
          {t(62, `${c.fifo.length} / ${FIFO_DEPTH}`, true, 'var(--foreground)')}
          {t(116, c.almostFull ? 'almost_full' : `AF above ${AF_LEVEL}`, false, c.almostFull ? 'var(--chart-5)' : 'var(--muted-foreground)')}
        </>
      );
    }
    case 'rdag':
      return <>{t(58, `addr ${hex(c.rdAddr)} · left ${c.rdLeft}`)}{t(72, c.rdLeft ? `next burst ${c.rdBurst}${c.rdBurst < 16 && c.rdLeft > c.rdBurst ? ' (4 KB)' : ''}` : 'done')}</>;
    case 'wrag':
      return <>{t(58, `addr ${hex(c.wrAddr)} · left ${c.wrLeft}`)}{t(72, c.wrLeft ? `next burst ${c.wrBurst}${c.wrBurst < 16 && c.wrLeft > c.wrBurst ? ' (4 KB)' : ''}` : 'done')}</>;
    case 'rdp':
      return <>{t(66, c.rdPortLeft ? `${c.rdPortLeft} beats to come` : 'idle', true, 'var(--foreground)')}{t(86, c.rdStall ? 'FIFO full: stalled' : c.rdBeat !== null ? `beat ${c.rdBeat} → FIFO` : '')}</>;
    case 'pack':
      return <>{t(66, c.prime ? 'priming' : c.drain ? 'draining' : c.emit !== null ? `out beat ${c.emit}` : 'waiting', true, 'var(--foreground)')}{t(86, `shift ${((TRANSFER.dst & 7) - (TRANSFER.src & 7) + 8) % 8} lanes`)}</>;
    case 'wrp':
      return <>{t(66, c.wrPortLeft ? `${c.wrPortLeft} beats to send` : c.wrBusy ? 'awaiting response' : 'idle', true, 'var(--foreground)')}{t(86, c.wrStall ? 'bus not ready: stalled' : c.wrDone ? 'response' : '')}</>;
    case 'csr':
      return <>{t(62, `STATUS busy ${c.state !== 'IDLE' ? 1 : 0} done ${c.done ? 1 : 0} err ${c.err ? 1 : 0}`)}{t(80, c.irq ? 'irq raised' : 'SRC · DST · LEN', c.irq, c.irq ? 'var(--chart-2)' : 'var(--muted-foreground)')}</>;
    default:
      return <>{b.lines.map((l, i) => <text key={i} x={cx} y={b.y + 58 + i * 13} textAnchor="middle" fontSize={10.5} fill="var(--muted-foreground)">{l}</text>)}</>;
  }
}

/** A small waveform of the last 48 cycles. */
function Waves({ trace, n }: { trace: Cycle[]; n: number }) {
  const span = 48;
  const from = Math.max(0, n - span + 1);
  const cs = trace.slice(from, n + 1);
  const x0 = 92, cw = (600 - x0) / span, rh = 18;
  const rows: { name: string; v: (c: Cycle) => boolean; color: string }[] = [
    { name: 'rd beat', v: (c) => c.rdBeat !== null, color: 'var(--chart-1)' },
    { name: 'almost_full', v: (c) => c.almostFull, color: 'var(--chart-5)' },
    { name: 'wr beat', v: (c) => c.emit !== null, color: 'var(--chart-1)' },
    { name: 'wr stall', v: (c) => c.wrStall, color: 'var(--chart-5)' },
  ];
  // state bus segments
  const segs: { s: string; a: number; b: number }[] = [];
  cs.forEach((c, i) => {
    const last = segs[segs.length - 1];
    if (last && last.s === c.state) last.b = i + 1;
    else segs.push({ s: c.state, a: i, b: i + 1 });
  });
  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 600 ${rh * 6 + 6}`} className="h-auto w-full min-w-[480px] font-mono" role="img"
        aria-label={`Waveform of cycles ${from} to ${n}: FSM state, read beats, almost_full, write beats and write stalls.`}>
        <text x={4} y={rh - 5} fontSize={10} fill="var(--muted-foreground)">state</text>
        {segs.map((g, i) => (
          <g key={i}>
            <path d={`M${x0 + g.a * cw + 2},${rh / 2 + 2} L${x0 + g.a * cw + 5},4 L${x0 + g.b * cw - 3},4 L${x0 + g.b * cw},${rh / 2 + 2} L${x0 + g.b * cw - 3},${rh} L${x0 + g.a * cw + 5},${rh} Z`}
              fill="none" stroke={g.s === 'ERROR' ? 'var(--chart-5)' : 'var(--chart-2)'} />
            {(g.b - g.a) * cw > 40 && <text x={x0 + ((g.a + g.b) / 2) * cw} y={rh - 5} textAnchor="middle" fontSize={8.5} fill="var(--foreground)">{g.s}</text>}
          </g>
        ))}
        {rows.map((r, k) => {
          const y = rh * (k + 1) + 4;
          let d = '';
          cs.forEach((c, i) => {
            const yy = r.v(c) ? y + 3 : y + rh - 3;
            d += `${i === 0 ? 'M' : 'L'}${x0 + i * cw},${yy} L${x0 + (i + 1) * cw},${yy} `;
          });
          return (
            <g key={r.name}>
              <text x={4} y={y + rh - 5} fontSize={10} fill="var(--muted-foreground)">{r.name}</text>
              <path d={d} fill="none" stroke={r.color} strokeWidth={1.5} />
            </g>
          );
        })}
        <g>
          <text x={4} y={rh * 5 + 4 + rh - 5} fontSize={10} fill="var(--muted-foreground)">FIFO level</text>
          <path d={cs.map((c, i) => `${i === 0 ? 'M' : 'L'}${x0 + i * cw},${rh * 6 + 1 - (c.fifo.length / FIFO_DEPTH) * (rh - 2)} L${x0 + (i + 1) * cw},${rh * 6 + 1 - (c.fifo.length / FIFO_DEPTH) * (rh - 2)}`).join(' ')}
            fill="none" stroke="var(--chart-1)" strokeWidth={1.5} />
        </g>
        <line x1={x0 + cs.length * cw} x2={x0 + cs.length * cw} y1={0} y2={rh * 6 + 6} stroke="var(--foreground)" strokeDasharray="2 2" />
      </svg>
    </div>
  );
}

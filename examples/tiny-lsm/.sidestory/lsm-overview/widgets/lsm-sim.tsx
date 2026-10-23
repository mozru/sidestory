// The whole store, one step at a time: the overview's block diagram (same geometry as the static SVG, from
// layout.json) driven by a model of the Python code (model.ts). Entries move along the write path, lookups
// probe the levels, tables appear and merge, and the editor highlights the line of Python each step runs
// (lines.json, generated from the code by tools/diagrams.py).
import { type KeyboardEvent, useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { Pause, Play, RotateCcw, StepBack, StepForward } from 'lucide-react';
import { highlight, reveal, useIsMyStepActive, useMyAnchor, useReducedMotion, useVisible, useWidgetState } from 'explainer';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import layout from './layout.json';
import lines from './lines.json';
import { type Frame, type Line, levelBytes, levelLimit, num, type Op, opText, OPTS, SCENARIOS, simulate, type Table } from './model';

type Focus = 'all' | 'write' | 'read' | 'scan' | 'ctl';
type Wire = { id: string; kind: 'write' | 'read' | 'ctl' | 'rec'; pts: number[][]; label: string; at: number[] | null; anchor: string; both: boolean; head: boolean; groups: string };
type Block = { id: string; x: number; y: number; w: number; h: number; title: string; sub: string; kind: string; ref: string | null; lines: string[]; groups: string };
const L = layout as unknown as { viewBox: number[]; blocks: Block[]; wires: Wire[]; tables: { x0: number; x1: number; top: number; bottom: number } };
const LINES = lines as unknown as Record<string, Partial<Record<Line, number | number[]>>>;

const COLOR = { write: 'var(--chart-1)', read: 'var(--chart-3)', ctl: 'var(--chart-2)', rec: 'var(--chart-5)' };

/** The line of Python each step runs, shown in the DB block. */
const CODE: Record<Line, [string, string]> = {
  'w-append': ['_write()', 'self._wal.append(key, value)'],
  'w-insert': ['_write()', 'self._mem.put(key, value)'],
  'w-check': ['_write()', 'if self._mem.size >= limit'],
  'f-write': ['flush()', 'write_table(…, self._mem.items())'],
  'f-commit': ['flush()', 'levels[0].insert(0, table); commit()'],
  'f-newlog': ['flush()', 'WriteAheadLog(new log path)'],
  'f-compact': ['flush()', 'compact_until_settled()'],
  'g-mem': ['get()', 'self._mem.get(key)'],
  'g-mem-hit': ['get()', 'return found'],
  'g-tables': ['get()', 'tables_for_key(key)'],
  'g-table': ['get()', 'table.get(key)'],
  'g-hit': ['get()', 'return found'],
  'g-none': ['get()', 'return None'],
  's-mem': ['scan()', 'self._mem.items(start, end)'],
  's-tables': ['scan()', 't.items(start, end) for t in …'],
  's-merge': ['scan()', 'live(merge(sources))'],
  'c-pick0': ['Compactor.pick()', 'len(levels[0]) >= l0_limit'],
  'c-pickn': ['Compactor.pick()', 'level_bytes(n) > level_limit(n)'],
  'c-merge': ['Compactor.run()', 'for key, value in merge(…)'],
  'c-commit': ['Compactor.run()', 'self.levels.commit()'],
};

const KEY = /^[a-z][a-z0-9]{0,9}$/;

function keyX(key: string) {
  const k = (key + 'aa').slice(0, 2);
  const t = (k.charCodeAt(0) - 97 + (k.charCodeAt(1) - 97) / 26) / 26;
  return L.tables.x0 + Math.max(0, Math.min(1, t)) * (L.tables.x1 - L.tables.x0);
}

export default function LsmSim({ scenario: scenarioProp = 'write', focus = 'all', start }: { scenario?: string; focus?: Focus; start?: Line }) {
  const preset = SCENARIOS[scenarioProp] ?? SCENARIOS.write!;
  const [scenario, setScenario] = useWidgetState('scenario', scenarioProp);
  const [extra, setExtra] = useWidgetState<Op[]>('extra', []);
  const base = SCENARIOS[scenario] ?? preset;
  const ops = useMemo(() => [...base.ops, ...extra], [base, extra]);
  const trace = useMemo(() => simulate(ops, base.from), [ops, base.from]);
  const startAt = useMemo(() => Math.max(0, start ? trace.findIndex((f) => f.line === start) : 0), [trace, start]);
  const [frame, setFrame] = useWidgetState('frame', startAt);
  const [playing, setPlaying] = useWidgetState('playing', false);
  const [speed, setSpeed] = useWidgetState('speed', '3');
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const reduced = useReducedMotion();
  const visible = useVisible();
  const active = useIsMyStepActive();
  const mine = useMyAnchor();

  const n = Math.min(frame, trace.length - 1);
  const f = trace[n]!;
  const last = n >= trace.length - 1;
  const op = ops[f.op];

  // ---- the editor follows the step: the line this step runs, if it's in this section's code
  const target = mine ? LINES[mine]?.[f.line] : undefined;
  const targetKey = Array.isArray(target) ? target.join('-') : String(target);
  useEffect(() => {
    if (!active) return;
    if (target === undefined) highlight();
    else highlight(target as number | [number, number]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, targetKey]);

  // ---- play
  useEffect(() => {
    if (!playing || !visible || last) return;
    const id = setInterval(() => setFrame((v) => Math.min(v + 1, trace.length - 1)), 1000 / Number(speed));
    return () => clearInterval(id);
  }, [playing, visible, last, speed, trace.length, setFrame]);
  useEffect(() => {
    if (playing && last) setPlaying(false);
  }, [playing, last, setPlaying]);

  const go = (i: number) => {
    setPlaying(false);
    setFrame(Math.max(0, Math.min(trace.length - 1, i)));
  };
  const opStarts = useMemo(() => trace.map((fr, i) => (i === 0 || trace[i - 1]!.op !== fr.op ? i : -1)).filter((i) => i >= 0), [trace]);
  const nextOp = opStarts.find((i) => i > n);
  const prevOp = [...opStarts].reverse().find((i) => i < n);

  const add = (o: Op) => {
    const nextExtra = [...extra, o];
    setExtra(nextExtra);
    // jump to the new op's first step: the trace grows by the new op's frames
    const nextTrace = simulate([...base.ops, ...nextExtra], base.from);
    const first = nextTrace.findIndex((fr) => fr.op === base.ops.length + nextExtra.length - 1);
    setPlaying(false);
    setFrame(first >= 0 ? first : nextTrace.length - 1);
  };
  const keyOk = KEY.test(key);
  const valueOk = /^[a-z0-9]{1,8}$/.test(value);

  const lit = new Set(f.lit);
  const inFocus = (w: { groups: string }) => focus === 'all' || w.groups.split(' ').includes(focus);
  const [vx, vy, vw, vh] = L.viewBox as [number, number, number, number];

  return (
    <div className="flex min-h-[640px] flex-col gap-2 p-2" data-testid="lsm-sim">
      <svg viewBox={`${vx} ${vy} ${vw} ${vh - 38}`} className="h-auto w-full font-mono" role="img"
        aria-label={`Step ${n + 1} of ${trace.length}, ${op ? opText(op) : ''}: ${f.msg}`}>
        {L.wires.map((w) => {
          const on = lit.has(w.id);
          const color = COLOR[w.kind];
          const width = w.kind === 'write' ? 5 : w.kind === 'read' ? (on ? 4 : 2.5) : on ? 2.5 : 1.5;
          const d = 'M' + w.pts.map((p) => p.join(',')).join(' L');
          const head = (p: number[], q: number[]) => {
            const t = Math.atan2(q[1]! - p[1]!, q[0]! - p[0]!);
            const hs = w.kind === 'write' ? 5.5 : 4.5;
            return `${q[0]},${q[1]} ${q[0]! - hs * 1.6 * Math.cos(t) - hs * Math.sin(t)},${q[1]! - hs * 1.6 * Math.sin(t) + hs * Math.cos(t)} ${q[0]! - hs * 1.6 * Math.cos(t) + hs * Math.sin(t)},${q[1]! - hs * 1.6 * Math.sin(t) - hs * Math.cos(t)}`;
          };
          const pts = w.pts;
          return (
            <g key={w.id} opacity={on ? 1 : inFocus(w) ? 0.45 : 0.12}>
              <path d={d} fill="none" stroke={color} strokeWidth={width} strokeLinejoin="round"
                strokeDasharray={w.kind === 'ctl' && !on ? '5 4' : w.kind === 'rec' ? '2 3' : undefined} />
              {w.head && <polygon points={head(pts[pts.length - 2]!, pts[pts.length - 1]!)} fill={color} />}
              {w.both && <polygon points={head(pts[1]!, pts[0]!)} fill={color} />}
              {w.label && w.at && w.label.split('|').map((t, i) => (
                <text key={i} x={w.at![0]} y={w.at![1]! + i * 12} textAnchor={w.anchor as 'start' | 'middle' | 'end'} fontSize={10.5}
                  fill={on ? color : 'var(--muted-foreground)'} fontWeight={on ? 700 : 400}>{t}</text>
              ))}
            </g>
          );
        })}
        <Moving f={f} op={op} reduced={reduced} speed={Number(speed)} />
        {L.blocks.map((b) => {
          const clickable = !!b.ref;
          const accent = b.kind === 'data' ? COLOR.write : b.kind === 'ctl' ? COLOR.ctl : null;
          const bright = focus === 'all' || b.groups.split(' ').includes(focus);
          return (
            <g key={b.id} opacity={bright ? 1 : 0.4}
              {...(clickable ? {
                role: 'button', tabIndex: 0, 'aria-label': `${b.title}: show its code`, className: 'cursor-pointer outline-none [&:focus-visible>rect:first-child]:stroke-ring',
                onClick: () => void reveal(b.ref!),
                onKeyDown: (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void reveal(b.ref!); } },
              } : {})}>
              <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={6} fill="var(--card)"
                stroke={b.kind === 'ext' ? 'var(--muted-foreground)' : b.kind === 'level' ? COLOR.write : 'var(--border)'}
                strokeDasharray={b.kind === 'ext' ? '3 3' : undefined} strokeWidth={1.2} className={clickable ? 'hover:stroke-ring' : undefined} />
              {accent && <rect x={b.x} y={b.y} width={b.w} height={5} rx={2} fill={accent} />}
              <BlockBody b={b} f={f} op={op} />
            </g>
          );
        })}
      </svg>

      <p className="min-h-[2.6em] text-sm" aria-live="polite" data-testid="sim-msg">
        <span className="mr-2 rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{op ? opText(op) : '—'}</span>
        {f.msg}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" aria-label="Previous step" disabled={n === 0} onClick={() => go(n - 1)}><StepBack /></Button>
        <Button size="sm" aria-label={playing ? 'Pause' : 'Play'} data-testid="play" onClick={() => { if (last) setFrame(0); setPlaying(!playing); }}>
          {playing ? <Pause /> : <Play />}{playing ? 'Pause' : 'Play'}
        </Button>
        <Button size="sm" variant="outline" aria-label="Next step" data-testid="step" disabled={last} onClick={() => go(n + 1)}><StepForward /></Button>
        <Button size="sm" variant="outline" disabled={prevOp === undefined} onClick={() => go(prevOp ?? 0)}>Previous op</Button>
        <Button size="sm" variant="outline" disabled={nextOp === undefined} onClick={() => go(nextOp ?? n)}>Next op</Button>
        <Button size="sm" variant="ghost" aria-label="Back to the start" onClick={() => go(0)}><RotateCcw /></Button>
        <Slider className="min-w-[120px] flex-1" aria-label="Step" min={0} max={trace.length - 1} step={1} value={[n]} onValueChange={(v) => go(v[0] ?? 0)} />
        <span className="text-sm tabular-nums text-muted-foreground" data-testid="sim-pos">step {n + 1} / {trace.length}</span>
      </div>

      <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
        <div className="grid gap-1">
          <Label htmlFor="sim-scenario" className="text-xs text-muted-foreground">Workload</Label>
          <Select value={scenario} onValueChange={(v) => { setScenario(v); setExtra([]); setPlaying(false); setFrame(0); }}>
            <SelectTrigger id="sim-scenario" className="w-72"><SelectValue /></SelectTrigger>
            <SelectContent>{Object.entries(SCENARIOS).map(([k, s]) => <SelectItem key={k} value={k}>{s.label}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="sim-speed" className="text-xs text-muted-foreground">Speed</Label>
          <Select value={speed} onValueChange={setSpeed}>
            <SelectTrigger id="sim-speed" className="w-32"><SelectValue /></SelectTrigger>
            <SelectContent>{['1', '2', '3', '5', '8'].map((s) => <SelectItem key={s} value={s}>{s} steps/s</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="sim-key" className="text-xs text-muted-foreground">Your own op: key, value</Label>
          <div className="flex flex-wrap items-center gap-1.5">
            <Input id="sim-key" className="h-8 w-24 font-mono" placeholder="key" value={key} aria-invalid={key !== '' && !keyOk}
              onChange={(e) => setKey(e.target.value.toLowerCase().trim())} />
            <Input className="h-8 w-20 font-mono" placeholder="value" aria-label="Value" value={value}
              onChange={(e) => setValue(e.target.value.toLowerCase().trim())} />
            <Button size="sm" variant="secondary" disabled={!keyOk || !valueOk} onClick={() => add({ kind: 'put', key, value })}>Put</Button>
            <Button size="sm" variant="secondary" disabled={!keyOk} onClick={() => add({ kind: 'get', key })}>Get</Button>
            <Button size="sm" variant="secondary" disabled={!keyOk} onClick={() => add({ kind: 'del', key })}>Delete</Button>
          </div>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        The same rules as the code, with small limits: flush at {OPTS.memtableBytes} bytes, compact L0 at {OPTS.l0Limit} tables, L1 holds {OPTS.levelBaseBytes} bytes and
        each level {OPTS.levelMultiplier}× more. Keys are lowercase words; tables sit on an a–z key axis. Click a block to see its code.
      </p>
    </div>
  );
}

/** An entry travelling along the wire this step uses. */
function Moving({ f, op, reduced, speed }: { f: Frame; op: Op | undefined; reduced: boolean; speed: number }) {
  const wire = { 'w-append': 'append', 'w-insert': 'insert', 'f-write': 'flush' }[f.line as string];
  const pts = L.wires.find((w) => w.id === wire)?.pts;
  // from just past the wire's start to just before its arrowhead
  const r = pts && [pts[0]![0]! + Math.sign(pts[1]![0]! - pts[0]![0]!) * 5, pts[0]![1]! + Math.sign(pts[1]![1]! - pts[0]![1]!) * 2,
    pts[1]![0]! - Math.sign(pts[1]![0]! - pts[0]![0]!) * 30, pts[1]![1]! - Math.sign(pts[1]![1]! - pts[0]![1]!) * 20];
  if (!r || !op || (op.kind !== 'put' && op.kind !== 'del')) return null;
  const text = f.line === 'f-write' ? `${f.mem.length} entries` : op.kind === 'del' ? `${op.key} ✝` : `${op.key}=${op.value}`;
  const w = Math.max(36, text.length * 6.6 + 10);
  return (
    <motion.g key={`${f.op}-${f.line}`} initial={{ x: reduced ? r[2] : r[0], y: reduced ? r[3] : r[1] }} animate={{ x: r[2], y: r[3] }}
      transition={{ duration: reduced ? 0 : 0.8 / speed, ease: 'easeOut' }}>
      <rect x={-w / 2} y={-9} width={w} height={18} rx={4} fill="var(--background)" stroke={COLOR.write} strokeWidth={1.5} />
      <text x={0} y={4} textAnchor="middle" fontSize={10.5} fill="var(--foreground)">{text}</text>
    </motion.g>
  );
}

function BlockBody({ b, f, op }: { b: Block; f: Frame; op: Op | undefined }) {
  const cx = b.x + b.w / 2;
  const t = (y: number, s: string, opts: { strong?: boolean; fill?: string; size?: number; x?: number; anchor?: 'start' | 'middle' | 'end' } = {}) => (
    <text x={opts.x ?? cx} y={b.y + y} textAnchor={opts.anchor ?? 'middle'} fontSize={opts.size ?? (opts.strong ? 13 : 10.5)} fontWeight={opts.strong ? 700 : 400}
      fill={opts.fill ?? 'var(--muted-foreground)'}>{s}</text>
  );
  const title = (s: string, sub: string) => <>{t(24, s, { strong: true, fill: 'var(--foreground)' })}{t(40, sub)}</>;
  switch (b.id) {
    case 'client':
      return (
        <>
          {title(b.title, b.sub)}
          {t(64, op ? opText(op) : '', { fill: 'var(--foreground)', size: 11 })}
          {f.result !== undefined && t(82, `→ ${f.result}`, { fill: COLOR.read, strong: true, size: 11 })}
        </>
      );
    case 'db': {
      const [fn, code] = CODE[f.line];
      return <>{title(b.title, b.sub)}{t(66, fn, { fill: 'var(--foreground)', strong: true, size: 12 })}{t(86, code, { size: 10 })}</>;
    }
    case 'wal': {
      const recs = f.wal.slice(-3);
      return (
        <>
          {title(b.title, `${num(f.log)}.log · ${f.wal.length} record${f.wal.length === 1 ? '' : 's'}`)}
          {recs.length === 0 && t(70, '(empty)')}
          {recs.map((e, i) => t(60 + i * 15, `${e.value === null ? 'DEL' : 'PUT'} ${e.key}${e.value === null ? '' : `=${e.value}`}`,
            { fill: i === recs.length - 1 && f.line === 'w-append' ? COLOR.write : 'var(--foreground)', strong: i === recs.length - 1 && f.line === 'w-append', size: 11 }))}
        </>
      );
    }
    case 'manifest':
      return (
        <>
          {title(b.title, `live log ${num(f.log)}`)}
          {f.levels.map((l, i) => t(62 + i * 16, `L${i}: ${l.length ? l.map((x) => x.num).join(' ') : '—'}`,
            { fill: f.line.endsWith('commit') ? COLOR.ctl : 'var(--foreground)', size: 11, x: b.x + 16, anchor: 'start' }))}
        </>
      );
    case 'mem': {
      const w = b.w - 30;
      const frac = Math.min(1, f.memSize / OPTS.memtableBytes);
      return (
        <>
          {title(b.title, `${f.mem.length} entries, sorted`)}
          {f.mem.slice(0, 4).map((e, i) => t(60 + i * 14, `${e.key}${e.value === null ? ' ✝' : `=${e.value}`}`, { fill: 'var(--foreground)', size: 11 }))}
          {f.mem.length > 4 && t(116, `+${f.mem.length - 4} more`)}
          <rect x={b.x + 15} y={b.y + 112} width={w} height={8} rx={3} fill="none" stroke="var(--border)" />
          <rect x={b.x + 15} y={b.y + 112} width={w * frac} height={8} rx={3} fill={frac >= 1 ? COLOR.ctl : COLOR.write} opacity={0.75} />
          {t(108, `${f.memSize} / ${OPTS.memtableBytes} B`, { size: 9.5, x: b.x + b.w - 15, anchor: 'end' })}
        </>
      );
    }
    case 'l0': case 'l1': case 'l2':
      return <Level b={b} f={f} n={Number(b.id[1])} />;
    case 'compaction': {
      const c = f.compaction;
      const rows = f.levels.slice(0, -1).map((l, i) => (i === 0 ? `L0 ${l.length}/${OPTS.l0Limit}` : `L${i} ${levelBytes(l)}/${levelLimit(i)}`));
      return (
        <>
          {title('compact', 'compaction.py')}
          {rows.map((r, i) => t(66 + i * 15, r, { fill: (i === 0 ? f.levels[0]!.length >= OPTS.l0Limit : levelBytes(f.levels[i]!) > levelLimit(i)) ? COLOR.ctl : 'var(--foreground)', size: 10.5 }))}
          {c ? (
            <>
              {t(130, `L${c.level} → L${c.level + 1}`, { strong: true, fill: COLOR.ctl })}
              {t(150, `${c.inputs.length + c.overlaps.length} in`)}
              {c.outputs.length > 0 && t(165, `${c.outputs.length} out`, { fill: COLOR.read })}
              {c.dropped.length > 0 && t(180, `✝ ${c.dropped.join(',')}`, { fill: COLOR.rec })}
              {c.dropped.length > 0 && t(194, 'dropped')}
            </>
          ) : t(130, 'idle')}
          {t(250, 'limits:', { size: 9.5 })}
          {t(264, `L0: ${OPTS.l0Limit} tables`, { size: 9.5 })}
          {t(278, `L1: ${levelLimit(1)} B`, { size: 9.5 })}
          {t(292, `then ×${OPTS.levelMultiplier}`, { size: 9.5 })}
        </>
      );
    }
    case 'merge': {
      const heap = f.heap ?? [];
      return (
        <>
          {title(b.title, b.sub)}
          {heap.length === 0 && !f.out && t(66, 'idle: used by scans')}
          {heap.slice(0, 3).map((h, i) => t(60 + i * 14, `(${h.key}, ${h.rank})${h.value === null ? ' ✝' : ''}`, { fill: i === 0 ? COLOR.read : 'var(--foreground)', strong: i === 0, size: 11 }))}
          {f.out && t(104, `out: ${f.out.map((e) => e.key).join(' ') || '—'}`, { size: 10 })}
        </>
      );
    }
    default:
      return <>{title(b.title, b.sub)}{b.lines.map((l, i) => t(60 + i * 13, l))}</>;
  }
}

/** A level: its tables on the a..z key axis. L0's tables overlap, so each gets its own row. */
function Level({ b, f, n }: { b: Block; f: Frame; n: number }) {
  const tables = f.levels[n] ?? [];
  const rows = n === 0 ? Math.max(1, tables.length) : 1;
  const top = b.y + L.tables.top;
  const h = (L.tables.bottom - L.tables.top) / Math.max(rows, 1);
  const c = f.compaction;
  const probes = [...(f.probed ?? []), ...(f.probe ? [f.probe] : [])];
  const bytes = levelBytes(tables);
  const limit = n === 0 ? `${tables.length} / ${OPTS.l0Limit} tables` : n < OPTS.numLevels - 1 ? `${bytes} / ${levelLimit(n)} B` : `${bytes} B`;
  const over = n === 0 ? tables.length >= OPTS.l0Limit : n < OPTS.numLevels - 1 && bytes > levelLimit(n);
  return (
    <>
      <text x={b.x + 14} y={b.y + 30} fontSize={20} fontWeight={700} fill="var(--foreground)">{b.title}</text>
      <text x={b.x + 14} y={b.y + 50} fontSize={10.5} fill="var(--muted-foreground)">{n === 0 ? 'newest first' : 'sorted'}</text>
      <text x={b.x + 14} y={b.y + 64} fontSize={10.5} fill={over ? COLOR.ctl : 'var(--muted-foreground)'} fontWeight={over ? 700 : 400}>{limit}</text>
      {tables.map((tb: Table, i) => {
        const row = n === 0 ? i : 0;
        const next = n > 0 ? tables[i + 1] : undefined;
        const x0 = keyX(tb.min);
        let x1 = Math.max(keyX(tb.max) + 10, x0 + 6.1 * (tb.min.length + tb.max.length + 1) + 10);
        if (next) x1 = Math.min(x1, keyX(next.min) - 3);
        const y = top + row * h;
        const probe = probes.find((p) => p.num === tb.num);
        const current = f.probe?.num === tb.num;
        const isIn = c && (c.inputs.includes(tb.num) || c.overlaps.includes(tb.num)) && f.line !== 'c-commit';
        const isOut = c && c.outputs.includes(tb.num);
        const stroke = current ? COLOR.read : isIn ? COLOR.ctl : isOut ? COLOR.read : COLOR.write;
        const tomb = tb.entries.some((e) => e.value === null);
        const badge = probe ? { range: 'out of range', bloom: 'bloom: no', miss: 'bloom: maybe ✗', hit: 'found', tombstone: 'tombstone' }[probe.result] : null;
        return (
          <g key={tb.num} opacity={probe && !current ? 0.55 : 1}>
            <title>{`${num(tb.num)}.sst: ${tb.min}…${tb.max}, ${tb.entries.length} entries, ${tb.size} bytes`}</title>
            <rect x={x0} y={y + 2} width={Math.max(14, x1 - x0)} height={h - 4} rx={3} fill={stroke} fillOpacity={current || isIn || isOut ? 0.3 : 0.15}
              stroke={stroke} strokeWidth={current || isIn || isOut ? 2.5 : 1} strokeDasharray={isIn ? '5 3' : undefined} />
            <text x={(x0 + x1) / 2} y={y + h / 2 + 3.5} textAnchor="middle" fontSize={rows > 3 ? 9 : 10} fill="var(--foreground)">
              {x1 - x0 >= (tb.min.length + tb.max.length + 1) * 6.1 + 6 ? `${tb.min}…${tb.max}` : `#${tb.num}`}{tomb ? ' ✝' : ''}
            </text>
            {badge && (
              <text x={x1 + 4} y={y + h / 2 + 3.5} fontSize={10} fontWeight={current ? 700 : 400}
                fill={probe!.result === 'hit' || probe!.result === 'tombstone' ? COLOR.read : probe!.result === 'miss' ? COLOR.rec : 'var(--muted-foreground)'}>{badge}</text>
            )}
          </g>
        );
      })}
    </>
  );
}

// Levels as rows of tables on an a..z key axis, driven by the same model of the Python code as the overview's
// simulation (model.ts, a copy). Write batches of keys and step through what follows: each flush adds an L0
// table; compaction outlines its inputs, merges them, and swaps in the outputs. Every entry is a tick at its
// key; tombstones are red crosses, and you can watch them disappear once nothing deeper could hold their key.
import { useEffect, useMemo } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronLeft, ChevronRight, Pause, Play, RotateCcw } from 'lucide-react';
import { highlight, useIsMyStepActive, useReducedMotion, useVisible, useWidgetState } from 'explainer';
import { Button } from '@/components/ui/button';
import lines from './lines.json';
import { entryBytes, type Frame, levelBytes, levelLimit, num, type Op, OPTS, simulate, type Table } from './model';

const WORDS = ('apple apricot banana bean beet berry cherry chive corn cress date dill endive fennel fig garlic grape guava '
  + 'herb jicama kale kiwi leek lemon lime mango melon mint nut okra olive onion pea pear plum quince radish rice sage '
  + 'squash tomato turnip ugli vanilla walnut wasabi yam yuzu zucchini').split(' ');
const EVENTS = new Set(['f-commit', 'c-pick0', 'c-pickn', 'c-merge', 'c-commit']);
const LINES = (lines as Record<string, Record<string, number | number[]>>).live ?? {};
const MAX_BATCHES = 40;

/** A batch of writes, the same for everyone: seeded by its position. */
function batch(i: number, existing: Set<string>): Op[] {
  let s = (i + 1) * 2654435761;
  const rnd = () => ((s = Math.imul(s ^ (s >>> 15), 2246822507) ^ Math.imul(s ^ (s >>> 13), 3266489909)) >>> 0) / 4294967296;
  const ops: Op[] = [];
  const have = [...existing];
  for (let j = 0; j < 4; j++) {
    if (have.length > 6 && rnd() < 0.2) ops.push({ kind: 'del', key: have[Math.floor(rnd() * have.length)]! });
    else ops.push({ kind: 'put', key: WORDS[Math.floor(rnd() * WORDS.length)]!, value: String(i % 10) });
  }
  return ops;
}

function workload(batches: number): Op[] {
  const ops: Op[] = [];
  const keys = new Set<string>();
  for (let i = 0; i < batches; i++) {
    for (const op of batch(i, keys)) {
      ops.push(op);
      if (op.kind === 'put') keys.add(op.key);
      if (op.kind === 'del') keys.delete(op.key);
    }
  }
  return ops;
}

const W = 760, X0 = 80, X1 = 740, ROW = 30;
function keyX(key: string) {
  const k = (key + 'aa').slice(0, 2);
  const t = (k.charCodeAt(0) - 97 + (k.charCodeAt(1) - 97) / 26) / 26;
  return X0 + Math.max(0, Math.min(1, t)) * (X1 - X0);
}

export default function CompactionViz() {
  const [batches, setBatches] = useWidgetState('batches', 6);
  const [event, setEvent] = useWidgetState('event', 0);
  const [playing, setPlaying] = useWidgetState('playing', false);
  const reduced = useReducedMotion();
  const visible = useVisible();
  const active = useIsMyStepActive();

  const ops = useMemo(() => workload(batches), [batches]);
  const all = useMemo(() => simulate(ops), [ops]);
  const events = useMemo(() => all.flatMap((x, k) => (EVENTS.has(x.line) ? [k] : [])), [all]);
  const frames = events.map((k) => all[k]!);
  const i = Math.min(event, frames.length - 1);
  const f: Frame | undefined = frames[i];
  const last = i >= frames.length - 1;

  const more = () => {
    if (batches >= MAX_BATCHES) return false;
    const before = frames.length;
    setBatches(batches + 1);
    setEvent(before); // the first event of the new batch, if it has one
    return true;
  };
  const next = () => (last ? more() : setEvent(i + 1));

  useEffect(() => {
    if (!playing || !visible) return;
    const id = setTimeout(() => {
      if (last && batches >= MAX_BATCHES) setPlaying(false);
      else if (last) more();
      else setEvent(i + 1);
    }, reduced ? 1200 : 900);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, visible, i, last, batches, reduced]);

  const target = f ? LINES[f.line] : undefined;
  useEffect(() => {
    if (!active) return;
    if (target === undefined) highlight();
    else highlight(target as number | [number, number]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, f?.line]);

  // write amplification so far: bytes the store wrote to tables per byte flushed
  const written = useMemo(() => {
    let flushed = 0, compacted = 0;
    for (const x of all.slice(0, i >= 0 ? events[i]! + 1 : 0)) {
      if (x.line === 'f-commit') flushed += x.levels[0]![0]!.size;
      if (x.line === 'c-commit' && x.compaction) compacted += x.levels.flat().filter((t) => x.compaction!.outputs.includes(t.num)).reduce((s, t) => s + t.size, 0);
    }
    return { flushed, compacted };
  }, [all, events, i]);

  const c = f?.compaction;
  const phase = f?.line;
  const opsDone = f ? f.op + 1 : 0;
  const user = ops.slice(0, opsDone).reduce((s, o) => s + (o.kind === 'put' ? entryBytes({ key: o.key, value: o.value }) : o.kind === 'del' ? entryBytes({ key: o.key, value: null }) : 0), 0);

  let y = 18;
  const rows = (f?.levels ?? []).map((level, n) => {
    const r = n === 0 ? Math.max(1, level.length) : 1;
    const top = y;
    y += r * ROW + 14;
    return { level, n, top, r };
  });
  const height = Math.max(y + 20, 210);

  return (
    <div className="flex min-h-[560px] flex-col gap-2 p-2" data-testid="compaction-viz">
      <svg viewBox={`0 0 ${W} ${height}`} className="h-auto w-full font-mono" role="img"
        aria-label={f ? `${describe(f)} Levels: ${f.levels.map((l, n) => `L${n} has ${l.length} tables`).join(', ')}.` : 'No writes yet.'}>
        {rows.map(({ level, n, top, r }) => {
          const over = n === 0 ? level.length >= OPTS.l0Limit : n < OPTS.numLevels - 1 && levelBytes(level) > levelLimit(n);
          return (
            <g key={n}>
              <rect x={4} y={top - 4} width={W - 8} height={r * ROW + 8} rx={5} fill="none" stroke="var(--border)" />
              <text x={14} y={top + (r * ROW) / 2 + 2} fontSize={16} fontWeight={700} fill="var(--foreground)">L{n}</text>
              <text x={14} y={top + (r * ROW) / 2 + 16} fontSize={10.5} fill={over ? 'var(--chart-2)' : 'var(--muted-foreground)'}>
                {n === 0 ? `${level.length}/${OPTS.l0Limit}` : n < OPTS.numLevels - 1 ? `${levelBytes(level)}/${levelLimit(n)}B` : `${levelBytes(level)}B`}
              </text>
              <AnimatePresence initial={false}>
                {level.map((t, j) => (
                  <TableBox key={t.num} t={t} top={top + (n === 0 ? j : 0) * ROW} next={n > 0 ? level[j + 1] : undefined} reduced={reduced}
                    role={c && (c.inputs.includes(t.num) || c.overlaps.includes(t.num)) && phase !== 'c-commit' ? 'in' : c && c.outputs.includes(t.num) ? 'out' : f?.line === 'f-commit' && n === 0 && j === 0 ? 'new' : null} />
                ))}
              </AnimatePresence>
            </g>
          );
        })}
        {['a', 'e', 'i', 'm', 'q', 'u', 'y'].map((k) => (
          <text key={k} x={keyX(k)} y={height - 6} fontSize={10} textAnchor="middle" fill="var(--muted-foreground)">{k}</text>
        ))}
      </svg>
      <p className="min-h-[2.6em] text-sm" aria-live="polite" data-testid="compaction-msg">{f ? describe(f) : 'Write a batch to start.'}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" aria-label="Previous event" disabled={i <= 0} onClick={() => { setPlaying(false); setEvent(i - 1); }}><ChevronLeft /></Button>
        <Button size="sm" aria-label={playing ? 'Pause' : 'Play'} onClick={() => setPlaying(!playing)}>{playing ? <Pause /> : <Play />}{playing ? 'Pause' : 'Play'}</Button>
        <Button size="sm" variant="outline" aria-label="Next event" disabled={last && batches >= MAX_BATCHES} onClick={() => { setPlaying(false); next(); }}><ChevronRight /></Button>
        <Button size="sm" variant="secondary" disabled={batches >= MAX_BATCHES} onClick={() => { setPlaying(false); more(); }}>Write a batch</Button>
        <Button size="sm" variant="ghost" aria-label="Start over" onClick={() => { setPlaying(false); setBatches(6); setEvent(0); }}><RotateCcw /></Button>
        <span className="text-sm tabular-nums text-muted-foreground">event {frames.length ? i + 1 : 0} / {frames.length} · {opsDone} writes</span>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
        <div><div className="text-xs text-muted-foreground">written by you</div><strong className="tabular-nums">{user} B</strong></div>
        <div><div className="text-xs text-muted-foreground">flushed to L0</div><strong className="tabular-nums">{written.flushed} B</strong></div>
        <div><div className="text-xs text-muted-foreground">rewritten by compaction</div><strong className="tabular-nums">{written.compacted} B</strong></div>
        <div><div className="text-xs text-muted-foreground">table bytes per byte flushed</div><strong className="tabular-nums" data-testid="wa">{written.flushed ? ((written.flushed + written.compacted) / written.flushed).toFixed(1) : '—'}×</strong></div>
      </div>
      <p className="text-xs text-muted-foreground">
        Ticks are entries at their keys; a red <span className="text-chart-5">✕</span> is a tombstone. Dashed orange: a compaction's inputs; solid green: what it wrote (or the newest flush). A batch is four writes, about one memtable.
        Limits as in the simulation: L0 {OPTS.l0Limit} tables, L1 {levelLimit(1)} bytes, ×{OPTS.levelMultiplier} per level. Table sizes include index, bloom filter and footer.
      </p>
    </div>
  );
}

function describe(f: Frame): string {
  const c = f.compaction;
  switch (f.line) {
    case 'f-commit': return `Flush: the memtable became ${num(f.levels[0]![0]!.num)}.sst, the newest L0 table.`;
    case 'c-pick0': case 'c-pickn': return f.msg;
    case 'c-merge': return f.msg;
    case 'c-commit': return `Commit: ${c!.outputs.length} new table${c!.outputs.length === 1 ? '' : 's'} replace ${c!.inputs.length + c!.overlaps.length} in L${c!.level}–L${c!.level + 1}, in one manifest write.`;
    default: return f.msg;
  }
}

function TableBox({ t, top, next, role, reduced }: { t: Table; top: number; next: Table | undefined; role: 'in' | 'out' | 'new' | null; reduced: boolean }) {
  const x0 = keyX(t.min);
  let x1 = Math.max(keyX(t.max) + 8, x0 + 12);
  if (next) x1 = Math.max(x0 + 6, Math.min(x1, keyX(next.min) - 3));
  const stroke = role === 'in' ? 'var(--chart-2)' : role === 'out' || role === 'new' ? 'var(--chart-3)' : 'var(--chart-1)';
  return (
    <motion.g initial={reduced ? false : { opacity: 0, y: -14 }} animate={{ opacity: 1, y: 0 }} exit={reduced ? undefined : { opacity: 0, y: 14 }}
      transition={{ duration: reduced ? 0 : 0.45 }}>
      <title>{`${num(t.num)}.sst: ${t.min}…${t.max}, ${t.entries.length} entries, ${t.size} bytes`}</title>
      <rect x={x0} y={top + 2} width={x1 - x0} height={ROW - 6} rx={3} fill={stroke} fillOpacity={role ? 0.28 : 0.14} stroke={stroke} strokeWidth={role ? 2.5 : 1}
        strokeDasharray={role === 'in' ? '5 3' : undefined} />
      {t.entries.map((e) => {
        const x = keyX(e.key) + 4;
        return e.value === null
          ? <path key={e.key} d={`M${x - 3},${top + 8} l6,6 m0,-6 l-6,6`} stroke="var(--chart-5)" strokeWidth={1.8} />
          : <line key={e.key} x1={x} x2={x} y1={top + 7} y2={top + ROW - 7} stroke="var(--foreground)" strokeWidth={1} opacity={0.7} />;
      })}
    </motion.g>
  );
}

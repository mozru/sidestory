// dma_ctrl's state graph, parsed from the real case statement (the "fsm" anchor), so it can't drift from
// the RTL. Hover or pick a transition to highlight the line that takes it; pick a state to highlight its
// case item. The table lists every transition with its condition and the strobes each state drives.
import { type KeyboardEvent, useMemo } from 'react';
import { highlight, Ref, useAnchorCode, useIsMyStepActive, useWidgetState } from 'explainer';
import { Badge } from '@/components/ui/badge';

type Edge = { from: string; to: string; conds: string[]; line: number };
type Item = { state: string; first: number; last: number; strobes: string[] };

const POS: Record<string, [number, number]> = {
  IDLE: [90, 200], LOAD: [160, 70], READ_BURST: [360, 70], WAIT_DATA: [640, 70],
  WRITE_BURST: [640, 330], WAIT_WRITE: [360, 330], DONE: [200, 420], ERROR: [830, 200],
};
const BEND: Record<string, number> = { 'LOAD>ERROR': -260, 'ERROR>IDLE': -600, 'DONE>IDLE': -50, 'WRITE_BURST>DONE': 40 };
const W = 124, H = 34;
const STROBES = /\b(load|rd_start|wr_start|done_set|err_set|drain)\s*=\s*1'b1/g;

/** `!x` for a condition, without piling up parentheses. */
function neg(c: string): string {
  const t = c.trim();
  if (/^!\w+$/.test(t)) return t.slice(1);
  if (/^\w+$/.test(t)) return `!${t}`;
  if (/^!\((.*)\)$/.test(t) && balanced(t.slice(2, -1))) return t.slice(2, -1);
  return `!(${t})`;
}
function balanced(s: string): boolean {
  let d = 0;
  for (const ch of s) {
    if (ch === '(') d++;
    else if (ch === ')' && --d < 0) return false;
  }
  return d === 0;
}

/**
 * Reads transitions out of a SystemVerilog `unique case (state_q)` body: `state_d = X;` and
 * `state_d = c ? X : Y;`, under nested `if / else if / else` (with or without begin/end).
 */
export function parseFsm(text: string): { items: Item[]; edges: Edge[] } {
  const lines = text.split('\n');
  const items: Item[] = [];
  const raw: Edge[] = [];
  let cur: Item | null = null;
  // one frame per open `if ... begin`: the branches before this one, and this one's condition
  let stack: { prev: string[]; cur: string | null }[] = [];
  const branch = (f: { prev: string[]; cur: string | null }) => [...f.prev.map(neg), ...(f.cur ? [f.cur] : [])];
  lines.forEach((full, i) => {
    let l = full.replace(/\/\/.*$/, '');
    const label = /^\s*([A-Za-z_]\w*)\s*:(?!:)\s*(.*)$/.exec(l);
    if (label) {
      if (cur) cur.last = i;
      cur = label[1] === 'default' ? null : { state: label[1]!, first: i + 1, last: i + 1, strobes: [] };
      if (cur) items.push(cur);
      stack = [];
      l = label[2]!;
    }
    if (!cur) return;
    for (const m of l.matchAll(STROBES)) if (!cur.strobes.includes(m[1]!)) cur.strobes.push(m[1]!);
    let local: string | null = null; // a single-statement `if (c) stmt;`
    const elseIf = /\belse\s+if\s*\((.*)\)\s*begin\s*$/.exec(l);
    const elseBegin = /\belse\s+begin\s*$/.test(l);
    const ifBegin = /\bif\s*\((.*)\)\s*begin\s*$/.exec(l);
    const ifInline = /\bif\s*\((.*?)\)\s*(?!begin)\S/.exec(l);
    const top = stack[stack.length - 1];
    if (elseIf && top) {
      if (top.cur) top.prev.push(top.cur);
      top.cur = elseIf[1]!.trim();
    } else if (elseBegin && top) {
      if (top.cur) top.prev.push(top.cur);
      top.cur = null;
    } else if (ifBegin) {
      stack.push({ prev: [], cur: ifBegin[1]!.trim() });
    } else if (ifInline) {
      local = ifInline[1]!.trim();
    }
    const assign = /\bstate_d\s*=\s*([^;]+);/.exec(l);
    if (assign) {
      const conds = [...stack.flatMap(branch), ...(local ? [local] : [])];
      const rhs = assign[1]!.trim();
      const tern = /^(.+?)\s*\?\s*(\w+)\s*:\s*(\w+)$/.exec(rhs);
      if (tern) {
        raw.push({ from: cur.state, to: tern[2]!, conds: [...conds, tern[1]!.trim()], line: i + 1 });
        raw.push({ from: cur.state, to: tern[3]!, conds: [...conds, neg(tern[1]!)], line: i + 1 });
      } else if (/^\w+$/.test(rhs)) {
        raw.push({ from: cur.state, to: rhs, conds, line: i + 1 });
      }
    }
    if (/^\s*end\s*$/.test(l) && stack.length) stack.pop();
  });
  if (cur) (cur as Item).last = lines.length;
  return { items, edges: raw.filter((e) => e.from !== e.to) };
}

function geometry(a: [number, number], b: [number, number], bend: number) {
  const [x1, y1] = a, [x2, y2] = b;
  const L = Math.hypot(x2 - x1, y2 - y1) || 1;
  const nx = -(y2 - y1) / L, ny = (x2 - x1) / L;
  const cx = (x1 + x2) / 2 + nx * bend, cy = (y1 + y2) / 2 + ny * bend;
  const trim = (px: number, py: number, qx: number, qy: number, pad: number) => {
    const vx = qx - px, vy = qy - py;
    const t = Math.min(vx ? (W / 2 + pad) / Math.abs(vx) : 1e9, vy ? (H / 2 + pad) / Math.abs(vy) : 1e9);
    return [px + vx * t, py + vy * t] as const;
  };
  const [sx, sy] = trim(x1, y1, cx, cy, 2);
  const [ex, ey] = trim(x2, y2, cx, cy, 4);
  const ang = Math.atan2(ey - cy, ex - cx);
  const head = `${ex},${ey} ${ex - 7 * Math.cos(ang) - 4.5 * Math.sin(ang)},${ey - 7 * Math.sin(ang) + 4.5 * Math.cos(ang)} ${ex - 7 * Math.cos(ang) + 4.5 * Math.sin(ang)},${ey - 7 * Math.sin(ang) - 4.5 * Math.cos(ang)}`;
  return { d: `M${sx},${sy} Q${cx},${cy} ${ex},${ey}`, head, lx: (sx + 2 * cx + ex) / 4, ly: (sy + 2 * cy + ey) / 4 };
}

const short = (s: string, n = 34) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export default function FsmGraph() {
  const code = useAnchorCode('fsm');
  const active = useIsMyStepActive();
  const [sel, setSel] = useWidgetState<string | null>('sel', null);
  const [hover, setHover] = useWidgetState<string | null>('hover', null);
  const parsed = useMemo(() => (code?.status === 'ok' ? parseFsm(code.text) : null), [code]);

  if (code === null) return <p className="p-3 text-sm text-muted-foreground">Reading the state machine…</p>;
  if (!parsed || parsed.items.length === 0)
    return <p className="p-3 text-sm text-muted-foreground">The state graph is drawn from the case statement in dma_ctrl.sv; step to it in the editor.</p>;

  const { items, edges } = parsed;
  // Merge edges between the same two states (several branches can lead from A to B).
  const merged = new Map<string, Edge & { lines: number[]; alts: string[][] }>();
  for (const e of edges) {
    const k = `${e.from}>${e.to}`;
    const m = merged.get(k);
    if (m) { m.lines.push(e.line); m.alts.push(e.conds); } else merged.set(k, { ...e, lines: [e.line], alts: [e.conds] });
  }
  const list = [...merged.entries()];
  const pairs = new Set(list.map(([k]) => k));
  let extra = 0;
  const pos = (s: string): [number, number] => POS[s] ?? [120 + (extra++ % 6) * 130, 500];
  const statePos = Object.fromEntries(items.map((it) => [it.state, pos(it.state)]));
  // Two branches that differ only in `x` / `!x` reach the same state either way: drop x.
  const condText = (alts: string[][]) => {
    if (alts.length === 2) {
      const [a, b] = alts as [string[], string[]];
      const common = a.filter((c) => b.includes(c));
      const ra = a.filter((c) => !common.includes(c)), rb = b.filter((c) => !common.includes(c));
      if (ra.length === 1 && rb.length === 1 && neg(ra[0]!) === rb[0]) return common.join(' & ') || 'always';
    }
    return alts.map((a) => a.join(' & ') || 'always').join(' | ');
  };
  const focusKey = hover ?? sel;

  const pickEdge = (k: string, line: number) => {
    setSel(k);
    if (active) highlight(line, { identifiers: ['state_d'] });
  };
  const pickState = (it: Item) => {
    setSel(it.state);
    if (active) highlight([it.first, it.last]);
  };

  return (
    <div className="flex flex-col gap-3 p-2" data-testid="fsm-graph">
      <svg viewBox="0 -14 900 530" className="h-auto w-full font-mono" role="img"
        aria-label={`State graph with ${items.length} states and ${list.length} transitions, read from the case statement.`}
        onMouseLeave={() => setHover(null)}>
        {list.map(([k, e]) => {
          const a = statePos[e.from], b = statePos[e.to];
          if (!a || !b) return null;
          const g = geometry(a, b, BEND[k] ?? (pairs.has(`${e.to}>${e.from}`) ? 34 : 0));
          const on = focusKey === k || focusKey === e.from;
          const err = e.to === 'ERROR';
          const color = err ? 'var(--chart-5)' : 'var(--chart-2)';
          return (
            <g key={k} className="cursor-pointer" onMouseEnter={() => { setHover(k); if (active) highlight(e.lines[0]!, { identifiers: ['state_d'] }); }}
              onClick={() => pickEdge(k, e.lines[0]!)} opacity={focusKey && !on ? 0.3 : 1}>
              <path d={g.d} fill="none" stroke="transparent" strokeWidth={14} />
              <path d={g.d} fill="none" stroke={color} strokeWidth={on ? 3 : 1.6} strokeDasharray={err ? '3 3' : undefined} />
              <polygon points={g.head} fill={color} />
              <text x={g.lx} y={g.ly + 4} textAnchor="middle" fontSize={10.5} fill={on ? 'var(--foreground)' : 'var(--muted-foreground)'}
                stroke="var(--background)" strokeWidth={3} paintOrder="stroke" fontWeight={on ? 700 : 400}>{short(condText(e.alts))}</text>
            </g>
          );
        })}
        {items.map((it) => {
          const [x, y] = statePos[it.state]!;
          const on = focusKey === it.state;
          const end = it.state === 'DONE' || it.state === 'ERROR';
          return (
            <g key={it.state} role="button" tabIndex={0} aria-label={`${it.state}: highlight its case item`} className="cursor-pointer outline-none"
              onClick={() => pickState(it)} onKeyDown={(e: KeyboardEvent<SVGGElement>) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickState(it); } }}
              onMouseEnter={() => { setHover(it.state); if (active) highlight([it.first, it.last]); }}>
              <rect x={x - W / 2} y={y - H / 2} width={W} height={H} rx={17} fill="var(--card)"
                stroke={end ? 'var(--chart-3)' : 'var(--chart-2)'} strokeWidth={on ? 3.5 : it.state === 'IDLE' ? 3 : 1.5} />
              <text x={x} y={y + 4} textAnchor="middle" fontSize={12} fontWeight={600} fill="var(--foreground)">{it.state}</text>
              {it.strobes.length > 0 && (
                <text x={x} y={y + H / 2 + 13} textAnchor="middle" fontSize={10} fill="var(--chart-2)">{it.strobes.join(' · ')}</text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-left text-sm" onMouseLeave={() => { setHover(null); if (active) highlight(); }}>
          <caption className="sr-only">Transitions of dma_ctrl, parsed from the case statement</caption>
          <thead className="text-muted-foreground">
            <tr><th className="py-1 font-medium">From</th><th className="font-medium">To</th><th className="font-medium">When</th><th className="font-medium">Line</th></tr>
          </thead>
          <tbody>
            {edges.map((e, i) => {
              const k = `${e.from}>${e.to}`;
              return (
                <tr key={i} className={`border-t border-border hover:bg-accent ${focusKey === k ? 'bg-accent text-accent-foreground' : ''}`}
                  onMouseEnter={() => { setHover(k); if (active) highlight(e.line, { identifiers: ['state_d'] }); }}>
                  <td className="py-1 font-mono">{e.from}</td>
                  <td className="font-mono">{e.to === 'ERROR' ? <Badge variant="destructive">ERROR</Badge> : e.to}</td>
                  <td className="font-mono text-xs">{e.conds.join(' & ') || 'always'}</td>
                  <td><Ref anchor="fsm" lines={e.line}>{code.status === 'ok' ? code.startLine + e.line - 1 : e.line}</Ref></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        {items.length} states, {edges.length} transitions, read from the code just now: edit the case statement and the graph follows. Strobes under a state are driven while in it.
      </p>
    </div>
  );
}

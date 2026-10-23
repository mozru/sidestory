// How dma_addr_gen cuts a transfer into bursts: the same arithmetic as the RTL (total_beats, to_4k, and the
// minimum of three limits), drawn on an address line with the 4 KB boundaries. Hover a burst to highlight the
// line of code whose limit chose its length.
import { useMemo } from 'react';
import { highlight, useAnchorCode, useIsMyStepActive, useWidgetState } from 'explainer';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';

type Why = 'MAX_BURST' | '4 KB' | 'tail';
type Burst = { addr: number; beats: number; why: Why };

export function bursts(base: number, len: number, maxBurst: number): Burst[] {
  const total = ((base & 7) + len + 7) >> 3; // total_beats
  let addr = base & ~7;
  let left = total;
  const out: Burst[] = [];
  while (left > 0 && out.length < 400) {
    const to4k = 512 - ((addr >> 3) & 511); // to_4k
    let beats = maxBurst, why: Why = 'MAX_BURST';
    if (to4k < maxBurst && to4k < beats) { beats = to4k; why = '4 KB'; }
    if (left < maxBurst && left < beats) { beats = left; why = 'tail'; }
    out.push({ addr, beats, why });
    addr += beats * 8;
    left -= beats;
  }
  return out;
}

const hex = (v: number) => `0x${v.toString(16).padStart(4, '0')}`;
const WHY_COLOR: Record<Why, string> = { MAX_BURST: 'var(--chart-1)', '4 KB': 'var(--chart-5)', tail: 'var(--chart-3)' };

export default function Split4k({ base: base0 = 0x0fa5, len: len0 = 400 }: { base?: number; len?: number }) {
  const [base, setBase] = useWidgetState('base', base0);
  const [len, setLen] = useWidgetState('len', len0);
  const [maxBurst, setMaxBurst] = useWidgetState('max', '16');
  const [text, setText] = useWidgetState('text', hex(base0));
  const [hover, setHover] = useWidgetState<number | null>('hover', null);
  const active = useIsMyStepActive();
  const code = useAnchorCode('agen-limits');
  const list = useMemo(() => bursts(base, len, Number(maxBurst)), [base, len, maxBurst]);

  // The line in the limits anchor that picked each reason (relative to the anchor).
  const lineFor = (why: Why): number | null => {
    if (code?.status !== 'ok') return null;
    const re = why === 'MAX_BURST' ? /burst_len\s*=\s*BLW'\(MAX_BURST\)/ : why === '4 KB' ? /if\s*\(hit_4k/ : /if\s*\(tail/;
    const i = code.text.split('\n').findIndex((l) => re.test(l));
    return i >= 0 ? i + 1 : null;
  };
  const pick = (i: number | null) => {
    setHover(i);
    if (!active) return;
    const l = i === null ? null : lineFor(list[i]!.why);
    if (l) highlight(l, { identifiers: ['burst_len'] }); else highlight();
  };

  // the address line
  const lo = base & ~7;
  const hi = lo + list.reduce((t, b) => t + b.beats, 0) * 8;
  const span = Math.max(hi - lo, 8);
  const W = 640, x0 = 10, w = W - 20;
  const X = (a: number) => x0 + ((a - lo) / span) * w;
  const bounds: number[] = [];
  for (let b = (Math.floor(lo / 4096) + 1) * 4096; b < hi; b += 4096) bounds.push(b);

  return (
    <div className="flex flex-col gap-3 p-2" data-testid="split-4k">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="grid gap-1">
          <Label htmlFor="base">Base address (hex)</Label>
          <Input id="base" className="font-mono" value={text} onChange={(e) => {
            setText(e.target.value);
            const v = parseInt(e.target.value.replace(/^0x/i, ''), 16);
            if (Number.isFinite(v) && v >= 0 && v < 1 << 24) setBase(v);
          }} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="len">Length: {len} bytes</Label>
          <Slider id="len" aria-label="Length in bytes" min={1} max={4096} step={1} value={[len]} onValueChange={(v) => setLen(v[0] ?? 1)} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="maxb">MAX_BURST</Label>
          <Select value={maxBurst} onValueChange={setMaxBurst}>
            <SelectTrigger id="maxb" className="w-32"><SelectValue /></SelectTrigger>
            <SelectContent>{['4', '8', '16', '32'].map((m) => <SelectItem key={m} value={m}>{m} beats</SelectItem>)}</SelectContent>
          </Select>
        </div>
      </div>
      <svg viewBox={`0 0 ${W} 92`} className="h-auto w-full font-mono" role="img" onMouseLeave={() => pick(null)}
        aria-label={`${list.length} bursts from ${hex(lo)} to ${hex(hi)}; ${list.filter((b) => b.why === '4 KB').length} cut short by a 4 KB boundary.`}>
        {list.map((b, i) => (
          <g key={i} onMouseEnter={() => pick(i)} className="cursor-pointer">
            <rect x={X(b.addr) + 0.5} y={22} width={Math.max(1, X(b.addr + b.beats * 8) - X(b.addr) - 1)} height={30} rx={3}
              fill={WHY_COLOR[b.why]} opacity={hover === null || hover === i ? 0.85 : 0.35} stroke="var(--foreground)" strokeWidth={hover === i ? 1.5 : 0} />
            {X(b.addr + b.beats * 8) - X(b.addr) > 18 && (
              <text x={(X(b.addr) + X(b.addr + b.beats * 8)) / 2} y={42} textAnchor="middle" fontSize={11} fill="var(--background)" fontWeight={700}>{b.beats}</text>
            )}
          </g>
        ))}
        {bounds.map((b) => (
          <g key={b}>
            <line x1={X(b)} x2={X(b)} y1={10} y2={62} stroke="var(--foreground)" strokeWidth={2} strokeDasharray="4 3" />
            <text x={X(b)} y={8} textAnchor="middle" fontSize={10} fill="var(--foreground)">4 KB · {hex(b)}</text>
          </g>
        ))}
        <rect x={X(base)} y={56} width={Math.max(1, X(base + len) - X(base))} height={5} fill="var(--chart-4)" />
        <text x={x0} y={78} fontSize={10} fill="var(--muted-foreground)">{hex(lo)}</text>
        <text x={W - 10} y={78} textAnchor="end" fontSize={10} fill="var(--muted-foreground)">{hex(hi)}</text>
        <text x={W / 2} y={88} textAnchor="middle" fontSize={10} fill="var(--muted-foreground)">bytes copied (purple) inside the beats read (bursts)</text>
      </svg>
      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
        {(['MAX_BURST', '4 KB', 'tail'] as Why[]).map((w) => (
          <span key={w} className="flex items-center gap-1"><i className="inline-block size-3 rounded-sm" style={{ background: WHY_COLOR[w] }} />limited by {w === 'tail' ? 'beats left' : w}</span>
        ))}
      </div>
      <div className="max-h-48 overflow-auto">
        <table className="w-full text-left text-sm" onMouseLeave={() => pick(null)}>
          <caption className="sr-only">Bursts</caption>
          <thead className="text-muted-foreground"><tr><th className="py-1 font-medium">#</th><th className="font-medium">burst_addr</th><th className="font-medium">burst_len</th><th className="font-medium">to_4k</th><th className="font-medium">limited by</th></tr></thead>
          <tbody>
            {list.map((b, i) => (
              <tr key={i} className={`border-t border-border ${hover === i ? 'bg-accent text-accent-foreground' : ''}`} onMouseEnter={() => pick(i)}>
                <td className="py-0.5">{i}</td><td className="font-mono">{hex(b.addr)}</td><td>{b.beats}</td><td>{512 - ((b.addr >> 3) & 511)}</td><td>{b.why}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

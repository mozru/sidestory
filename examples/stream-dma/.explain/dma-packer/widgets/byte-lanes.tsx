// Byte lanes through dma_packer: pick the source and destination offsets and a length, then step through the
// output beats. Each output beat is cut from a two-beat window {current, previous input beat}, rotated by
// (8 − shift) bytes, exactly as in the RTL; the lines show where every byte goes.
import { useEffect } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { highlight, useIsMyStepActive, useWidgetState } from 'explainer';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';

const NB = 8;
const CELL = 28;
const COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-6)'];

export default function ByteLanes({ src: src0 = 5, dst: dst0 = 2, len: len0 = 27 }: { src?: number; dst?: number; len?: number }) {
  const [src, setSrc] = useWidgetState('src', src0);
  const [dst, setDst] = useWidgetState('dst', dst0);
  const [len, setLen] = useWidgetState('len', len0);
  const [k, setK] = useWidgetState('beat', 0);
  const active = useIsMyStepActive();

  const nIn = Math.ceil((src + len) / NB);
  const nOut = Math.ceil((dst + len) / NB);
  const shift = (dst - src + NB) % NB;
  const prime = dst < src;
  const beat = Math.min(k, nOut - 1);
  const curIdx = beat + (prime ? 1 : 0); // input beat in the upper half of the window
  const flush = curIdx >= nIn;

  // Lines of the "pk-window" anchor: 2 = window, 3 = rot_bits, 4 = out_data.
  useEffect(() => {
    if (active) highlight(flush ? 2 : [2, 4], { identifiers: flush ? ['flush'] : ['window', 'rot_bits'] });
  }, [active, beat, flush, src, dst, len]);

  const inLaneOf = (n: number) => ({ beat: Math.floor((src + n) / NB), lane: (src + n) % NB });
  const outLaneOf = (n: number) => ({ beat: Math.floor((dst + n) / NB), lane: (dst + n) % NB });
  const bytes = Array.from({ length: len }, (_, n) => n);
  const rows = Math.max(nIn, nOut);
  const W = 740, xIn = 20, xOut = W - 20 - NB * CELL, y0 = 34, rh = 36;
  // lane 7 on the left, lane 0 on the right (bit 63 … bit 0)
  const cx = (x: number, lane: number) => x + (NB - 1 - lane) * CELL;
  const strb = (b: number) => {
    let m = 0;
    for (const n of bytes) if (outLaneOf(n).beat === b) m |= 1 << outLaneOf(n).lane;
    return m;
  };
  const inBeatUsed = (b: number) => b === curIdx || b === curIdx - 1;

  return (
    <div className="flex flex-col gap-3 p-2" data-testid="byte-lanes">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="grid gap-1">
          <Label htmlFor="src">src_off: {src}</Label>
          <Slider id="src" aria-label="Source offset" min={0} max={7} step={1} value={[src]} onValueChange={(v) => { setSrc(v[0] ?? 0); setK(0); }} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="dst">dst_off: {dst}</Label>
          <Slider id="dst" aria-label="Destination offset" min={0} max={7} step={1} value={[dst]} onValueChange={(v) => { setDst(v[0] ?? 0); setK(0); }} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="len">len: {len} bytes</Label>
          <Slider id="len" aria-label="Length" min={1} max={40} step={1} value={[len]} onValueChange={(v) => { setLen(v[0] ?? 1); setK(0); }} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant="secondary">shift = {shift} lane{shift === 1 ? '' : 's'}</Badge>
        <Badge variant={prime ? 'default' : 'outline'}>{prime ? 'prime: swallow the first beat' : 'no prime'}</Badge>
        <span className="text-muted-foreground">{nIn} beats in, {nOut} out</span>
      </div>
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${y0 + rows * rh + 10}`} className="h-auto w-full min-w-[520px] font-mono" role="img"
          aria-label={`Output beat ${beat} takes input beats ${curIdx - 1} and ${flush ? 'nothing (flush)' : curIdx}, rotated by ${NB - shift} bytes; strobe ${strb(beat).toString(2).padStart(8, '0')}.`}>
          <text x={xIn} y={14} fontSize={11} fill="var(--muted-foreground)">from the FIFO (src) · lane 7 … 0</text>
          <text x={xOut} y={14} fontSize={11} fill="var(--muted-foreground)">to the write port (dst) · strb</text>
          {/* lines for the bytes of the selected output beat */}
          {bytes.filter((n) => outLaneOf(n).beat === beat).map((n) => {
            const a = inLaneOf(n), b = outLaneOf(n);
            const x1 = cx(xIn, a.lane) + CELL / 2, y1 = y0 + a.beat * rh + CELL / 2;
            const x2 = cx(xOut, b.lane) + CELL / 2, y2 = y0 + b.beat * rh + CELL / 2;
            return <path key={n} d={`M${x1},${y1} C${x1 + 180},${y1} ${x2 - 180},${y2} ${x2},${y2}`} fill="none" stroke={COLORS[n % COLORS.length]} strokeWidth={1.4} opacity={0.8} />;
          })}
          {Array.from({ length: nIn }, (_, r) => (
            <g key={`i${r}`} opacity={inBeatUsed(r) ? 1 : 0.45}>
              <text x={xIn + NB * CELL + 6} y={y0 + r * rh + 18} fontSize={10} fill="var(--muted-foreground)">
                in {r}{r === curIdx ? ' cur' : r === curIdx - 1 ? ' prev' : ''}
              </text>
              {Array.from({ length: NB }, (_, lane) => {
                const n = r * NB + lane - src;
                const has = n >= 0 && n < len;
                return (
                  <g key={lane}>
                    <rect x={cx(xIn, lane)} y={y0 + r * rh} width={CELL - 2} height={CELL} rx={3}
                      fill={has ? COLORS[n % COLORS.length] : 'none'} fillOpacity={0.3} stroke={inBeatUsed(r) ? 'var(--foreground)' : 'var(--border)'} strokeDasharray={has ? undefined : '2 2'} />
                    {has && <text x={cx(xIn, lane) + (CELL - 2) / 2} y={y0 + r * rh + 18} textAnchor="middle" fontSize={11} fill="var(--foreground)">{n}</text>}
                  </g>
                );
              })}
            </g>
          ))}
          {Array.from({ length: nOut }, (_, r) => {
            const m = strb(r);
            return (
              <g key={`o${r}`} opacity={r === beat ? 1 : 0.45}>
                {Array.from({ length: NB }, (_, lane) => {
                  const n = r * NB + lane - dst;
                  const has = n >= 0 && n < len;
                  return (
                    <g key={lane}>
                      <rect x={cx(xOut, lane)} y={y0 + r * rh} width={CELL - 2} height={CELL} rx={3}
                        fill={has ? COLORS[n % COLORS.length] : 'none'} fillOpacity={0.3} stroke={r === beat ? 'var(--foreground)' : 'var(--border)'} strokeDasharray={has ? undefined : '2 2'} />
                      {has && <text x={cx(xOut, lane) + (CELL - 2) / 2} y={y0 + r * rh + 18} textAnchor="middle" fontSize={11} fill="var(--foreground)">{n}</text>}
                    </g>
                  );
                })}
                <text x={xOut - 6} y={y0 + r * rh + 18} textAnchor="end" fontSize={10} fill="var(--muted-foreground)">out {r} · {m.toString(2).padStart(8, '0')}</text>
              </g>
            );
          })}
        </svg>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" aria-label="Previous output beat" disabled={beat <= 0} onClick={() => setK(beat - 1)}><ChevronLeft /></Button>
        <Button size="sm" variant="outline" aria-label="Next output beat" disabled={beat >= nOut - 1} onClick={() => setK(beat + 1)}><ChevronRight /></Button>
        <span className="text-sm" aria-live="polite">
          out beat {beat} = {'{'}{flush ? '0' : `in ${curIdx}`}, in {curIdx - 1}{'}'} &gt;&gt; {NB - shift} bytes{flush ? ' (flush: no input left)' : ''}
          {beat === 0 ? ' · first beat: strb from dst_off' : ''}{beat === nOut - 1 ? ' · last beat: strb to the end' : ''}
        </span>
      </div>
    </div>
  );
}

// A sample widget: full-jitter backoff, attempt by attempt. Follows the steps (the "loop" step plays the
// retries out), reads the real ceiling formula from the code, and highlights it when a bar is picked.
import { useMemo } from 'react';
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Slider } from '@/components/ui/slider';
import { highlight, reveal, useAnchorCode, useStepValue, useWidgetState } from 'explainer';

/** The same formula as backoffDelay in src/retry.ts. */
const ceilingOf = (attempt: number, baseMs: number, maxMs: number) => Math.min(maxMs, baseMs * 2 ** attempt);

/** A small seeded random, so a roll stays the same across reloads (it is part of the widget's state). */
function random(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export default function Backoff({ baseMs = 100, maxMs = 2000, retries = 5 }: { baseMs?: number; maxMs?: number; retries?: number }) {
  const [base, setBase] = useWidgetState('base', baseMs);
  const [seed, setSeed] = useWidgetState('seed', 1);
  const [picked, setPicked] = useWidgetState<number | null>('picked', null);
  // On the loop step, the attempts play out to the one that succeeds; elsewhere every ceiling shows.
  const shown = useStepValue({ options: retries + 1, delay: retries + 1, loop: 3, giveup: retries + 1 }, retries + 1);
  const code = useAnchorCode('delay');
  const formula = code?.status === 'ok' ? code.text!.split('\n').find((l) => l.includes('ceiling ='))?.trim() : undefined;

  const data = useMemo(() => {
    const rand = random(seed);
    return Array.from({ length: retries + 1 }, (_, attempt) => {
      const ceiling = ceilingOf(attempt, base, maxMs);
      return { attempt: `#${attempt}`, ceiling, wait: Math.floor(rand() * ceiling) };
    });
  }, [base, maxMs, retries, seed]);
  const total = data.slice(0, shown).reduce((t, d) => t + d.wait, 0);

  return (
    <div className="flex flex-col gap-3 p-3" data-testid="backoff">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">baseMs</span>
        <Slider className="w-40" min={25} max={400} step={25} value={[base]} onValueChange={([v]) => setBase(v!)} aria-label="baseMs" />
        <Badge variant="secondary" data-testid="base">{base} ms</Badge>
        <Button size="sm" variant="outline" data-testid="roll" onClick={() => setSeed(seed + 1)}>Roll again</Button>
        <span className="ml-auto text-muted-foreground" data-testid="total">{shown} attempt{shown === 1 ? '' : 's'}, waited {total} ms</span>
      </div>
      <div>
        <ResponsiveContainer width="100%" height={160}>
          <BarChart data={data.slice(0, shown)} margin={{ top: 4, right: 4, bottom: 0, left: -12 }}>
            <XAxis dataKey="attempt" tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} />
            <YAxis tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} />
            <Tooltip />
            <Bar dataKey="ceiling" isAnimationActive={false} onClick={(_d, i) => { setPicked(i); highlight([3, 3], { identifiers: ['ceiling'] }); }}>
              {data.slice(0, shown).map((d, i) => <Cell key={d.attempt} fill={i === picked ? 'var(--chart-2)' : 'var(--chart-1)'} fillOpacity={0.35} />)}
            </Bar>
            <Bar dataKey="wait" fill="var(--chart-1)" isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <code className="truncate" data-testid="formula">{formula ?? 'ceiling = min(maxMs, baseMs × 2^attempt)'}</code>
        <Button size="sm" variant="ghost" className="ml-auto" data-testid="show-code" onClick={() => void reveal('delay', { lines: [3, 3] })}>Show the formula</Button>
      </div>
    </div>
  );
}

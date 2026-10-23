// A bloom filter to play with: the same hash and double hashing as bloom.py, on a filter small enough to
// see. Add keys and watch their bits; look a key up and see which bits it checks; change m and k and
// compare the false-positive rate you measure with the formula.
import { type KeyboardEvent, useEffect, useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceDot, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { highlight, useIsMyStepActive, useReducedMotion, useWidgetState } from 'explainer';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import lines from './lines.json';

// ---- bloom.py
const enc = new TextEncoder();
const M64 = (1n << 64n) - 1n;
function hash64(s: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (const b of enc.encode(s)) h = ((h ^ BigInt(b)) * 0x100000001b3n) & M64;
  h = ((h ^ (h >> 33n)) * 0xff51afd7ed558ccdn) & M64;
  h = ((h ^ (h >> 33n)) * 0xc4ceb9fe1a85ec53n) & M64;
  return h ^ (h >> 33n);
}
function positions(key: string, m: number, k: number): number[] {
  const h = hash64(key);
  const h1 = h & 0xffffffffn;
  const h2 = (h >> 32n) | 1n;
  return Array.from({ length: k }, (_, i) => Number((h1 + BigInt(i) * h2) % BigInt(m)));
}

const FRUITS = ['apple', 'banana', 'cherry', 'date', 'fig', 'grape', 'kiwi', 'lemon', 'mango', 'nut', 'olive', 'pear', 'plum', 'quince', 'melon', 'lime'];
// Keys that are never added: the measured false-positive rate is the share of these that get a "maybe".
const PROBES = Array.from({ length: 400 }, (_, i) => `absent-${i}`);
const L = (lines as Record<string, Record<string, number | number[]>>)['bl-play'] ?? {};

const fpRate = (m: number, k: number, n: number) => (n === 0 ? 0 : (1 - Math.exp((-k * n) / m)) ** k);

export default function BloomPlayground() {
  const [m, setM] = useWidgetState('m', 48);
  const [k, setK] = useWidgetState('k', 3);
  const [keys, setKeys] = useWidgetState<string[]>('keys', ['apple', 'banana', 'cherry']);
  const [query, setQuery] = useWidgetState('query', 'grape');
  const [last, setLast] = useWidgetState<'add' | 'query'>('last', 'query');
  const [draft, setDraft] = useState('');
  const reduced = useReducedMotion();
  const active = useIsMyStepActive();

  const bits = useMemo(() => {
    const set = new Map<number, string[]>();
    for (const key of keys) for (const p of positions(key, m, k)) set.set(p, [...(set.get(p) ?? []), key]);
    return set;
  }, [keys, m, k]);
  const lastKey = keys[keys.length - 1];
  const shown = last === 'add' ? lastKey : query;
  const shownPos = shown ? positions(shown, m, k) : [];
  const verdict = query ? positions(query, m, k).every((p) => bits.has(p)) : false;
  const isMember = keys.includes(query);
  const measured = useMemo(() => PROBES.filter((p) => positions(p, m, k).every((x) => bits.has(x))).length / PROBES.length, [bits, m, k]);
  const n = keys.length;
  const bestK = n ? Math.max(1, Math.round((m / n) * Math.LN2)) : 1;
  const curve = useMemo(() => Array.from({ length: 12 }, (_, i) => ({ k: i + 1, fp: +(fpRate(m, i + 1, n) * 100).toFixed(2) })), [m, n]);

  useEffect(() => {
    if (!active) return;
    const lines = last === 'add' ? L.add : L.query;
    if (lines === undefined) highlight();
    else highlight(lines as number | [number, number]);
  }, [active, last]);

  const add = (key: string) => {
    const kk = key.trim().toLowerCase();
    if (!kk || keys.includes(kk)) return;
    setKeys([...keys, kk]);
    setLast('add');
    setDraft('');
  };

  return (
    <div className="flex min-h-[600px] flex-col gap-3 p-2" data-testid="bloom">
      <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="bloom-m">m = {m} bits ({n ? (m / n).toFixed(1) : '—'} per key)</Label>
          <Slider id="bloom-m" aria-label="Number of bits" min={16} max={128} step={8} value={[m]} onValueChange={(v) => setM(v[0] ?? 48)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="bloom-k">k = {k} hashes {n > 0 && <span className="text-muted-foreground">(best for these: {bestK})</span>}</Label>
          <Slider id="bloom-k" aria-label="Number of hashes" min={1} max={12} step={1} value={[k]} onValueChange={(v) => setK(v[0] ?? 3)} />
        </div>
      </div>

      <div className="grid gap-[3px]" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(26px, 1fr))' }} role="img"
        aria-label={`${bits.size} of ${m} bits set by ${n} keys. ${shown ? `${shown} uses bits ${shownPos.join(', ')}.` : ''}`}>
        {Array.from({ length: m }, (_, p) => {
          const on = bits.has(p);
          const hit = shownPos.includes(p);
          const miss = hit && last === 'query' && !on;
          return (
            <div key={p} title={on ? `bit ${p}: ${bits.get(p)!.join(', ')}` : `bit ${p}: 0`}
              className={`flex h-7 flex-col items-center justify-center rounded-[3px] border font-mono text-[10px] leading-none ${reduced ? '' : 'transition-colors duration-300'} ${
                miss ? 'border-2 border-destructive text-destructive' : hit ? 'border-2 border-chart-3' : 'border-border'}`}
              style={{ background: on ? 'color-mix(in srgb, var(--chart-1) 40%, transparent)' : undefined }}>
              <span className="font-semibold">{on ? 1 : 0}</span>
              <span className="text-[8px] text-muted-foreground">{p}</span>
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input className="h-8 w-32 font-mono" placeholder="a key" aria-label="Key to add" value={draft} onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') add(draft); }} />
        <Button size="sm" disabled={!draft.trim()} onClick={() => add(draft)}>Add</Button>
        <Button size="sm" variant="outline" onClick={() => { const next = FRUITS.find((f) => !keys.includes(f)); if (next) add(next); }}>Add a fruit</Button>
        <Button size="sm" variant="outline" onClick={() => { setKeys([...new Set([...keys, ...FRUITS.slice(0, 12)])]); setLast('add'); }}>Fill to 12 fruits</Button>
        <Button size="sm" variant="ghost" onClick={() => { setKeys([]); setLast('query'); }}>Clear</Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Keys ({n}): <span className="font-mono text-foreground">{keys.join(' ') || '—'}</span>
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor="bloom-q">Look up</Label>
        <Input id="bloom-q" className="h-8 w-32 font-mono" value={query} onChange={(e) => { setQuery(e.target.value.trim().toLowerCase()); setLast('query'); }} />
        {['grape', 'kiwi', 'plum', 'zebra', 'durian'].map((q) => (
          <Button key={q} size="sm" variant="outline" onClick={() => { setQuery(q); setLast('query'); }}>{q}</Button>
        ))}
      </div>
      {query && (
        <p className="text-sm" aria-live="polite" data-testid="bloom-verdict">
          <span className="font-mono">{query}</span> checks bits <span className="font-mono">{positions(query, m, k).join(', ')}</span>:{' '}
          {verdict
            ? <strong className={isMember ? 'text-chart-3' : 'text-chart-2'}>maybe here{isMember ? ' (and it is)' : ': a false positive, it was never added'}</strong>
            : <strong>definitely not here</strong>}{!verdict && ', a bit is 0 (red), so no key ever set them all.'}
        </p>
      )}

      <div className="grid items-center gap-3 sm:grid-cols-[1fr_1.3fr]">
        <div className="grid gap-1 text-sm">
          <div>bits set: <strong className="tabular-nums">{bits.size} / {m}</strong> ({Math.round((bits.size / m) * 100)}%)</div>
          <div>false positives, formula: <strong className="tabular-nums">{(fpRate(m, k, n) * 100).toFixed(1)}%</strong></div>
          <div>measured on {PROBES.length} absent keys: <strong className="tabular-nums" data-testid="bloom-measured">{(measured * 100).toFixed(1)}%</strong></div>
          <div className="text-xs text-muted-foreground">(1 − e<sup>−kn/m</sup>)<sup>k</sup>, lowest at k = (m/n)·ln 2. tiny_lsm uses m/n = 10, k = 7: about 0.8%.</div>
        </div>
        <div role="img" aria-label={`False-positive rate by number of hashes for ${n} keys in ${m} bits: lowest at k = ${bestK}`}>
          <ResponsiveContainer width="100%" height={150}>
            <LineChart data={curve} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
              <XAxis dataKey="k" stroke="var(--border)" tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} />
              <YAxis unit="%" stroke="var(--border)" tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} />
              <Tooltip formatter={(v: number | string) => [`${v}%`, 'false positives']} labelFormatter={(l: number | string) => `k = ${l}`}
                contentStyle={{ background: 'var(--popover)', border: '1px solid var(--border)', color: 'var(--popover-foreground)' }} />
              <Line type="monotone" dataKey="fp" stroke="var(--chart-3)" strokeWidth={2} dot={false} isAnimationActive={!reduced} />
              <ReferenceDot x={k} y={+(fpRate(m, k, n) * 100).toFixed(2)} r={5} fill="var(--chart-2)" stroke="var(--background)" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

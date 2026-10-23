// A step-by-step model of tiny_lsm (db.py, compaction.py, sstable.py, bloom.py), written to follow the
// Python line for line: the same flush and compaction rules, the same byte sizes, the same bloom filter
// hash. Only the limits are smaller, so a few writes are enough to watch everything happen.
// tools/check_model.py runs the same workloads through the Python code and compares the results.

export const OPTS = {
  memtableBytes: 48,
  blockBytes: 32,
  tableBytes: 64,
  bloomBitsPerKey: 10,
  l0Limit: 3,
  levelBaseBytes: 320,
  levelMultiplier: 4,
  numLevels: 3,
};

export type Value = string | null; // null: a tombstone
export interface Entry { key: string; value: Value }
export interface Table { num: number; entries: Entry[]; min: string; max: string; size: number; bits: number; hashes: number; bloom: number[] }

export type Op =
  | { kind: 'put'; key: string; value: string }
  | { kind: 'del'; key: string }
  | { kind: 'get'; key: string }
  | { kind: 'scan'; start: string | null; end: string | null };

/** Which line of the Python code a frame is "running" (tools/diagrams.py maps these to lines per anchor). */
export type Line =
  | 'w-append' | 'w-insert' | 'w-check' | 'f-write' | 'f-commit' | 'f-newlog' | 'f-compact'
  | 'g-mem' | 'g-mem-hit' | 'g-tables' | 'g-table' | 'g-hit' | 'g-none'
  | 's-mem' | 's-tables' | 's-merge'
  | 'c-pick0' | 'c-pickn' | 'c-merge' | 'c-commit';

export type Probe = { level: number; num: number; result: 'range' | 'bloom' | 'miss' | 'hit' | 'tombstone' };
export interface HeapItem { key: string; rank: number; value: Value }

export interface Frame {
  op: number;
  line: Line;
  msg: string;
  lit: string[]; // diagram wires active in this frame
  // the database after this frame
  wal: Entry[];
  log: number;
  mem: Entry[];
  memSize: number;
  levels: Table[][];
  // what this frame is doing
  memHit?: boolean;
  probe?: Probe;
  probed?: Probe[]; // earlier probes of this get
  compaction?: { level: number; inputs: number[]; overlaps: number[]; outputs: number[]; dropped: string[] };
  heap?: HeapItem[];
  out?: Entry[]; // scan results so far
  result?: string;
}

// ---- sizes, as the Python code counts them
const enc = new TextEncoder();
const len = (s: string | null) => (s === null ? 0 : enc.encode(s).length);
const HEADER = 7; // struct "<BHI"
export const entryBytes = (e: Entry) => HEADER + len(e.key) + len(e.value);

/** The blocks a TableBuilder cuts: a block ends once it holds block_bytes; each gets a 4-byte CRC. */
function blocks(entries: Entry[]): Entry[][] {
  const out: Entry[][] = [];
  let cur: Entry[] = [];
  let bytes = 0;
  for (const e of entries) {
    cur.push(e);
    bytes += entryBytes(e);
    if (bytes >= OPTS.blockBytes) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

export function tableLayout(entries: Entry[]) {
  const bs = blocks(entries);
  const blockSizes = bs.map((b) => b.reduce((s, e) => s + entryBytes(e), 0) + 4);
  const index = 4 + bs.reduce((s, b) => s + 2 + len(b[0]!.key) + 12, 0) + 2 + len(entries[entries.length - 1]!.key);
  const bits = Math.max(64, entries.length * OPTS.bloomBitsPerKey);
  const bloom = 5 + Math.ceil(bits / 8);
  return { blocks: bs, blockSizes, index, bloom, footer: 40, bits };
}

// ---- the bloom filter (bloom.py)
const M64 = (1n << 64n) - 1n;
export function hash64(s: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (const b of enc.encode(s)) h = ((h ^ BigInt(b)) * 0x100000001b3n) & M64;
  h = ((h ^ (h >> 33n)) * 0xff51afd7ed558ccdn) & M64;
  h = ((h ^ (h >> 33n)) * 0xc4ceb9fe1a85ec53n) & M64;
  return h ^ (h >> 33n);
}
export function positions(key: string, bits: number, hashes: number): number[] {
  const h = hash64(key);
  const h1 = h & 0xffffffffn;
  const h2 = (h >> 32n) | 1n;
  return Array.from({ length: hashes }, (_, i) => Number((h1 + BigInt(i) * h2) % BigInt(bits)));
}
export const hashesFor = (bitsPerKey: number) => Math.max(1, Math.round(bitsPerKey * Math.LN2));

function makeTable(num: number, entries: Entry[]): Table {
  const layout = tableLayout(entries);
  const hashes = hashesFor(OPTS.bloomBitsPerKey);
  const set = new Set<number>();
  for (const e of entries) for (const p of positions(e.key, layout.bits, hashes)) set.add(p);
  const size = layout.blockSizes.reduce((a, b) => a + b, 0) + layout.index + layout.bloom + layout.footer;
  return { num, entries, min: entries[0]!.key, max: entries[entries.length - 1]!.key, size, bits: layout.bits, hashes, bloom: [...set].sort((a, b) => a - b) };
}
const mightContain = (t: Table, key: string) => positions(key, t.bits, t.hashes).every((p) => t.bloom.includes(p));

// ---- the database
class Db {
  wal: Entry[] = [];
  mem = new Map<string, Value>();
  memSize = 0;
  levels: Table[][] = Array.from({ length: OPTS.numLevels }, () => []);
  nextNumber = 1;
  log: number;
  nextKey = new Map<number, string>();
  frames: Frame[] = [];
  op = 0;

  constructor() {
    this.log = this.newNumber();
  }

  newNumber() {
    return this.nextNumber++;
  }

  memItems(start: string | null = null, end: string | null = null): Entry[] {
    return [...this.mem.keys()].sort(cmp).filter((k) => (start === null || k >= start) && (end === null || k < end)).map((key) => ({ key, value: this.mem.get(key)! }));
  }

  emit(line: Line, msg: string, lit: string[], extra: Partial<Frame> = {}) {
    this.frames.push({
      op: this.op, line, msg, lit,
      wal: [...this.wal], log: this.log, mem: this.memItems(), memSize: this.memSize,
      levels: this.levels.map((l) => [...l]), ...extra,
    });
  }

  // db.py: _write and flush
  write(key: string, value: Value) {
    this.wal.push({ key, value });
    this.emit('w-append', `Append ${value === null ? 'a tombstone' : 'the entry'} to log ${num(this.log)}.log: durable first.`, ['put', 'append']);
    const old = this.mem.get(key);
    if (this.mem.has(key)) this.memSize -= len(old ?? null);
    else this.memSize += HEADER + len(key);
    this.mem.set(key, value);
    this.memSize += len(value);
    this.emit('w-insert', `Insert into the memtable, in key order: now visible to reads.`, ['insert']);
    const full = this.memSize >= OPTS.memtableBytes;
    this.emit('w-check', full ? `The memtable holds ${this.memSize} of ${OPTS.memtableBytes} bytes: flush it.` : `The memtable holds ${this.memSize} of ${OPTS.memtableBytes} bytes: done.`, full ? ['flush'] : []);
    if (full) this.flush();
  }

  flush() {
    const t = makeTable(this.newNumber(), this.memItems());
    this.emit('f-write', `Write the memtable, sorted, as table ${num(t.num)}.sst (${t.entries.length} entries, ${t.size} bytes).`, ['flush'], { compaction: undefined });
    this.levels[0]!.unshift(t);
    this.log = this.newNumber();
    this.emit('f-commit', `Commit the manifest: L0 gains ${num(t.num)}.sst (newest first), and log ${num(this.log)} takes over.`, ['commit-flush']);
    this.wal = [];
    this.emit('f-newlog', `Open the new, empty log and delete the old one: its writes are in the table now.`, ['append']);
    this.mem.clear();
    this.memSize = 0;
    const next = this.pick();
    this.emit('f-compact', next ? `Start an empty memtable, and compact: ${next.level === 0 ? 'L0 has reached its table limit' : `L${next.level} is over its byte limit`}.` : 'Start an empty memtable. No level is over its limit.', ['trigger']);
    let c;
    while ((c = this.pick())) this.run(c);
  }

  // compaction.py: pick and run
  pick(): { level: number; inputs: Table[]; overlaps: Table[] } | null {
    const L = this.levels;
    if (L[0]!.length >= OPTS.l0Limit) {
      const inputs = [...L[0]!];
      const lo = inputs.map((t) => t.min).sort(cmp)[0]!;
      const hi = inputs.map((t) => t.max).sort(cmp).at(-1)!;
      return { level: 0, inputs, overlaps: this.overlapping(1, lo, hi) };
    }
    for (let n = 1; n < L.length - 1; n++) {
      if (levelBytes(L[n]!) > levelLimit(n)) {
        const start = this.nextKey.get(n) ?? '';
        const t = L[n]!.find((x) => x.min >= start) ?? L[n]![0]!;
        this.nextKey.set(n, t.max + '\0');
        return { level: n, inputs: [t], overlaps: this.overlapping(n + 1, t.min, t.max) };
      }
    }
    return null;
  }

  overlapping(n: number, lo: string, hi: string) {
    return this.levels[n]!.filter((t) => t.min <= hi && lo <= t.max);
  }

  run(c: { level: number; inputs: Table[]; overlaps: Table[] }) {
    const out = c.level + 1;
    const ids = { level: c.level, inputs: c.inputs.map((t) => t.num), overlaps: c.overlaps.map((t) => t.num), outputs: [] as number[], dropped: [] as string[] };
    const why = c.level === 0
      ? `L0 has ${c.inputs.length} tables (the limit is ${OPTS.l0Limit}): merge all of them`
      : `L${c.level} holds ${levelBytes(this.levels[c.level]!)} bytes (the limit is ${levelLimit(c.level)}): merge ${num(c.inputs[0]!.num)}.sst`;
    this.emit(c.level === 0 ? 'c-pick0' : 'c-pickn', `${why} with the ${c.overlaps.length} L${out} table${c.overlaps.length === 1 ? '' : 's'} ${c.inputs.length === 1 ? 'it overlaps' : 'they overlap'}.`, [`compact-${c.level}`, 'trigger'], { compaction: { ...ids } });
    const merged = mergeEntries([...c.inputs, ...c.overlaps].map((t) => t.entries));
    const outputs: Table[] = [];
    let cur: Entry[] = [];
    let curNum = 0;
    const dropped: string[] = [];
    for (const e of merged) {
      if (e.value === null && !this.deeperMayHold(out, e.key)) {
        dropped.push(e.key);
        continue;
      }
      if (!cur.length) curNum = this.newNumber();
      cur.push(e);
      if (builderSize(cur) >= OPTS.tableBytes) {
        outputs.push(makeTable(curNum, cur));
        cur = [];
      }
    }
    if (cur.length) outputs.push(makeTable(curNum, cur));
    ids.outputs = outputs.map((t) => t.num);
    ids.dropped = dropped;
    const kept = merged.length - dropped.length;
    this.emit('c-merge', `Merge ${merged.length} distinct keys, newest entry wins, into ${outputs.length} new table${outputs.length === 1 ? '' : 's'}${dropped.length ? `; drop the tombstone${dropped.length === 1 ? '' : 's'} for ${dropped.join(', ')}: nothing deeper to hide` : ''}.`, [`compact-${c.level}`], { compaction: { ...ids }, result: `${kept} entries` });
    const L = this.levels;
    L[c.level] = L[c.level]!.filter((t) => !c.inputs.includes(t));
    L[out] = [...L[out]!.filter((t) => !c.overlaps.includes(t)), ...outputs].sort((a, b) => cmp(a.min, b.min));
    this.emit('c-commit', `Commit the manifest: the new tables replace the old ones in one step; then delete the old files.`, ['commit-compact', `compact-${c.level}`], { compaction: { ...ids } });
  }

  deeperMayHold(level: number, key: string) {
    return this.levels.slice(level + 1).some((l) => l.some((t) => t.min <= key && key <= t.max));
  }

  tablesForKey(key: string): [number, Table][] {
    const out: [number, Table][] = this.levels[0]!.map((t) => [0, t]);
    this.levels.slice(1).forEach((l, i) => {
      const t = [...l].reverse().find((x) => x.min <= key);
      if (t && key <= t.max) out.push([i + 1, t]);
    });
    return out;
  }

  // db.py: get
  get(key: string) {
    const v = this.mem.get(key);
    if (this.mem.has(key)) {
      this.emit('g-mem-hit', v === null ? `The memtable has a tombstone for ${key}: deleted. Stop here.` : `The memtable has ${key}: stop at the newest value.`, ['get', 'probe-mem'], { memHit: true, result: v === null ? 'None (deleted)' : JSON.stringify(v) });
      return;
    }
    this.emit('g-mem', `Not in the memtable. Ask the tables, newest first.`, ['get', 'probe-mem'], { memHit: false });
    const probed: Probe[] = [];
    const cands = this.tablesForKey(key);
    const skipped = this.levels.reduce((s, l, i) => s + (i === 0 ? 0 : l.length), 0) - cands.filter(([l]) => l > 0).length;
    if (skipped > 0 || cands.length) this.emit('g-tables', `Every L0 table may hold ${key}; in L1 and below, only the one table whose range covers it${skipped ? ` (${skipped} skipped by range)` : ''}.`, ['probe-l0']);
    for (const [level, t] of cands) {
      const wire = `probe-l${level}`;
      if (key < t.min || key > t.max) {
        const p: Probe = { level, num: t.num, result: 'range' };
        this.emit('g-table', `${num(t.num)}.sst holds ${t.min}…${t.max}: ${key} is outside. No disk read.`, [wire], { probe: p, probed: [...probed] });
        probed.push(p);
        continue;
      }
      if (!mightContain(t, key)) {
        const p: Probe = { level, num: t.num, result: 'bloom' };
        this.emit('g-table', `${num(t.num)}.sst: the bloom filter says "definitely not here". No disk read.`, [wire], { probe: p, probed: [...probed] });
        probed.push(p);
        continue;
      }
      const e = t.entries.find((x) => x.key === key);
      const p: Probe = { level, num: t.num, result: e ? (e.value === null ? 'tombstone' : 'hit') : 'miss' };
      if (e) {
        this.emit('g-hit', e.value === null
          ? `${num(t.num)}.sst: bloom says "maybe", one block read finds a tombstone: ${key} was deleted. Stop.`
          : `${num(t.num)}.sst: bloom says "maybe", one block read finds ${key}. Stop at the newest value.`, [wire, 'get'], { probe: p, probed: [...probed], result: e.value === null ? 'None (deleted)' : JSON.stringify(e.value) });
        return;
      }
      this.emit('g-table', `${num(t.num)}.sst: bloom says "maybe", but the block doesn't have ${key}: a false positive, one wasted read.`, [wire], { probe: p, probed: [...probed] });
      probed.push(p);
    }
    this.emit('g-none', `No table has ${key}: it was never written.`, ['get'], { probed: [...probed], result: 'None' });
  }

  // db.py: scan, merge.py
  scan(start: string | null, end: string | null) {
    const sources: Entry[][] = [this.memItems(start, end)];
    const tables = this.levels.flat().filter((t) => (end === null || t.min < end) && (start === null || t.max >= start));
    this.emit('s-mem', `Snapshot the memtable's entries in range: source 0, the newest.`, ['scan-mem']);
    for (const t of tables) sources.push(t.entries.filter((e) => (start === null || e.key >= start) && (end === null || e.key < end)));
    const pos = sources.map(() => 0);
    const heap = () => sources.flatMap((s, rank) => (pos[rank]! < s.length ? [{ key: s[pos[rank]!]!.key, rank, value: s[pos[rank]!]!.value }] : [])).sort((a, b) => cmp(a.key, b.key) || a.rank - b.rank);
    this.emit('s-tables', `Add the ${tables.length} overlapping tables, newest first, and put each source's first entry on the heap.`, ['scan-tables'], { heap: heap(), out: [] });
    const out: Entry[] = [];
    for (;;) {
      const h = heap();
      if (!h.length) break;
      const top = h[0]!;
      const shadowed = h.filter((x) => x.key === top.key && x !== top);
      for (const x of [top, ...shadowed]) pos[x.rank]!++;
      if (top.value !== null) out.push({ key: top.key, value: top.value });
      const what = top.value === null ? `a tombstone: ${top.key} is skipped` : `${top.key}=${top.value}`;
      this.emit('s-merge', `Pop ${top.key} from source ${top.rank}: ${what}${shadowed.length ? `; older entries in source ${shadowed.map((x) => x.rank).join(', ')} are shadowed` : ''}.`, ['scan-out'], { heap: h, out: [...out] });
    }
    this.emit('s-merge', `Done: ${out.length} live keys, in order.`, ['scan-out'], { heap: [], out: [...out], result: `${out.length} keys` });
  }
}

export const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export const num = (n: number) => String(n).padStart(6, '0');
export const levelBytes = (l: Table[]) => l.reduce((s, t) => s + t.size, 0);
export const levelLimit = (n: number) => OPTS.levelBaseBytes * OPTS.levelMultiplier ** (n - 1);
/** TableBuilder.size: the finished blocks (with their CRCs) plus the open block. */
function builderSize(entries: Entry[]) {
  const bs = blocks(entries);
  const full = bs.reduce((s, b) => s + b.reduce((x, e) => x + entryBytes(e), 0), 0);
  const last = bs.at(-1)!;
  const open = last.reduce((x, e) => x + entryBytes(e), 0) >= OPTS.blockBytes ? 0 : 1;
  return full + 4 * (bs.length - open);
}

/** merge.py: one entry per key, sources newest first. */
export function mergeEntries(sources: Entry[][]): Entry[] {
  const seen = new Map<string, Entry>();
  sources.forEach((s) => s.forEach((e) => { if (!seen.has(e.key)) seen.set(e.key, e); }));
  return [...seen.values()].sort((a, b) => cmp(a.key, b.key));
}

/** Runs ops on an empty database. Ops before `from` run silently (their frames are dropped). */
export function simulate(ops: Op[], from = 0): Frame[] {
  const db = new Db();
  ops.forEach((op, i) => {
    db.op = i;
    const before = db.frames.length;
    if (op.kind === 'put') db.write(op.key, op.value);
    else if (op.kind === 'del') db.write(op.key, null);
    else if (op.kind === 'get') db.get(op.key);
    else db.scan(op.start, op.end);
    if (i < from) db.frames.length = before;
  });
  if (!db.frames.length) db.emit('w-check', 'Nothing has happened yet.', []);
  return db.frames;
}

export function opText(op: Op): string {
  switch (op.kind) {
    case 'put': return `put(${op.key}, ${op.value})`;
    case 'del': return `delete(${op.key})`;
    case 'get': return `get(${op.key})`;
    case 'scan': return `scan(${op.start ?? '…'}, ${op.end ?? '…'})`;
  }
}

const puts = (words: string, value: string): Op[] => words.split(' ').map((key) => ({ kind: 'put', key, value }));

/** The database the read and scan scenarios start from: five flushes and two compactions. */
const PRELOAD: Op[] = [
  ...puts('apple fig kiwi date', '1'),
  ...puts('banana grape lemon cherry', '1'),
  ...puts('mango fig nut lemon', '2'), // the third L0 table: L0 -> L1, then L1 -> L2
  { kind: 'del', key: 'kiwi' },
  ...puts('pear apple quince', '3'),
  ...puts('date plum apple berry', '4'),
  ...puts('cherry nut', '5'),
];

export const SCENARIOS: Record<string, { label: string; ops: Op[]; from: number }> = {
  write: {
    label: 'Writes: flushes, compactions, a tombstone dropped',
    ops: [...PRELOAD, ...puts('melon lime', '6')], // the third L0 table again: kiwi's tombstone meets kiwi
    from: 0,
  },
  read: {
    label: 'Reads: memtable, newest first, bloom filters',
    ops: [...PRELOAD, ...['cherry', 'apple', 'kiwi', 'fig', 'lime'].map((key): Op => ({ kind: 'get', key }))],
    from: PRELOAD.length,
  },
  scan: { label: 'A scan from c to m', ops: [...PRELOAD, { kind: 'scan', start: 'c', end: 'm' }], from: PRELOAD.length },
};

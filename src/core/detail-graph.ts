// The detail graph of one package (one `.sidestory/` folder), docs/NAVIGATION-PLAN.md §4, §5.2 and §8.2.
//
//   buildDetailGraph(nodes, {maxEdges}) → DetailGraph
//
// - Nodes are sidestories, keyed by folder name. Edges A → B come from each `data-explain-detail="B"` in A, in
//   document order, deduplicated; B must be a valid name (explainerNameSchema) of a sidestory in the same folder.
//   Self-links are dropped; missing targets and invalid names are kept as A's `brokenLinks`.
// - Tops (§4.2): a sidestory whose manifest sets `group` or `"top": true`; one nothing links to; and, for each
//   source strongly connected component (no edges in from other components) holding no top, one representative:
//   the Start-here name candidate, else the node with the most outgoing edges, else the first by name. After
//   this every sidestory is reachable from a top.
// - Primary paths (§4.3): one shortest path from a top, found once by a multi-source BFS seeded with the tops in
//   title order, children in document order. Ties go to the top whose title sorts first, then to the parent
//   that comes first in the HTML. All paths are never enumerated (a DAG of shared details has exponentially many).
// - Start here (§8.2): a sidestory named `overview`; else the only one named `*-overview`; else the only top
//   that has details.
//
// Everything is O(V + E) apart from sorting (parents once per node, tops once). Pure: no vscode or node imports.
import { explainerNameSchema } from './manifest.ts';

export interface GraphNodeInput {
  name: string;
  /** For ordering tops and parents; the folder name is used when empty. */
  title: string;
  group?: string;
  top?: boolean;
  /** Raw `data-explain-detail` values in document order; may repeat, be invalid, or name the node itself. */
  details: readonly string[];
}

export interface DetailGraph {
  /** Every node name, in input order (duplicates of a name dropped). */
  readonly names: readonly string[];
  has(name: string): boolean;
  /** Valid, existing, deduplicated details, self-links dropped, in document order. */
  children(name: string): readonly string[];
  /** Direct parents ("also under"), ordered by title (locale, numeric-aware), then name. */
  parents(name: string): readonly string[];
  /** Detail links naming no sibling, or an invalid name: deduplicated, in document order. */
  brokenLinks(name: string): readonly string[];
  isTop(name: string): boolean;
  /** Ordered by title (locale, numeric-aware), then name. */
  readonly tops: readonly string[];
  /**
   * The primary path, top first, the node last; a top's own path is just itself. Undefined only for unknown names.
   * Anchored at the top: a path longer than `max` (default 16) keeps its first `max` names, so `[0]` is always a
   * top. Bounded: at most ~32 steps for `max` ≤ 32, however deep the node.
   */
  primaryPath(name: string, max?: number): readonly string[] | undefined;
  /** The primary path's last `max` names (default 16, the trail limit), ending at `name`: a panel trail. */
  trailTo(name: string, max?: number): readonly string[] | undefined;
  /** Names on the primary path (a top: 1); undefined for unknown names. */
  pathLength(name: string): number | undefined;
  readonly startHere: string | undefined;
  readonly edgeCount: number;
  /** The edge cap was reached: later links were dropped. */
  readonly edgesCapped: boolean;
}

export const MAX_GRAPH_EDGES = 50_000;
/** Primary paths are cut to this many names, the panel's trail limit (MAX_TRAIL). */
export const MAX_PRIMARY_PATH = 16;
/** Top-anchored prefixes up to this many names are walked in O(PREFIX), not O(depth). */
const PREFIX = 32;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Case-insensitive after collapsing whitespace: "Storage ", "storage" and "STORAGE" are one group. */
export function groupKey(g: string): string {
  return g.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Groups of a package (§5.2): members under each key, sorted by name; the label is the most common spelling,
 * ties going to the spelling of the first member by name. Groups sort by label (locale, numeric-aware).
 */
export function mergeGroups(nodes: readonly { name: string; group?: string }[]): { key: string; label: string; members: string[] }[] {
  const byKey = new Map<string, { name: string; spelling: string }[]>();
  for (const n of nodes) {
    if (n.group === undefined) continue;
    const key = groupKey(n.group);
    if (!key) continue;
    const list = byKey.get(key);
    const item = { name: n.name, spelling: n.group.replace(/\s+/g, ' ').trim() };
    if (list) list.push(item);
    else byKey.set(key, [item]);
  }
  const out: { key: string; label: string; members: string[] }[] = [];
  for (const [key, items] of byKey) {
    items.sort((a, b) => byName(a.name, b.name));
    const counts = new Map<string, number>();
    for (const i of items) counts.set(i.spelling, (counts.get(i.spelling) ?? 0) + 1);
    let label = items[0]!.spelling;
    let best = counts.get(label)!;
    // Map iteration follows first appearance in name order, so a strictly larger count is needed to win.
    for (const [s, c] of counts) {
      if (c > best) {
        best = c;
        label = s;
      }
    }
    out.push({ key, label, members: items.map((i) => i.name) });
  }
  return out.sort((a, b) => collator.compare(a.label, b.label) || byName(a.key, b.key));
}

/** The Start-here candidate by name alone: `overview`, else the only `*-overview`. */
export function overviewCandidate(names: Iterable<string>): string | undefined {
  let suffixed: string | undefined;
  let count = 0;
  for (const n of names) {
    if (n === 'overview') return n;
    if (n.endsWith('-overview')) {
      count++;
      suffixed = n;
    }
  }
  return count === 1 ? suffixed : undefined;
}

export function buildDetailGraph(nodes: readonly GraphNodeInput[], opts: { maxEdges?: number } = {}): DetailGraph {
  const maxEdges = opts.maxEdges ?? MAX_GRAPH_EDGES;
  const index = new Map<string, number>();
  const inputs: GraphNodeInput[] = [];
  for (const n of nodes) {
    if (index.has(n.name)) continue;
    index.set(n.name, inputs.length);
    inputs.push(n);
  }
  const V = inputs.length;
  const names = inputs.map((n) => n.name);
  const titles = inputs.map((n) => n.title || n.name);
  const compareNodes = (a: number, b: number) => collator.compare(titles[a]!, titles[b]!) || byName(names[a]!, names[b]!);

  // ---- edges ----
  const kids: number[][] = new Array(V);
  const broken: string[][] = new Array(V);
  const indeg = new Int32Array(V);
  let edgeCount = 0;
  let edgesCapped = false;
  const validName = new Map<string, boolean>();
  const isValid = (s: string) => {
    let v = validName.get(s);
    if (v === undefined) {
      v = explainerNameSchema.safeParse(s).success;
      validName.set(s, v);
    }
    return v;
  };
  for (let i = 0; i < V; i++) {
    const seen = new Set<string>();
    const k: number[] = [];
    const b: string[] = [];
    for (const d of inputs[i]!.details) {
      if (seen.has(d)) continue;
      seen.add(d);
      const j = isValid(d) ? index.get(d) : undefined;
      if (j === undefined) {
        b.push(d);
        continue;
      }
      if (j === i) continue;
      if (edgeCount >= maxEdges) {
        edgesCapped = true;
        continue;
      }
      k.push(j);
      indeg[j]!++;
      edgeCount++;
    }
    kids[i] = k;
    broken[i] = b;
  }

  // ---- tops: rules 1 and 2 ----
  const top = new Uint8Array(V);
  for (let i = 0; i < V; i++) {
    const n = inputs[i]!;
    if ((n.group !== undefined && groupKey(n.group) !== '') || n.top === true || indeg[i] === 0) top[i] = 1;
  }

  // ---- rule 3: source components with no top (iterative Tarjan) ----
  const comp = tarjan(V, kids);
  const compCount = comp.count;
  const hasEdgeIn = new Uint8Array(compCount);
  const hasTop = new Uint8Array(compCount);
  for (let i = 0; i < V; i++) {
    if (top[i]) hasTop[comp.of[i]!] = 1;
    for (const j of kids[i]!) if (comp.of[j] !== comp.of[i]) hasEdgeIn[comp.of[j]!] = 1;
  }
  const nameCandidate = overviewCandidate(names);
  const candidateIndex = nameCandidate === undefined ? -1 : index.get(nameCandidate)!;
  const rep = new Int32Array(compCount).fill(-1);
  for (let i = 0; i < V; i++) {
    const c = comp.of[i]!;
    if (hasEdgeIn[c] || hasTop[c]) continue;
    const r = rep[c]!;
    if (r < 0) {
      rep[c] = i;
      continue;
    }
    if (r === candidateIndex) continue;
    if (i === candidateIndex) {
      rep[c] = i;
      continue;
    }
    const ki = kids[i]!.length;
    const kr = kids[r]!.length;
    if (ki > kr || (ki === kr && byName(names[i]!, names[r]!) < 0)) rep[c] = i;
  }
  for (const r of rep) if (r >= 0) top[r] = 1;

  const topList: number[] = [];
  for (let i = 0; i < V; i++) if (top[i]) topList.push(i);
  topList.sort(compareNodes);

  // ---- primary paths: multi-source BFS ----
  const via = new Int32Array(V).fill(-2); // -2 unvisited, -1 a top
  const depth = new Int32Array(V);
  // Each node's ancestor at depth min(depth, PREFIX - 1): a top-anchored prefix is walked from there, not from the node.
  const anc = new Int32Array(V);
  const queue = new Int32Array(V);
  let head = 0;
  let tail = 0;
  for (const t of topList) {
    via[t] = -1;
    anc[t] = t;
    queue[tail++] = t;
  }
  while (head < tail) {
    const u = queue[head++]!;
    for (const v of kids[u]!) {
      if (via[v] !== -2) continue;
      via[v] = u;
      depth[v] = depth[u]! + 1;
      anc[v] = depth[v]! < PREFIX ? v : anc[u]!;
      queue[tail++] = v;
    }
  }

  // ---- parents, sorted once ----
  const par: number[][] = Array.from({ length: V }, () => []);
  for (let i = 0; i < V; i++) for (const j of kids[i]!) par[j]!.push(i);
  for (const p of par) if (p.length > 1) p.sort(compareNodes);

  // ---- Start here ----
  let startHere = nameCandidate;
  if (startHere === undefined) {
    const withDetails = topList.filter((t) => kids[t]!.length > 0);
    if (withDetails.length === 1) startHere = names[withDetails[0]!];
  }

  const toNames = (list: readonly number[]) => list.map((i) => names[i]!);
  const empty: readonly string[] = [];
  return {
    names,
    has: (name) => index.has(name),
    children: (name) => {
      const i = index.get(name);
      return i === undefined ? empty : toNames(kids[i]!);
    },
    parents: (name) => {
      const i = index.get(name);
      return i === undefined ? empty : toNames(par[i]!);
    },
    brokenLinks: (name) => {
      const i = index.get(name);
      return i === undefined ? empty : broken[i]!;
    },
    isTop: (name) => {
      const i = index.get(name);
      return i !== undefined && top[i] === 1;
    },
    tops: toNames(topList),
    primaryPath: (name, max = MAX_PRIMARY_PATH) => {
      const i = index.get(name);
      if (i === undefined || via[i] === -2) return undefined;
      // Walked on demand from the node, or from its ancestor at depth PREFIX - 1 when the path is longer than `max`:
      // a 5,000-node chain must not cost a path per node.
      const from = depth[i]! < max ? i : max <= PREFIX ? anc[i]! : i;
      const path: string[] = [];
      for (let at = from; at >= 0; at = via[at]!) path.push(names[at]!);
      path.reverse();
      return path.length > max ? path.slice(0, Math.max(1, max)) : path;
    },
    trailTo: (name, max = MAX_PRIMARY_PATH) => {
      const i = index.get(name);
      if (i === undefined || via[i] === -2) return undefined;
      const path: string[] = [];
      for (let at = i; at >= 0 && path.length < max; at = via[at]!) path.push(names[at]!);
      return path.reverse();
    },
    pathLength: (name) => {
      const i = index.get(name);
      return i === undefined || via[i] === -2 ? undefined : depth[i]! + 1;
    },
    startHere,
    edgeCount,
    edgesCapped,
  };
}

/** Strongly connected components, iteratively (no recursion, so deep chains can't overflow the stack). */
function tarjan(V: number, kids: readonly (readonly number[])[]): { of: Int32Array; count: number } {
  const idx = new Int32Array(V).fill(-1);
  const low = new Int32Array(V);
  const onStack = new Uint8Array(V);
  const of = new Int32Array(V);
  const stack: number[] = [];
  const callNode: number[] = [];
  const callEdge: number[] = [];
  let counter = 0;
  let count = 0;
  for (let s = 0; s < V; s++) {
    if (idx[s] !== -1) continue;
    callNode.push(s);
    callEdge.push(0);
    idx[s] = low[s] = counter++;
    stack.push(s);
    onStack[s] = 1;
    while (callNode.length) {
      const top = callNode.length - 1;
      const u = callNode[top]!;
      const e = callEdge[top]!;
      const ks = kids[u]!;
      if (e < ks.length) {
        callEdge[top] = e + 1;
        const v = ks[e]!;
        if (idx[v] === -1) {
          idx[v] = low[v] = counter++;
          stack.push(v);
          onStack[v] = 1;
          callNode.push(v);
          callEdge.push(0);
        } else if (onStack[v] && idx[v]! < low[u]!) {
          low[u] = idx[v]!;
        }
        continue;
      }
      if (low[u] === idx[u]) {
        let w: number;
        do {
          w = stack.pop()!;
          onStack[w] = 0;
          of[w] = count;
        } while (w !== u);
        count++;
      }
      callNode.pop();
      callEdge.pop();
      const parent = callNode.at(-1);
      if (parent !== undefined && low[u]! < low[parent]!) low[parent] = low[u]!;
    }
  }
  return { of, count };
}

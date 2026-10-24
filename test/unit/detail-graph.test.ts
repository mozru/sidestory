import { describe, expect, it } from 'vitest';
import { buildDetailGraph, groupKey, mergeGroups, overviewCandidate, type GraphNodeInput } from '../../src/core/detail-graph.ts';

const n = (name: string, details: string[] = [], extra: Partial<GraphNodeInput> = {}): GraphNodeInput => ({ name, title: extra.title ?? name, details, ...extra });

describe('detail graph', () => {
  it('a top with nested details, in HTML order', () => {
    const g = buildDetailGraph([n('dma-overview', ['dma-fifo', 'dma-ctrl']), n('dma-ctrl', ['dma-fsm']), n('dma-fifo'), n('dma-fsm')]);
    expect(g.tops).toEqual(['dma-overview']);
    expect(g.children('dma-overview')).toEqual(['dma-fifo', 'dma-ctrl']);
    expect(g.primaryPath('dma-fsm')).toEqual(['dma-overview', 'dma-ctrl', 'dma-fsm']);
    expect(g.primaryPath('dma-overview')).toEqual(['dma-overview']);
    expect(g.startHere).toBe('dma-overview');
  });

  it('a shared detail appears under both parents', () => {
    const g = buildDetailGraph([n('b', ['shared'], { title: 'Beta' }), n('a', ['shared'], { title: 'Alpha' }), n('shared')]);
    expect(g.children('a')).toEqual(['shared']);
    expect(g.children('b')).toEqual(['shared']);
    expect(g.parents('shared')).toEqual(['a', 'b']); // by title
    expect(g.primaryPath('shared')).toEqual(['a', 'shared']); // the top whose title sorts first
  });

  it('group and top: true make a top even when linked', () => {
    const g = buildDetailGraph([n('root', ['grouped', 'flagged', 'plain']), n('grouped', [], { group: 'Storage' }), n('flagged', [], { top: true }), n('plain')]);
    expect(g.isTop('grouped')).toBe(true);
    expect(g.isTop('flagged')).toBe(true);
    expect(g.isTop('plain')).toBe(false);
    expect(g.parents('grouped')).toEqual(['root']);
    expect(g.primaryPath('grouped')).toEqual(['grouped']);
  });

  it('an empty group does not make a top', () => {
    const g = buildDetailGraph([n('root', ['x']), n('x', [], { group: '  ' })]);
    expect(g.isTop('x')).toBe(false);
  });

  describe('a cycle with no way in', () => {
    it('prefers the Start-here name candidate', () => {
      const g = buildDetailGraph([n('a', ['lsm-overview', 'b']), n('b', ['a']), n('lsm-overview', ['a'])]);
      expect(g.tops).toEqual(['lsm-overview']);
    });
    it('then the node with the most outgoing edges', () => {
      const g = buildDetailGraph([n('a', ['b']), n('b', ['a', 'c']), n('c', ['a'])]);
      expect(g.tops).toEqual(['b']);
    });
    it('then the first by name', () => {
      const g = buildDetailGraph([n('y', ['x']), n('x', ['y'])]);
      expect(g.tops).toEqual(['x']);
      expect(g.primaryPath('y')).toEqual(['x', 'y']);
    });
    it('a cycle reachable from a top gets no representative', () => {
      const g = buildDetailGraph([n('t', ['a']), n('a', ['b']), n('b', ['a'])]);
      expect(g.tops).toEqual(['t']);
    });
  });

  it('a cycle inside a top keeps its edges', () => {
    const g = buildDetailGraph([n('a', ['b']), n('b', ['c']), n('c', ['b'])]);
    expect(g.tops).toEqual(['a']);
    expect(g.children('c')).toEqual(['b']);
    expect(g.primaryPath('c')).toEqual(['a', 'b', 'c']);
    expect(g.parents('b')).toEqual(['a', 'c']);
  });

  it('drops self-links', () => {
    const g = buildDetailGraph([n('a', ['a', 'b']), n('b', ['b'])]);
    expect(g.children('a')).toEqual(['b']);
    expect(g.children('b')).toEqual([]);
    expect(g.isTop('a')).toBe(true);
    expect(g.edgeCount).toBe(1);
  });

  it('keeps broken links and invalid names, deduplicated', () => {
    const g = buildDetailGraph([n('a', ['missing', '../evil', 'b', 'missing', 'b', '', '.x'])]);
    expect(g.children('a')).toEqual([]);
    expect(g.brokenLinks('a')).toEqual(['missing', '../evil', 'b', '', '.x']);
    const h = buildDetailGraph([n('a', ['b', 'b']), n('b')]);
    expect(h.children('a')).toEqual(['b']);
    expect(h.brokenLinks('a')).toEqual([]);
  });

  it('orphans are tops with no details', () => {
    const g = buildDetailGraph([n('z'), n('m', [], { title: 'Alpha' })]);
    expect(g.tops).toEqual(['m', 'z']);
    expect(g.children('z')).toEqual([]);
  });

  it('tops sort by title, numeric-aware, then name', () => {
    const g = buildDetailGraph([n('a', [], { title: 'Step 10' }), n('b', [], { title: 'Step 2' }), n('c', [], { title: 'step 2' })]);
    expect(g.tops).toEqual(['b', 'c', 'a']);
  });

  it('unknown names', () => {
    const g = buildDetailGraph([n('a')]);
    expect(g.has('x')).toBe(false);
    expect(g.children('x')).toEqual([]);
    expect(g.primaryPath('x')).toBeUndefined();
    expect(g.isTop('x')).toBe(false);
  });

  it('caps edges', () => {
    const g = buildDetailGraph([n('a', ['b', 'c', 'd']), n('b'), n('c'), n('d')], { maxEdges: 2 });
    expect(g.edgeCount).toBe(2);
    expect(g.edgesCapped).toBe(true);
    expect(g.children('a')).toEqual(['b', 'c']);
    expect(g.isTop('d')).toBe(true); // still reachable: it lost its only in-edge
  });

  it('every node is reachable, along a shortest path (500 random graphs)', () => {
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x80000000;
    };
    for (let round = 0; round < 500; round++) {
      const size = 1 + Math.floor(rand() * 25);
      const names = Array.from({ length: size }, (_, i) => `n${i}`);
      const nodes = names.map((name) =>
        n(name, Array.from({ length: Math.floor(rand() * 4) }, () => (rand() < 0.1 ? 'ghost' : names[Math.floor(rand() * size)]!)), {
          group: rand() < 0.1 ? 'G' : undefined,
          title: `T${Math.floor(rand() * 5)}`,
        }),
      );
      const g = buildDetailGraph(nodes);
      // Independent BFS distances from the tops.
      const dist = new Map<string, number>(g.tops.map((t) => [t, 0]));
      const q = [...g.tops];
      while (q.length) {
        const u = q.shift()!;
        for (const v of g.children(u)) if (!dist.has(v)) (dist.set(v, dist.get(u)! + 1), q.push(v));
      }
      for (const name of names) {
        const p = g.primaryPath(name);
        expect(p, `${name} in round ${round}`).toBeDefined();
        expect(g.isTop(p![0]!)).toBe(true);
        expect(p!.at(-1)).toBe(name);
        for (let i = 1; i < p!.length; i++) expect(g.children(p![i - 1]!)).toContain(p![i]);
        expect(p!.length - 1).toBe(dist.get(name));
      }
      // Deterministic: the same input in the same order gives the same paths.
      const again = buildDetailGraph(nodes);
      for (const name of names) expect(again.primaryPath(name)).toEqual(g.primaryPath(name));
    }
  });

  it('ties go to the parent first in the HTML', () => {
    const g = buildDetailGraph([n('top', ['p2', 'p1']), n('p1', ['leaf']), n('p2', ['leaf']), n('leaf')]);
    expect(g.primaryPath('leaf')).toEqual(['top', 'p2', 'leaf']);
  });

  it('a layered DAG stays linear (16 layers × 8)', () => {
    const layers = Array.from({ length: 16 }, (_, l) => Array.from({ length: 8 }, (_, i) => `l${l}-${i}`));
    const nodes = layers.flatMap((layer, l) => layer.map((name) => n(name, layers[l + 1] ?? [])));
    const t0 = performance.now();
    const g = buildDetailGraph(nodes);
    for (const layer of layers) for (const name of layer) {
      g.primaryPath(name);
      g.parents(name);
    }
    const ms = performance.now() - t0;
    expect(g.tops).toHaveLength(8);
    expect(g.primaryPath('l15-3')).toHaveLength(16);
    expect(g.parents('l15-3')).toHaveLength(8);
    expect(ms).toBeLessThan(20 * 3);
  });

  it('5,000 nodes and 20,000 edges', () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed / 0x80000000);
    const names = Array.from({ length: 5000 }, (_, i) => `s${i}`);
    const nodes = names.map((name) => n(name, Array.from({ length: 4 }, () => names[Math.floor(rand() * 5000)]!)));
    // A long chain too, so an iterative Tarjan is required.
    const chain = Array.from({ length: 5000 }, (_, i) => n(`c${i}`, i < 4999 ? [`c${i + 1}`] : ['c0']));
    buildDetailGraph(nodes); // warm up
    const t0 = performance.now();
    const g = buildDetailGraph(nodes);
    const ms = performance.now() - t0;
    expect(g.edgeCount).toBeGreaterThan(19_000);
    expect(ms).toBeLessThan(50 * 3);
    const c = buildDetailGraph(chain);
    expect(c.tops).toEqual(['c0']);
    // Anchored at the top and cut to 16 names, walked on demand from a kept ancestor: no path per node is kept,
    // and a deep node costs no more than a shallow one.
    expect(c.primaryPath('c4999')).toEqual(Array.from({ length: 16 }, (_, i) => `c${i}`));
    expect(c.primaryPath('c4999', 17)).toEqual(Array.from({ length: 17 }, (_, i) => `c${i}`));
    expect(c.primaryPath('c4999', 5000)).toHaveLength(5000);
    expect(c.primaryPath('c4999', 5000)!.at(-1)).toBe('c4999');
    expect(c.primaryPath('c10')).toEqual(Array.from({ length: 11 }, (_, i) => `c${i}`));
    expect(c.pathLength('c4999')).toBe(5000);
    // The trail: the last 16 names, ending at the node.
    expect(c.trailTo('c4999')).toEqual(Array.from({ length: 16 }, (_, i) => `c${4984 + i}`));
    expect(c.trailTo('c3')).toEqual(['c0', 'c1', 'c2', 'c3']);
    const MAX_TRAIL_PLUS_ONE = 17;
    const t1 = performance.now();
    for (const x of chain) {
      c.primaryPath(x.name);
      c.primaryPath(x.name, MAX_TRAIL_PLUS_ONE);
      c.trailTo(x.name);
    }
    expect(performance.now() - t1).toBeLessThan(200);
  });
});

describe('groups', () => {
  it('match case-insensitively after collapsing whitespace', () => {
    expect(groupKey('  Big   Storage ')).toBe('big storage');
  });
  it('take the most common spelling, ties to the first by name, and sort by label', () => {
    const groups = mergeGroups([
      n('b', [], { group: 'storage' }),
      n('a', [], { group: 'Storage' }),
      n('c', [], { group: 'STORAGE' }),
      n('d', [], { group: 'STORAGE ' }),
      n('e', [], { group: 'Group 10' }),
      n('f', [], { group: 'Group 9' }),
      n('g', [], { group: 'x  y' }),
      n('h', [], { group: 'X y' }),
      n('i'),
    ]);
    expect(groups.map((g) => g.label)).toEqual(['Group 9', 'Group 10', 'STORAGE', 'x y']);
    expect(groups.find((g) => g.key === 'storage')!.members).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('Start here', () => {
  it('a sidestory named overview', () => {
    expect(buildDetailGraph([n('lsm-overview'), n('overview')]).startHere).toBe('overview');
  });
  it('the only *-overview', () => {
    expect(buildDetailGraph([n('a', ['dma-overview']), n('dma-overview')]).startHere).toBe('dma-overview');
  });
  it('the only top with details', () => {
    expect(buildDetailGraph([n('main', ['x']), n('x'), n('lonely')]).startHere).toBe('main');
  });
  it('two *-overview fall through to the single top with details', () => {
    expect(buildDetailGraph([n('a-overview', ['x']), n('b-overview'), n('x')]).startHere).toBe('a-overview');
    expect(overviewCandidate(['a-overview', 'b-overview'])).toBeUndefined();
  });
  it('none', () => {
    expect(buildDetailGraph([n('a', ['x']), n('b', ['y']), n('x'), n('y')]).startHere).toBeUndefined();
    expect(buildDetailGraph([]).startHere).toBeUndefined();
  });
});

// sidestory.openAt (docs/NAVIGATION-PLAN.md §7.5, §12.1): argument checks, which panel shows it, the recent list.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config, EventEmitter, Uri, workspace } from './vscode-stub.ts';

vi.mock('vscode', () => import('./vscode-stub.ts'));

const { Navigator, validateOpenAt, RECENT_KEY } = await import('../../src/extension/nav/open-at.ts');
const { refFromDir } = await import('../../src/extension/explainers.ts');

const ROOT = '/ws';
const dir = (name: string) => Uri.file(`${ROOT}/.sidestory/${name}`);
const ref = (name: string) => refFromDir(dir(name) as never)!;

interface Fake {
  ref: ReturnType<typeof ref>;
  trailRefs: ReturnType<typeof ref>[];
  preview: boolean;
  panel: { reveal: ReturnType<typeof vi.fn> };
  goTo: ReturnType<typeof vi.fn>;
  show: (trail: ReturnType<typeof ref>[], anchor?: string) => Promise<void>;
  onDidNavigate: EventEmitter<void>['event'];
  onDidDispose: EventEmitter<void>['event'];
  navigate(): void;
  close(): void;
}

function fake(trail: string[]): Fake {
  const nav = new EventEmitter<void>();
  const disposed = new EventEmitter<void>();
  const f: Fake = {
    ref: ref(trail.at(-1)!),
    trailRefs: trail.map(ref),
    preview: false,
    panel: { reveal: vi.fn() },
    goTo: vi.fn(),
    show: async (t) => {
      f.trailRefs = [...t];
      f.ref = t.at(-1)!;
    },
    onDidNavigate: nav.event,
    onDidDispose: disposed.event,
    navigate: () => {
      f.preview = false;
      nav.fire();
    },
    close: () => disposed.fire(),
  };
  return f;
}

let sessions: Fake[] = [];
let current: Fake | undefined;
let memory: Record<string, unknown> = {};
let started: Fake[] = [];
let nav: InstanceType<typeof Navigator>;

beforeEach(() => {
  workspace.root = Uri.file(ROOT);
  sessions = [];
  current = undefined;
  memory = {};
  started = [];
  for (const k of Object.keys(config)) delete config[k];
  nav = new Navigator({
    sessions: () => sessions as never,
    current: () => current as never,
    start: async (trail) => {
      const s = fake(trail.map((r) => r.name));
      sessions.push(s);
      started.push(s);
      current = s;
      nav.attach(s as never);
      return s as never;
    },
    memento: { get: (k: string, d: unknown) => (k in memory ? memory[k] : d), update: async (k: string, v: unknown) => void (memory[k] = v), keys: () => [] } as never,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const args = (name: string, extra: Record<string, unknown> = {}) => ({ dir: dir(name).toString(), ...extra });

describe('validateOpenAt', () => {
  it('refuses what isn’t a sidestory', () => {
    expect(validateOpenAt(undefined)).toBeUndefined();
    expect(validateOpenAt({ dir: 42 })).toBeUndefined();
    expect(validateOpenAt({ dir: Uri.file('/ws/src').toString() })).toBeUndefined();
    expect(validateOpenAt({ dir: Uri.file('/elsewhere/.sidestory/x').toString() })).toBeUndefined();
    expect(validateOpenAt({ dir: 'x'.repeat(5000) })).toBeUndefined();
  });
  it('keeps a valid trail, ending at the sidestory, each name once', () => {
    const v = validateOpenAt(args('c', { trail: ['a', 'b', 'a', 'c'], anchor: 'step-1' }))!;
    expect(v.trail.map((r) => r.name)).toEqual(['a', 'b', 'c']);
    expect(v.anchor).toBe('step-1');
    expect(validateOpenAt(args('c', { trail: ['a'] }))!.trail.map((r) => r.name)).toEqual(['a', 'c']);
  });
  it('drops the whole trail for any bad name, and a bad anchor id', () => {
    const v = validateOpenAt(args('c', { trail: ['a', '../x', 'c'], anchor: '1bad id' }))!;
    expect(v.trail.map((r) => r.name)).toEqual(['c']);
    expect(v.anchor).toBeUndefined();
    expect(validateOpenAt(args('c', { trail: 'a' }))!.trail.map((r) => r.name)).toEqual(['c']);
  });
  it('cuts a trail longer than 16 from the top', () => {
    const names = Array.from({ length: 20 }, (_, i) => `n${i}`);
    const v = validateOpenAt(args('n19', { trail: names }))!;
    expect(v.trail).toHaveLength(16);
    expect(v.trail.at(-1)!.name).toBe('n19');
    expect(v.trail[0]!.name).toBe('n4');
  });
  it('accepts only known sources and a boolean newPanel', () => {
    expect(validateOpenAt(args('a', { source: 'evil', newPanel: 'yes' }))).toMatchObject({ source: undefined, newPanel: false });
    expect(validateOpenAt(args('a', { source: 'tree', newPanel: true }))).toMatchObject({ source: 'tree', newPanel: true });
  });
});

describe('where it opens', () => {
  it('a panel already showing it: revealed there, at the step, its trail kept', async () => {
    const s = fake(['top', 'a']);
    sessions = [s];
    const got = await nav.openAt(args('a', { anchor: 'x', trail: ['a'] }));
    expect(got).toBe(s);
    expect(s.panel.reveal).toHaveBeenCalled();
    expect(s.goTo).toHaveBeenCalledWith('x');
    expect(s.goTo).toHaveBeenCalledTimes(1);
    expect(s.trailRefs.map((r) => r.name)).toEqual(['top', 'a']);
    expect(started).toHaveLength(0);
  });

  it('the current panel, when the target is under the same top', async () => {
    const s = fake(['top', 'a']);
    sessions = [s];
    current = s;
    expect(await nav.openAt(args('b', { trail: ['top', 'b'] }))).toBe(s);
    expect(s.trailRefs.map((r) => r.name)).toEqual(['top', 'b']);
  });

  it('else a new panel, which becomes the preview; the next open from a list reuses it', async () => {
    const reader = fake(['other']);
    sessions = [reader];
    current = reader;
    const p = await nav.openAt(args('a'));
    expect(started).toHaveLength(1);
    expect(p!.preview).toBe(true);
    expect(nav.preview).toBe(p);
    current = reader; // the reader went back to their own panel
    expect(await nav.openAt(args('b'))).toBe(p);
    expect(p!.ref.name).toBe('b');
    expect(started).toHaveLength(1);
  });

  it('reading in the preview ends its status: the next open gets a new panel', async () => {
    const p = (await nav.openAt(args('a'))) as unknown as Fake;
    p.navigate();
    expect(nav.preview).toBeUndefined();
    current = fake(['zzz']); // not the same top
    sessions.push(current);
    const q = await nav.openAt(args('b'));
    expect(q).not.toBe(p);
    expect(started).toHaveLength(2);
  });

  it('newPanel forces a new panel that isn’t a preview', async () => {
    const s = fake(['a']);
    sessions = [s];
    current = s;
    const n = await nav.openAt(args('a', { newPanel: true }));
    expect(n).not.toBe(s);
    expect(n!.preview).toBe(false);
  });

  it('a second open of the same tree item within 500 ms keeps the panel it opened', async () => {
    const p = await nav.openAt(args('a', { source: 'tree' }));
    expect(p!.preview).toBe(true);
    expect(await nav.openAt(args('a', { source: 'tree' }))).toBe(p);
    expect(p!.preview).toBe(false);
    expect(nav.preview).toBeUndefined();
  });

  it('a double-click arrives as two opens at once: the second waits for the first and keeps its panel', async () => {
    const first = nav.openAt(args('a', { source: 'tree' }));
    const second = nav.openAt(args('a', { source: 'tree' }));
    const [p, q] = await Promise.all([first, second]);
    expect(q).toBe(p);
    expect(started).toHaveLength(1);
    expect(p!.preview).toBe(false);
    expect(nav.preview).toBeUndefined();
  });

  it('with workbench.list.openMode doubleClick, every open from the tree keeps its panel', async () => {
    config['workbench.list.openMode'] = 'doubleClick';
    const p = await nav.openAt(args('a', { source: 'tree' }));
    expect(p!.preview).toBe(false);
    // Opened from elsewhere, still a preview.
    const reader = fake(['zzz']);
    sessions.push(reader);
    current = reader;
    const q = await nav.openAt(args('b', { source: 'lens' }));
    expect(q!.preview).toBe(true);
  });

  it('a section is set only while the panel still shows that sidestory (two opens racing for one panel)', async () => {
    const s = fake(['top', 'a']);
    sessions = [s];
    current = s;
    // The switch to b loses to a newer one (to c): show() returns without b on screen.
    s.show = async () => {
      s.trailRefs = [ref('top'), ref('c')];
      s.ref = ref('c');
    };
    await nav.openAt(args('b', { anchor: 'x', trail: ['top', 'b'] }));
    expect(s.goTo).not.toHaveBeenCalledWith('x');
  });

  it('a closed preview is forgotten', async () => {
    const p = (await nav.openAt(args('a'))) as unknown as Fake;
    sessions = sessions.filter((s) => s !== p);
    p.close();
    expect(nav.preview).toBeUndefined();
  });
});

describe('recently opened', () => {
  it('keeps 30, newest first, each once', () => {
    for (let i = 0; i < 35; i++) nav.noteOpened(ref(`s${i}`));
    nav.noteOpened(ref('s20'));
    const r = nav.recent();
    expect(r).toHaveLength(30);
    expect(r[0]).toBe(dir('s20').toString());
    expect(r[1]).toBe(dir('s34').toString());
    expect(new Set(r).size).toBe(30);
    expect(memory[RECENT_KEY]).toEqual(r);
  });
  it('ignores garbage in workspace state', () => {
    memory[RECENT_KEY] = [1, 'x', null];
    expect(nav.recent()).toEqual(['x']);
    memory[RECENT_KEY] = 'nope';
    expect(nav.recent()).toEqual([]);
  });
});

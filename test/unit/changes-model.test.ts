// The comparison's model and the walk order (docs/CHANGES-PLAN.md §9.3): status letters, path order, Next/Previous
// stepping and wrapping, the order Next/Previous Unexplained Change walks from the active editor, and the context
// keys package.json names.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { comparePaths, GitStatus, statusLetter, step } from '../../src/extension/changes/model.ts';
import { fileRanks, nextChange, orderChanges, walkPos, type OpenChange } from '../../src/extension/changes/order.ts';

describe('next and previous', () => {
  it('starts at the ends, steps, and wraps', () => {
    expect(step(3, -1, 1)).toEqual({ index: 0, wrapped: false });
    expect(step(3, -1, -1)).toEqual({ index: 2, wrapped: false });
    expect(step(3, 1, 1)).toEqual({ index: 2, wrapped: false });
    expect(step(3, 2, 1)).toEqual({ index: 0, wrapped: true });
    expect(step(3, 0, -1)).toEqual({ index: 2, wrapped: true });
    expect(step(0, -1, 1)).toBeUndefined();
  });

  it('path order is natural and per segment', () => {
    expect(['src/b10.ts', 'src/b2.ts', 'README.md', 'legacy/sleep.ts'].sort(comparePaths)).toEqual(['legacy/sleep.ts', 'README.md', 'src/b2.ts', 'src/b10.ts']);
  });
});

describe('Next/Previous Unexplained Change (§9.3)', () => {
  const changes: OpenChange[] = [
    { path: 'test/retry.test.ts', key: 't1', pos: 3 },
    { path: 'src/retry/retry.ts', key: 'r2', pos: 40 },
    { path: 'src/retry/retry.ts', key: 'r1', pos: 10 },
    { path: 'README.md', key: 'm1', pos: 1 },
  ];
  const paths = ['README.md', 'src/retry/retry.ts', 'test/retry.test.ts', 'src/retry/jitter.ts'];

  it('walks files in repo path order, by line within a file', () => {
    const rank = fileRanks(paths);
    expect(orderChanges(changes, rank).map((c) => c.key)).toEqual(['m1', 'r1', 'r2', 't1']);
  });

  it('puts files in the sidestory’s step order first, then the rest by path', () => {
    const rank = fileRanks(paths, ['test/retry.test.ts', 'src/retry/retry.ts', 'test/retry.test.ts', 'gone.ts']);
    expect(orderChanges(changes, rank).map((c) => c.key)).toEqual(['t1', 'r1', 'r2', 'm1']);
  });

  it('goes from the active editor’s cursor, wrapping at the ends', () => {
    const rank = fileRanks(paths);
    expect(nextChange(changes, rank, { path: 'src/retry/retry.ts', pos: 10 }, 1)).toEqual({ target: changes[1], wrapped: false });
    expect(nextChange(changes, rank, { path: 'src/retry/retry.ts', pos: 20 }, -1)?.target.key).toBe('r1');
    // Past the last: back to the first.
    expect(nextChange(changes, rank, { path: 'test/retry.test.ts', pos: 9 }, 1)).toEqual({ target: changes[3], wrapped: true });
    // A changed file with nothing open in it still has its place in the order.
    expect(nextChange(changes, rank, { path: 'src/retry/jitter.ts', pos: 1 }, 1)?.target.key).toBe('r1');
  });

  it('starts from the first (or last) when the active editor isn’t a changed file', () => {
    const rank = fileRanks(paths);
    expect(nextChange(changes, rank, undefined, 1)).toEqual({ target: changes[3], wrapped: false });
    expect(nextChange(changes, rank, { path: 'elsewhere.ts', pos: 5 }, -1)).toEqual({ target: changes[0], wrapped: false });
    expect(nextChange([], rank, undefined, 1)).toBeUndefined();
  });

  it('a move (pos 0) and a line-1 edit in one file are two stops, forward and backward', () => {
    const list: OpenChange[] = [
      { path: 'a.ts', key: 'move-x', pos: 0 },
      { path: 'a.ts', key: 'e1', pos: 1 },
      { path: 'b.ts', key: 'b1', pos: 1 },
    ];
    const rank = fileRanks(['a.ts', 'b.ts']);
    // From the move (lastWalk carries its key): the edit, then b.ts.
    expect(nextChange(list, rank, { path: 'a.ts', pos: 0, key: 'move-x' }, 1)?.target.key).toBe('e1');
    expect(nextChange(list, rank, { path: 'a.ts', pos: 1, key: 'e1' }, 1)?.target.key).toBe('b1');
    // Backward: b.ts, the edit, the move.
    expect(nextChange(list, rank, { path: 'b.ts', pos: 1, key: 'b1' }, -1)?.target.key).toBe('e1');
    expect(nextChange(list, rank, { path: 'a.ts', pos: 1, key: 'e1' }, -1)?.target.key).toBe('move-x');
    // Two changes at one position are told apart by key.
    const tied: OpenChange[] = [
      { path: 'a.ts', key: 'k1', pos: 5 },
      { path: 'a.ts', key: 'k2', pos: 5 },
    ];
    expect(nextChange(tied, rank, { path: 'a.ts', pos: 5, key: 'k1' }, 1)).toEqual({ target: tied[1], wrapped: false });
    expect(nextChange(tied, rank, { path: 'a.ts', pos: 5, key: 'k2' }, -1)).toEqual({ target: tied[0], wrapped: false });
    // A cursor in a lineless file (pos 0, no key) goes on past its move.
    expect(nextChange(list, rank, { path: 'a.ts', pos: 0 }, 1)?.target.key).toBe('e1');
  });

  it('whole-file changes sit at 0 like moves, so Next from a lineless file goes on to the next file', () => {
    expect(walkPos({ new: null, newAt: 1 }, true)).toBe(0);
    expect(walkPos({ move: {}, new: null, newAt: 1 }, false)).toBe(0);
    expect(walkPos({ new: { start: 7 }, newAt: 7 }, false)).toBe(7);
    expect(walkPos({ new: null, newAt: 4 }, false)).toBe(4);
    const list: OpenChange[] = [
      { path: 'logo.png', key: 'large-1', pos: walkPos({ new: null, newAt: 1 }, true) },
      { path: 'z.ts', key: 'z1', pos: 3 },
    ];
    const rank = fileRanks(['logo.png', 'z.ts']);
    // The cursor in the binary diff (pos 0, no key): the next stop is z.ts, not logo.png again.
    expect(nextChange(list, rank, { path: 'logo.png', pos: 0 }, 1)?.target.key).toBe('z1');
  });
});

describe('statuses', () => {
  it('maps the git API statuses to letters', () => {
    expect(statusLetter(GitStatus.INDEX_ADDED)).toBe('A');
    expect(statusLetter(GitStatus.UNTRACKED)).toBe('A');
    expect(statusLetter(GitStatus.MODIFIED)).toBe('M');
    expect(statusLetter(GitStatus.DELETED)).toBe('D');
    expect(statusLetter(GitStatus.INDEX_RENAMED)).toBe('R');
    expect(statusLetter(GitStatus.INDEX_COPIED)).toBe('C');
    expect(statusLetter(GitStatus.IGNORED)).toBeUndefined();
  });
});

describe('package.json', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

  it('every sidestory.changes.* key a when clause names is one the extension sets', () => {
    const text = JSON.stringify(pkg);
    const named = new Set([...text.matchAll(/"when":"([^"]*)"/g)].flatMap((m) => [...m[1]!.matchAll(/sidestory\.changes\.[A-Za-z]+/g)].map((k) => k[0])));
    const src = readFileSync('src/extension/changes/service.ts', 'utf8');
    const set = new Set([...src.matchAll(/setContext\('(sidestory\.changes\.[A-Za-z]+)'/g)].map((m) => m[1]));
    expect(named.size).toBeGreaterThan(2);
    for (const k of named) expect(set, k).toContain(k);
  });

  it('has no Changes view of its own: Sidestories, This File, then Comments', () => {
    expect(pkg.contributes.views.sidestory.map((v: { id: string }) => v.id)).toEqual(['sidestory.tree', 'sidestory.thisFile', 'sidestory.comments']);
    const commands = pkg.contributes.commands.map((c: { command: string }) => c.command);
    for (const gone of ['sidestory.showChanges', 'sidestory.changes.pickBase', 'sidestory.changes.filter', 'sidestory.changes.viewAsList', 'sidestory.changes.sort']) expect(commands).not.toContain(gone);
    for (const kept of ['sidestory.changes.nextUnexplained', 'sidestory.changes.nextFile', 'sidestory.changes.repinStep', 'sidestory.changes.setBase', 'sidestory.changes.markTrivial']) expect(commands).toContain(kept);
    expect(JSON.stringify(pkg.contributes)).not.toContain('view == sidestory.changes');
  });

  it('every command, setting, colour and view the README and the guide name exists, with its title', () => {
    const cmds = pkg.contributes.commands as { command: string; title: string; category?: string }[];
    const titles = new Set(cmds.map((c) => (c.category ? `${c.category}: ${c.title}` : c.title)));
    const bare = new Set(cmds.map((c) => c.title));
    const confs = Array.isArray(pkg.contributes.configuration) ? pkg.contributes.configuration : [pkg.contributes.configuration];
    const names = new Set<string>([
      ...confs.flatMap((c: { properties: Record<string, unknown> }) => Object.keys(c.properties)),
      ...pkg.contributes.colors.map((c: { id: string }) => c.id),
      ...Object.values(pkg.contributes.views).flat().map((v) => (v as { id: string }).id),
      ...cmds.map((c) => c.command),
    ]);
    // Bold words that read like a command but aren't one: a quick pick item, a shorthand in a table.
    const notCommands = new Set(['Use the Default Base', 'Previous…']);
    const commandLike = /^(Copy Prompt|Copy |Mark as|Re-pin|Re-anchor|Set Base|Next |Previous|Don't Suggest|Go to|Open |Show |Pin |Check |Enable |Revoke |Add Widget|Explain with)/;
    for (const doc of ['README.md', 'docs/GUIDE.md']) {
      const text = readFileSync(doc, 'utf8');
      for (const [, b] of text.matchAll(/\*\*([^*\n]+?)\*\*/g)) {
        if (b!.startsWith('Sidestory: ')) expect(titles, `${doc}: ${b}`).toContain(b);
        else if (commandLike.test(b!) && !notCommands.has(b!)) expect(bare, `${doc}: ${b}`).toContain(b);
      }
      for (const [, key] of text.matchAll(/`(sidestory\.[A-Za-z.]+)`/g)) if (key !== 'sidestory.html') expect(names, `${doc}: ${key}`).toContain(key);
    }
  });

  it('the guide names the Next/Previous keys package.json binds', () => {
    const guide = readFileSync('docs/GUIDE.md', 'utf8');
    const kbd = (chord: string) =>
      chord
        .split('+')
        .map((k) => `<kbd>${({ ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', cmd: 'Cmd', pagedown: 'PageDown', pageup: 'PageUp', down: 'Down', up: 'Up' } as Record<string, string>)[k] ?? k}</kbd>`)
        .join('+');
    const binds = (pkg.contributes.keybindings as { command: string; key: string; mac?: string }[]).filter((k) => k.command.startsWith('sidestory.changes.'));
    expect(binds.length).toBe(4);
    for (const b of binds) {
      for (const chord of [b.key, b.mac!]) {
        if (b.command.includes('.next')) expect(guide, `${b.command}: ${chord}`).toContain(kbd(chord));
        else {
          // Written as the next key's pair: "<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>PageDown</kbd> / <kbd>PageUp</kbd>".
          expect(guide, `${b.command}: ${chord}`).toContain(`${kbd(chord.split('+').slice(0, -1).join('+'))}+`);
          expect(guide, `${b.command}: ${chord}`).toContain(` / ${kbd(chord.split('+').at(-1)!)}`);
        }
      }
    }
  });

  it('the defaultBase setting describes the order the code uses', () => {
    const confs = Array.isArray(pkg.contributes.configuration) ? pkg.contributes.configuration : [pkg.contributes.configuration];
    // The base order the setting describes is the code's: pick, sidestory, recorded base, setting, remote default, main.
    const d = pkg.contributes.configuration.properties?.['sidestory.changes.defaultBase']?.markdownDescription ?? confs.map((c: { properties: Record<string, { markdownDescription?: string }> }) => c.properties['sidestory.changes.defaultBase']?.markdownDescription).find(Boolean);
    const at = (w: string) => d.indexOf(w);
    expect([at('Set Base'), at('sidestory added'), at('vscode-merge-base'), at('this setting'), at("remote's default"), at('`main`')].every((x, i, a) => x >= 0 && (i === 0 || x > a[i - 1]!))).toBe(true);
  });

  it('registers the decoration colours, and hides the writing commands in read-only mode', () => {
    const colors = pkg.contributes.colors.map((c: { id: string }) => c.id);
    expect(colors).toEqual(expect.arrayContaining(['sidestory.coverageDoneForeground', 'sidestory.coverageLeftForeground']));
    const menus = Object.values(pkg.contributes.menus).flat() as { command: string; when?: string }[];
    for (const m of menus.filter((x) => x.command === 'sidestory.changes.markTrivial' || x.command === 'sidestory.changes.repinStep')) expect(m.when).toContain('!sidestory.readOnly');
  });
});

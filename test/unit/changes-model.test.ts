// The comparison's model and the walk order (docs/CHANGES-PLAN.md §9.3): status letters, path order, Next/Previous
// stepping and wrapping, the order Next/Previous Unexplained Change walks from the active editor, and the context
// keys package.json names.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { comparePaths, GitStatus, statusLetter, step } from '../../src/extension/changes/model.ts';
import { fileRanks, nextChange, orderChanges, type OpenChange } from '../../src/extension/changes/order.ts';

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

  it('has no Changes view of its own: Sidestories, then This File', () => {
    expect(pkg.contributes.views.sidestory.map((v: { id: string }) => v.id)).toEqual(['sidestory.tree', 'sidestory.thisFile']);
    const commands = pkg.contributes.commands.map((c: { command: string }) => c.command);
    for (const gone of ['sidestory.showChanges', 'sidestory.changes.pickBase', 'sidestory.changes.filter', 'sidestory.changes.viewAsList', 'sidestory.changes.sort']) expect(commands).not.toContain(gone);
    for (const kept of ['sidestory.changes.nextUnexplained', 'sidestory.changes.nextFile', 'sidestory.changes.repinStep', 'sidestory.changes.setBase', 'sidestory.changes.markTrivial']) expect(commands).toContain(kept);
    expect(JSON.stringify(pkg.contributes)).not.toContain('view == sidestory.changes');
  });

  it('every "Sidestory: …" command and sidestory.* setting the README and the guide name exists, with its title', () => {
    const titles = new Set(pkg.contributes.commands.map((c: { title: string; category?: string }) => (c.category ? `${c.category}: ${c.title}` : c.title)));
    const confs = Array.isArray(pkg.contributes.configuration) ? pkg.contributes.configuration : [pkg.contributes.configuration];
    const settings = new Set(confs.flatMap((c: { properties: Record<string, unknown> }) => Object.keys(c.properties)));
    for (const doc of ['README.md', 'docs/GUIDE.md']) {
      const text = readFileSync(doc, 'utf8');
      for (const [, cmd] of text.matchAll(/\*\*(Sidestory: [^*]+?)\*\*/g)) expect(titles, `${doc}: ${cmd}`).toContain(cmd);
      for (const [, key] of text.matchAll(/`(sidestory\.[a-zA-Z]+\.[A-Za-z.]+|sidestory\.[a-zA-Z]+)`/g)) if (key !== 'sidestory.html') expect(settings, `${doc}: ${key}`).toContain(key);
    }
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

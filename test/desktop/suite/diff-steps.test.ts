// Desktop VS Code: steps of a sidestory with a base (docs/CHANGES-PLAN.md §7, §8, §9.10, §16.4, release 1b) on the
// git fixture's `--explained` copy, through the real git extension: a step opens the merge diff and its side editor
// gets the highlight (never dimmed), a base-side step highlights the left side (a read-only `sidestory-git:`
// document), and This File follows a diff side. (The cursor on the left side needs a real click: the e2e suite.)
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

const workspace = process.env.CX_WORKSPACE!;

interface Focus {
  active: string | undefined;
  uri?: string;
  range?: { start: number; end: number };
  dim?: boolean;
  note?: string;
}
const focus = async () => (await vscode.commands.executeCommand<Focus[]>('sidestory._focus'))[0];

async function until<T>(what: string, check: () => Promise<T | undefined | false> | T | undefined | false, timeout = 30_000): Promise<T> {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
const activeDiff = () => {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  return input instanceof vscode.TabInputTextDiff ? input : undefined;
};
const dir = () => vscode.Uri.file(`${workspace}/.sidestory/retry-jitter`).toString();

export function diffStepsTests(): void {
  describe(`Steps in diff editors on desktop VS Code ${vscode.version} (${process.platform})`, () => {
    before(async function () {
      this.timeout(90_000);
      await vscode.workspace.getConfiguration('diffEditor').update('useInlineViewWhenSpaceIsLimited', false, vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      // A sidestory with a base is in the workspace: coverage computes with nothing else asking.
      await until('coverage', async () => (await vscode.commands.executeCommand<{ belonging: string[] } | undefined>('sidestory._coverage'))?.belonging.length, 60_000);
    });

    it('computes the branch coverage the checker computes', async () => {
      const c = await vscode.commands.executeCommand<{ totals: Record<string, number>; files: [string, string[]][] }>('sidestory._coverage');
      assert.deepEqual({ explained: c.totals.explained, trivial: c.totals.trivial, left: c.totals.left }, { explained: 3, trivial: 2, left: 1 });
      assert.deepEqual(Object.fromEntries(c.files), {
        'legacy/sleep.ts': ['explained'],
        'src/retry/backoff.ts': ['trivial', 'trivial'], // its move from old/ too, covered by its trivial mark
        'src/retry/jitter.ts': ['explained'],
        'src/retry/retry.ts': ['explained'],
        'test/retry.test.ts': ['unexplained'],
      });
    });

    it('decorates the changed files and lists the sidestory under This branch', async () => {
      const c = await until('the marks', async () => {
        const v = await vscode.commands.executeCommand<{ marks: Record<string, { badge: string; tooltip: string }>; branch: { rows: { label: string; description?: string }[] } }>('sidestory._changes');
        return Object.keys(v.marks).length === 5 ? v : undefined;
      });
      assert.deepEqual(Object.fromEntries(Object.entries(c.marks).map(([p, m]) => [p, m.badge])), {
        'legacy/sleep.ts': '✓',
        'src/retry/backoff.ts': '–',
        'src/retry/jitter.ts': '✓',
        'src/retry/retry.ts': '✓',
        'test/retry.test.ts': '○',
      });
      assert.match(c.marks['src/retry/retry.ts']!.tooltip, /^1 of 1 change explained · Step \d of Retry with jitter · Details in This File$/);
      assert.deepEqual(c.branch.rows.map((r) => [r.label, r.description]), [
        ['Retry with jitter', 'vs main · 3 explained · 2 trivial · 1 left'],
        ['Copy Prompt: Update the Sidestory for New Changes', undefined],
      ]);
    });

    it('a head-side step opens the merge diff and highlights its right side, undimmed', async () => {
      await vscode.commands.executeCommand('sidestory.openAt', { dir: dir(), anchor: 'retry-loop' });
      const d = await until('the diff of retry.ts', () => (activeDiff()?.modified.path.endsWith('/src/retry/retry.ts') ? activeDiff() : undefined));
      assert.equal(d.original.scheme, 'sidestory-git');
      const f = await until('the highlight', async () => ((await focus())?.uri === d.modified.toString() ? focus() : undefined));
      assert.deepEqual(f.range, { start: 4, end: 9 });
      assert.equal(f.dim, false);
      // The side editor is a visible text editor (decorations apply to it).
      await until('the right side editor', () => vscode.window.visibleTextEditors.some((e) => e.document.uri.toString() === d.modified.toString()));
    });

    it('a base-side step highlights the left side: the merge-base blob, read-only', async () => {
      await vscode.commands.executeCommand('sidestory.openAt', { dir: dir(), anchor: 'old-sleep' });
      const d = await until('the diff of sleep.ts', () => (activeDiff()?.original.path.endsWith('/legacy/sleep.ts') ? activeDiff() : undefined));
      const f = await until('the highlight on the left', async () => ((await focus())?.uri === d.original.toString() ? focus() : undefined));
      assert.deepEqual(f.range, { start: 1, end: 24 });
      const left = await until('the left editor', () => vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === d.original.toString()));
      assert.equal(left.document.languageId, 'typescript');
      assert.equal(vscode.workspace.fs.isWritableFileSystem('sidestory-git'), false);
      // Nothing can write it back: the provider refuses writes.
      await assert.rejects(Promise.resolve(vscode.workspace.fs.writeFile(left.document.uri, new Uint8Array([120]))));
    });

    it('This File follows a diff side to its repository path', async () => {
      await vscode.commands.executeCommand('sidestory.thisFile.focus');
      await vscode.commands.executeCommand('sidestory.openAt', { dir: dir(), anchor: 'retry-loop' });
      const s = await until('This File on retry.ts', async () => {
        const t = await vscode.commands.executeCommand<{ description?: string; rows: string[] }>('sidestory._thisFile');
        return t.description === 'retry.ts' && t.rows.length ? t : undefined;
      });
      assert.equal(s.rows[0], 'Retry with jitter (vs main)');
      assert.match(s.rows[1]!, /^ {2}(● )?1 {2}The retry loop L4–9/);
      const readme = await vscode.workspace.openTextDocument(vscode.Uri.file(`${workspace}/README.md`));
      await vscode.window.showTextDocument(readme);
      await until('This File on README.md', async () => {
        const t = await vscode.commands.executeCommand<{ description?: string; rows: string[] }>('sidestory._thisFile');
        return t.description === 'README.md' && t.rows.length === 0;
      });
    });
  });
}

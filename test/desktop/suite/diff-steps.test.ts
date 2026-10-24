// Desktop VS Code: steps of a sidestory with a base (docs/CHANGES-PLAN.md §7, §8, §9.10, §16.4, release 1b) on the
// git fixture's `--explained` copy, through the real git extension. By default a step opens a plain editor (an added
// file too; removed code in a read-only view of the old file); Open Changes with Base switches a modified file to the
// merge diff at the same place (the step framed there, the panel following) and Open File goes back. With openStepsIn
// "diff", a step opens the merge diff and its side editor gets the highlight (never dimmed), a base-side step
// highlights the left side (a read-only `sidestory-git:` document), and This File follows a diff side. (The cursor
// on the left side needs a real click: the e2e suite.)
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

const workspace = process.env.CX_WORKSPACE!;

interface Focus {
  active: string | undefined;
  uri?: string;
  range?: { start: number; end: number };
  dim?: boolean;
  note?: string;
  label?: string;
  framed?: boolean;
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

    it('by default a step opens the file itself: highlighted, faded around, no diff', async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.commands.executeCommand('sidestory.openAt', { dir: dir(), anchor: 'retry-loop' });
      const file = vscode.Uri.file(`${workspace}/src/retry/retry.ts`).toString();
      const f = await until('the highlight in retry.ts', async () => ((await focus())?.uri === file ? focus() : undefined));
      assert.deepEqual(f.range, { start: 4, end: 9 });
      assert.equal(f.framed, false);
      assert.equal(activeDiff(), undefined);
      await until('a plain editor of retry.ts', () => vscode.window.visibleTextEditors.some((e) => e.document.uri.toString() === file));
    });

    it('a step in a file the branch added opens a plain editor, not an all-green diff', async () => {
      await vscode.commands.executeCommand('sidestory.openAt', { dir: dir(), anchor: 'jitter' });
      const file = vscode.Uri.file(`${workspace}/src/retry/jitter.ts`).toString();
      const f = await until('the highlight in jitter.ts', async () => ((await focus())?.uri === file ? focus() : undefined));
      assert.deepEqual(f.range, { start: 1, end: 19 });
      assert.equal(activeDiff(), undefined);
      const tab = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === file);
      assert.ok(tab, 'a text tab of jitter.ts');
    });

    it('a base-side step opens the old file read-only in a plain editor', async () => {
      await vscode.commands.executeCommand('sidestory.openAt', { dir: dir(), anchor: 'old-sleep' });
      const f = await until('the highlight in the old sleep.ts', async () => {
        const v = await focus();
        return v?.uri?.startsWith('sidestory-git:') && v.uri.includes('/legacy/sleep.ts') ? v : undefined;
      });
      assert.deepEqual(f.range, { start: 1, end: 24 });
      assert.equal(activeDiff(), undefined);
      const ed = await until('the old file’s editor', () => vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === f.uri));
      assert.equal(ed.document.languageId, 'typescript');
    });

    it('Open Changes with Base is offered for a modified or renamed file, not an added, deleted or unchanged one', async () => {
      const c = await vscode.commands.executeCommand<{ comparable: string[] }>('sidestory._changes');
      const at = (p: string) => vscode.Uri.file(`${workspace}/${p}`).fsPath;
      assert.ok(c.comparable.includes(at('src/retry/retry.ts')), 'retry.ts (modified)');
      assert.ok(c.comparable.includes(at('src/retry/backoff.ts')), 'backoff.ts (renamed)');
      assert.ok(!c.comparable.includes(at('src/retry/jitter.ts')), 'jitter.ts (added)');
      assert.ok(!c.comparable.includes(at('README.md')), 'README.md (unchanged)');
      // A deleted file's old side neither: its diff is all red.
      assert.ok(!c.comparable.some((k) => k.replace(/\\/g, '/').endsWith('/legacy/sleep.ts')), 'legacy/sleep.ts (deleted)');
      // Run on an added file anyway (the palette), it opens nothing.
      const jitter = await vscode.window.showTextDocument(vscode.Uri.file(`${workspace}/src/retry/jitter.ts`));
      await vscode.commands.executeCommand('sidestory.changes.openChangesWithBase', jitter.document.uri);
      assert.equal(activeDiff(), undefined);
    });

    it('Open Changes with Base opens the merge diff in the same column at the same line, and the step gets the diff frame', async () => {
      // (The panel following the cursor there needs a real click: the e2e suite.)
      await vscode.commands.executeCommand('sidestory.openAt', { dir: dir(), anchor: 'retry-loop' });
      const file = vscode.Uri.file(`${workspace}/src/retry/retry.ts`);
      await until('the step in retry.ts', async () => (await focus())?.uri === file.toString());
      const shown = await until('its editor', () => vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === file.toString()));
      const plain = await vscode.window.showTextDocument(shown.document, { viewColumn: shown.viewColumn, selection: new vscode.Range(15, 0, 15, 0) });
      const column = plain.viewColumn;
      await vscode.commands.executeCommand('sidestory.changes.openChangesWithBase', file);
      const d = await until('the diff of retry.ts', () => (activeDiff()?.modified.toString() === file.toString() ? activeDiff() : undefined));
      assert.equal(d.original.scheme, 'sidestory-git');
      const right = await until('the right side, active', () => (vscode.window.activeTextEditor?.document.uri.toString() === file.toString() ? vscode.window.activeTextEditor : undefined));
      assert.equal(right.selection.active.line, 15);
      assert.equal(vscode.window.tabGroups.activeTabGroup.viewColumn, column);
      const f = await until('the step framed in the diff', async () => ((await focus())?.framed ? focus() : undefined));
      assert.equal(f.active, 'retry-loop');
      assert.match(f.label ?? '', /^◀ Step \d+ · The retry loop$/);
    });

    it('Open File (the git extension’s, in the diff’s title bar) goes back to the file at the same line', async () => {
      const file = vscode.Uri.file(`${workspace}/src/retry/retry.ts`);
      const line = vscode.window.activeTextEditor!.selection.active.line;
      await vscode.commands.executeCommand('git.openFile', file);
      await until('a plain editor of retry.ts', () => !activeDiff() && vscode.window.activeTextEditor?.document.uri.toString() === file.toString());
      assert.equal(vscode.window.activeTextEditor!.selection.active.line, line);
      assert.equal((await focus())?.framed, false);
    });

    it('in committed mode, Sidestory’s own Open File goes back from a diff whose right side is from git', async function () {
      this.timeout(60_000);
      const conf = vscode.workspace.getConfiguration('sidestory.changes');
      // No open file: an open working tree file of a changed path gets the button in committed mode too (its HEAD diff).
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await conf.update('includeUncommitted', false, vscode.ConfigurationTarget.Global);
      try {
        await until('the committed comparison', async () => {
          const c = await vscode.commands.executeCommand<{ comparable: string[] }>('sidestory._changes');
          return c.comparable.includes('/src/retry/retry.ts') && !c.comparable.includes(vscode.Uri.file(`${workspace}/src/retry/retry.ts`).fsPath);
        });
        await vscode.commands.executeCommand('sidestory.openAt', { dir: dir(), anchor: 'retry-loop' });
        const f = await until('the step in HEAD’s retry.ts', async () => {
          const v = await focus();
          return v?.uri?.startsWith('sidestory-git:') && v.uri.includes('/src/retry/retry.ts') ? v : undefined;
        });
        const blob = vscode.Uri.parse(f.uri!);
        const ed = await until('its editor', () => vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === f.uri));
        await vscode.window.showTextDocument(ed.document, { viewColumn: ed.viewColumn, selection: new vscode.Range(6, 0, 6, 0) });
        await vscode.commands.executeCommand('sidestory.changes.openChangesWithBase', blob);
        const d = await until('the committed diff', () => (activeDiff()?.modified.toString() === f.uri ? activeDiff() : undefined));
        assert.equal(d.modified.scheme, 'sidestory-git');
        await until('the right side, active', () => vscode.window.activeTextEditor?.document.uri.toString() === f.uri);
        await vscode.commands.executeCommand('sidestory.changes.openFile', blob);
        await until('the blob in a plain editor', () => !activeDiff() && vscode.window.activeTextEditor?.document.uri.toString() === f.uri);
        assert.equal(vscode.window.activeTextEditor!.selection.active.line, 6);
      } finally {
        await conf.update('includeUncommitted', undefined, vscode.ConfigurationTarget.Global);
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      }
    });

    it('once the reader switched a file to its diff, a later step in it stays in the diff', async function () {
      this.timeout(60_000);
      const file = vscode.Uri.file(`${workspace}/src/retry/retry.ts`);
      await until('the working tree comparison again', async () => {
        const c = await vscode.commands.executeCommand<{ comparable: string[] }>('sidestory._changes');
        return c.comparable.includes(file.fsPath);
      });
      await vscode.commands.executeCommand('sidestory.openAt', { dir: dir(), anchor: 'retry-loop' });
      await until('the step in retry.ts', async () => (await focus())?.uri === file.toString());
      await vscode.commands.executeCommand('sidestory.changes.openChangesWithBase', file);
      await until('the diff of retry.ts', () => activeDiff()?.modified.toString() === file.toString());
      await vscode.commands.executeCommand('sidestory.openAt', { dir: dir(), anchor: 'jitter' });
      await until('the jitter step', async () => (await focus())?.active === 'jitter');
      // jitter.ts is another file: it opened plain beside or over the diff. Back to the retry loop: its diff again.
      await vscode.commands.executeCommand('sidestory.changes.openChangesWithBase', file);
      await until('the diff of retry.ts', () => activeDiff()?.modified.toString() === file.toString());
      await vscode.commands.executeCommand('sidestory.openAt', { dir: dir(), anchor: 'retry-loop' });
      const f = await until('the step framed in the diff', async () => {
        const v = await focus();
        return v?.active === 'retry-loop' && v.framed ? v : undefined;
      });
      assert.equal(f.dim, false);
      assert.equal(activeDiff()?.modified.toString(), file.toString());
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });
  });

  describe(`Steps with openStepsIn "diff" on desktop VS Code ${vscode.version} (${process.platform})`, () => {
    before(async () => {
      await vscode.workspace.getConfiguration('sidestory.changes').update('openStepsIn', 'diff', vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });
    after(async () => {
      await vscode.workspace.getConfiguration('sidestory.changes').update('openStepsIn', undefined, vscode.ConfigurationTarget.Global);
    });

    it('a head-side step opens the merge diff and highlights its right side, undimmed', async () => {
      await vscode.commands.executeCommand('sidestory.openAt', { dir: dir(), anchor: 'retry-loop' });
      const d = await until('the diff of retry.ts', () => (activeDiff()?.modified.path.endsWith('/src/retry/retry.ts') ? activeDiff() : undefined));
      assert.equal(d.original.scheme, 'sidestory-git');
      // The side editor is a visible text editor (decorations apply to it); once it shows, the step is framed there.
      await until('the right side editor', () => vscode.window.visibleTextEditors.some((e) => e.document.uri.toString() === d.modified.toString()));
      const f = await until('the highlight, framed', async () => {
        const v = await focus();
        return v?.uri === d.modified.toString() && v.framed ? v : undefined;
      });
      assert.deepEqual(f.range, { start: 4, end: 9 });
      assert.equal(f.dim, false);
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

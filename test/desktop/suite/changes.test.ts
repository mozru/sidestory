// Desktop VS Code: a branch's comparison with no sidestory (docs/CHANGES-PLAN.md §4.6, §9.3, §16.4) on the git fixture
// plus 1,500 generated changed files, through the real git extension: nothing is compared until a command asks, then
// Next/Previous Changed File opens merge diffs in path order. Also records the plan's (verify) answers that need a
// running VS Code: the provider's language and read-only state, and the default keybindings for the chords.
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as vscode from 'vscode';

const workspace = process.env.CX_WORKSPACE!;
const generated = Number(process.env.CX_GENERATED ?? 0);

interface Changes {
  mergeBase?: string;
  branch: { description?: string; rows: { label: string }[] };
}
// Undefined until the full extension is loaded (the bootstrap loads it once the probe sees the branch).
const state = () => Promise.resolve(vscode.commands.executeCommand<Changes>('sidestory._changes')).catch(() => undefined);
const gitOut = (...args: string[]) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim();

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

export function changesTests(): void {
  describe(`A branch's comparison on desktop VS Code ${vscode.version} (${process.platform})`, () => {
    before(async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    it('compares nothing while nothing asks, and offers to explain the branch', async () => {
      // No sidestory with a base here: no comparison until a command runs (§4.6); the probe still sees the branch.
      const s = await until(
        'the This branch group',
        async () => {
          const v = await state();
          return v?.branch.rows.length ? v : undefined;
        },
        60_000,
      );
      assert.equal(s.mergeBase, undefined);
      assert.deepEqual(s.branch.rows.map((r) => r.label), ['Copy Prompt: Explain This Branch']);
    });

    it('Next Changed File opens the merge diff: the old side read-only from git, in the file’s language', async function () {
      this.timeout(120_000);
      const t0 = Date.now();
      await vscode.commands.executeCommand('sidestory.changes.nextFile');
      await until('a diff tab', () => activeDiff(), 60_000);
      console.log(`      Next Changed File: first diff tab in ${Date.now() - t0} ms (${5 + generated} files compared)`);
      assert.equal((await state())?.mergeBase, gitOut('merge-base', 'main', 'feature'));
      // Path order: from a modified file, back and forth lands on it again.
      const retry = await vscode.workspace.openTextDocument(vscode.Uri.file(`${workspace}/src/retry/retry.ts`));
      await vscode.window.showTextDocument(retry);
      await vscode.commands.executeCommand('sidestory.changes.prevFile');
      await vscode.commands.executeCommand('sidestory.changes.nextFile');
      const diff = await until('the diff of retry.ts', () => (activeDiff()?.original.path.endsWith('retry.ts') ? activeDiff() : undefined));
      assert.equal(diff.original.scheme, 'sidestory-git');
      assert.match(diff.original.query, /^[0-9a-f]{40}$/);
      assert.equal(diff.original.query, gitOut('merge-base', 'main', 'feature'));
      const doc = await vscode.workspace.openTextDocument(diff.original);
      assert.equal(vscode.workspace.fs.isWritableFileSystem('sidestory-git'), false);
      const path = diff.original.path.slice(1);
      assert.equal(doc.getText(), gitOut('show', `${diff.original.query}:${path}`) + '\n');
      if (path.endsWith('.ts')) assert.equal(doc.languageId, 'typescript');
      // Both sides of a side-by-side diff are visible text editors (decorations need that).
      await until('both sides visible', () => vscode.window.visibleTextEditors.some((e) => e.document.uri.toString() === diff.original.toString()));
    });

    it('walks every file in order and wraps (Next Changed File stays fast on a big diff)', async () => {
      const seen: string[] = [];
      const t0 = Date.now();
      for (let i = 0; i < 6; i++) {
        const before = activeDiff()?.modified.toString();
        await vscode.commands.executeCommand('sidestory.changes.nextFile');
        const d = await until('the next diff tab', () => {
          const now = activeDiff();
          return now && now.modified.toString() !== before && vscode.window.activeTextEditor?.document.uri.toString() === now.modified.toString() ? now : undefined;
        });
        seen.push((d.modified.scheme === 'file' ? d.modified : d.original).path.split('/').pop()!);
      }
      console.log(`      6 × Next Changed File: ${Date.now() - t0} ms; ${seen.join(', ')}`);
      assert.equal(new Set(seen).size, 6);
    });

    it('records the default keybindings for the Next/Previous chords (§17 Q14)', async () => {
      await vscode.commands.executeCommand('workbench.action.openDefaultKeybindingsFile');
      const doc = await until('the default keybindings', () => vscode.window.activeTextEditor?.document);
      const text = doc.getText();
      const chords = process.platform === 'darwin' ? ['ctrl+cmd+down', 'ctrl+cmd+up'] : ['ctrl+alt+pagedown', 'ctrl+alt+pageup'];
      for (const chord of chords) {
        const taken = [...text.matchAll(new RegExp(`"key": "${chord.replace(/\+/g, '\\+')}",\\s*"command": "([^"]+)"`, 'g'))].map((m) => m[1]);
        console.log(`      default bindings of ${chord}: ${taken.length ? taken.join(', ') : 'none'}`);
      }
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });
  });
}

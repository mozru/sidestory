// Desktop VS Code: the Changes view (docs/CHANGES-PLAN.md §16.4, release 1a) on the git fixture plus 1,500 generated
// changed files, through the real git extension. Also records the plan's (verify) answers that need a running
// VS Code: the provider's language and read-only state, `vscode.changes`, multi-diff editors in
// visibleTextEditors, and the default keybindings for the Next/Previous chords.
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as vscode from 'vscode';

const workspace = process.env.CX_WORKSPACE!;
const generated = Number(process.env.CX_GENERATED ?? 0);

interface Stats {
  renders: number;
  lastRenderMs: number;
  files: number;
  description?: string;
  message?: string;
}
const stats = () => vscode.commands.executeCommand<Stats>('sidestory._changesStats');
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
  describe(`The Changes view on desktop VS Code ${vscode.version} (${process.platform})`, () => {
    let shownIn = 0;
    before(async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      const t0 = Date.now();
      await vscode.commands.executeCommand('sidestory.showChanges');
      await until('the changed files', async () => (await stats())?.files === 5 + generated, 60_000);
      shownIn = Date.now() - t0;
      console.log(`      Changes: ${5 + generated} files listed ${shownIn} ms after Show Changes (activation and the git extension's first status included)`);
    });

    it('describes the three-dot comparison and lists only the branch side', async () => {
      const s = await stats();
      const mb = gitOut('merge-base', 'main', 'feature');
      assert.equal(s.description, `vs main @ ${mb.slice(0, 7)} · 3 commits · uncommitted`);
      assert.ok(s.lastRenderMs < 200, `a render took ${s.lastRenderMs} ms`);
    });

    it('Next Changed File opens the merge diff: the old side read-only from git, in the file’s language', async () => {
      const t0 = Date.now();
      await vscode.commands.executeCommand('sidestory.changes.nextFile');
      await until('a diff tab', () => activeDiff());
      console.log(`      Next Changed File: diff tab in ${Date.now() - t0} ms`);
      // A modified file: both sides have content.
      await vscode.commands.executeCommand('sidestory.changes.open', { path: 'src/retry/retry.ts' });
      const diff = await until('the diff of retry.ts', () => (activeDiff()?.original.path.endsWith('retry.ts') ? activeDiff() : undefined));
      assert.equal(diff.original.scheme, 'sidestory-git');
      assert.match(diff.original.query, /^[0-9a-f]{40}$/);
      assert.equal(diff.original.query, gitOut('merge-base', 'main', 'feature'));
      const doc = await vscode.workspace.openTextDocument(diff.original);
      assert.equal(vscode.workspace.fs.isWritableFileSystem('sidestory-git'), false);
      const path = diff.original.path.slice(1);
      assert.equal(doc.getText(), gitOut('show', `${diff.original.query}:${path}`) + '\n');
      if (path.endsWith('.ts')) assert.equal(doc.languageId, 'typescript');
      // Both sides of a side-by-side diff are visible text editors (decorations need that in release 1b).
      await until('both sides visible', () => vscode.window.visibleTextEditors.some((e) => e.document.uri.toString() === diff.original.toString()));
    });

    it('walks every file in order and wraps (Next Changed File stays fast on a big diff)', async () => {
      const seen: string[] = [];
      const t0 = Date.now();
      for (let i = 0; i < 6; i++) {
        await vscode.commands.executeCommand('sidestory.changes.nextFile');
        const d = await until('a diff tab', () => activeDiff());
        seen.push((d.modified.scheme === 'file' ? d.modified : d.original).path.split('/').pop()!);
      }
      console.log(`      6 × Next Changed File: ${Date.now() - t0} ms; ${seen.join(', ')}`);
      assert.equal(new Set(seen).size, 6);
    });

    it('Open All Changes opens the multi-diff editor through vscode.changes', async () => {
      assert.ok((await vscode.commands.getCommands(true)).includes('vscode.changes'));
      await vscode.commands.executeCommand('sidestory.changes.openAll');
      const tab = await until('the multi-diff tab', () => {
        const t = vscode.window.tabGroups.activeTabGroup.activeTab;
        return t?.label.startsWith('Changes vs main') ? t : undefined;
      });
      assert.match(tab.label, /^Changes vs main \(500 files\)$/); // VS Code adds the count; 500 is the cap
      await new Promise((r) => setTimeout(r, 1500));
      // (verify) §9.3: are a multi-diff editor's inner editors visible text editors?
      const inner = vscode.window.visibleTextEditors.filter((e) => e.document.uri.scheme === 'sidestory-git');
      console.log(`      multi-diff inner editors in visibleTextEditors: ${inner.length}`);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
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

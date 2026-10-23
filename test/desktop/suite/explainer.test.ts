// Desktop VS Code: the extension end to end through VS Code's own API (tabs, editors, files on disk), on
// whatever OS this runs on, with the workspace's line endings set by the runner (CX_EOL = lf | crlf).
import * as assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';

const EXTENSION_ID = 'sidestory.sidestory';
const VIEW_TYPE = 'sidestory.explainer';
const workspace = process.env.CX_WORKSPACE!;
const eol = process.env.CX_EOL ?? 'lf';
const explainerDir = vscode.Uri.file(join(workspace, '.explain', 'bit-reader'));
const manifestPath = join(workspace, '.explain', 'bit-reader', 'manifest.json');
const caseInsensitiveFs = process.platform === 'win32' || process.platform === 'darwin';

interface Manifest {
  anchors: Record<string, { file: string; range: [number, number] }>;
}
const manifest = (): Manifest => JSON.parse(readFileSync(manifestPath, 'utf8'));

/** What the editors show, for timeout messages. */
const showing = () =>
  vscode.window.visibleTextEditors.map((e) => `${vscode.workspace.asRelativePath(e.document.uri)} lines ${e.visibleRanges.map((r) => `${r.start.line + 1}-${r.end.line + 1}`).join(',')}`).join('; ') || 'no text editors';

async function until<T>(what: string, check: () => T | undefined | false, timeout = 30_000): Promise<T> {
  const end = Date.now() + timeout;
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what} (showing: ${showing()})`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const explainerTabs = () =>
  vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.includes(VIEW_TYPE));

/** The visible editor showing an anchored file whose visible lines include that anchor's first line (1-based). */
function editorShowingLine(file: string, line: number): vscode.TextEditor | undefined {
  return vscode.window.visibleTextEditors.find(
    (e) => e.document.uri.fsPath.toLowerCase().endsWith(file.replace(/\//g, process.platform === 'win32' ? '\\' : '/').toLowerCase()) &&
      e.visibleRanges.some((r) => r.start.line <= line - 1 && line - 1 <= r.end.line),
  );
}

export function explainerTests(): void {
  describe(`Sidestory on desktop VS Code (${process.platform}, ${eol.toUpperCase()})`, () => {
    before(async () => {
      const ext = vscode.extensions.getExtension(EXTENSION_ID);
      assert.ok(ext, 'extension is installed in the development host');
      await ext.activate();
    });

    after(async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    it('opens an explainer beside the editor', async () => {
      await vscode.commands.executeCommand('sidestory.open', explainerDir);
      await until('the explainer panel', () => explainerTabs().length === 1);
    });

    it('stepping reveals each anchor’s code', async () => {
      const anchors = manifest().anchors;
      // The panel starts at the first step; walk forward and check each step's code comes into view.
      for (const id of ['state', 'handshakes', 'consume', 'refill']) {
        await vscode.commands.executeCommand('sidestory.nextStep');
        const a = anchors[id]!;
        await until(`${id} (${a.file}:${a.range[0]}) in view`, () => editorShowingLine(a.file, a.range[0]));
      }
    });

    it('sections follow the code through unsaved edits', async () => {
      const a = manifest().anchors.refill!;
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(join(workspace, a.file)));
      assert.equal(doc.eol, eol === 'crlf' ? vscode.EndOfLine.CRLF : vscode.EndOfLine.LF, 'the runner set up the expected line endings');
      const edit = new vscode.WorkspaceEdit();
      const nl = eol === 'crlf' ? '\r\n' : '\n';
      edit.insert(doc.uri, new vscode.Position(0, 0), `// one${nl}// two${nl}// three${nl}`);
      assert.ok(await vscode.workspace.applyEdit(edit));
      // Back one step and forward again: the refill section must now reveal its code 3 lines lower.
      await vscode.commands.executeCommand('sidestory.prevStep');
      await vscode.commands.executeCommand('sidestory.nextStep');
      await until('refill code, moved down 3 lines, in view', () => editorShowingLine(a.file, a.range[0] + 3));
    });

    it('Pin Anchors records the moved ranges and keeps the manifest’s line endings', async () => {
      const before = manifest().anchors.refill!.range;
      const rawBefore = readFileSync(manifestPath, 'utf8');
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath.toLowerCase().endsWith('bit_reader.sv'))!;
      assert.ok(await doc.save(), 'saved the edited code');
      await vscode.commands.executeCommand('sidestory.pin');
      await until('the manifest rewritten with the new range', () => manifest().anchors.refill!.range[0] === before[0] + 3);
      const raw = readFileSync(manifestPath, 'utf8');
      assert.equal(raw.includes('\r\n'), rawBefore.includes('\r\n'), 'line endings kept');
    });

    (caseInsensitiveFs ? it : it.skip)('a manifest path in different letter case still links the code', async () => {
      // Rewrite one anchor's file as RTL/BIT_READER.SV: the same file on macOS and Windows.
      const raw = readFileSync(manifestPath, 'utf8');
      const a = manifest().anchors.refill!;
      writeFileSync(manifestPath, raw.replace(`"${a.file}"`, `"${a.file.toUpperCase()}"`));
      try {
        await vscode.commands.executeCommand('sidestory.prevStep');
        await vscode.commands.executeCommand('sidestory.nextStep');
        await until('refill code in view through the upper-case path', () => editorShowingLine(a.file, manifest().anchors.refill!.range[0]));
      } finally {
        writeFileSync(manifestPath, raw);
      }
    });

    (caseInsensitiveFs ? it : it.skip)('opening the same explainer with different letter case reuses its panel', async () => {
      const upper = vscode.Uri.file(explainerDir.fsPath.replace(/bit-reader$/, 'BIT-READER'));
      await vscode.commands.executeCommand('sidestory.open', upper);
      await new Promise((r) => setTimeout(r, 1500));
      assert.equal(explainerTabs().length, 1, 'no second panel for the same folder');
    });
  });
}

// Desktop VS Code: navigation (docs/NAVIGATION-PLAN.md §12.4). CodeLens through VS Code's own command, openAt with a
// trail, the rename (only .sidestory/ counts), and with CX_PERF=1 a perf smoke over a generated workspace.
import * as assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';

const workspace = process.env.CX_WORKSPACE!;
const eol = process.env.CX_EOL ?? 'lf';
const nl = eol === 'crlf' ? '\r\n' : '\n';
const bitReader = vscode.Uri.file(join(workspace, 'rtl', 'bit_reader.sv'));
const caseInsensitiveFs = process.platform === 'win32' || process.platform === 'darwin';

interface Stats {
  sidestories: number;
  anchors: number;
  steps: number;
  state: string;
}
const stats = () => vscode.commands.executeCommand<Stats>('sidestory._indexStats');

async function until<T>(what: string, check: () => Promise<T | undefined | false> | T | undefined | false, timeout = 20_000): Promise<T> {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

const lensesOf = async (uri: vscode.Uri) => (await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', uri)) ?? [];
const ours = (lenses: vscode.CodeLens[]) => lenses.filter((l) => l.command?.command === 'sidestory.openAt' || l.command?.command === 'sidestory.showHere');

export function navigationTests(): void {
  describe(`Sidestory navigation on desktop VS Code (${process.platform}, ${eol.toUpperCase()})`, () => {
    before(async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await until('the index', async () => (await stats())?.state === 'ready');
    });

    after(async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    it('CodeLens on rtl/bit_reader.sv names the path and step, with openAt arguments', async () => {
      await vscode.window.showTextDocument(bitReader);
      // The explainer suite just pinned bit-reader's manifest: its re-read may still be under way, and until it
      // lands only the overview's lenses show. Wait for bit-reader's own, not merely the first lens.
      const detail = 'Sample workspace tour › A backward bit reader in five moves · step';
      let titles: string[] = [];
      const lenses = await until(`a lens naming "${detail}"`, async () => {
        const l = ours(await lensesOf(bitReader));
        titles = l.map((x) => x.command!.title);
        return titles.some((t) => t.includes(detail)) ? l : undefined;
      }).catch((e: Error) => {
        throw new Error(`${e.message}; lenses: ${titles.join(' | ')}`);
      });
      const single = lenses.find((l) => l.command!.command === 'sidestory.openAt' && l.command!.title.includes(detail))!;
      const arg = single.command!.arguments![0] as { dir: string; anchor: string; trail: string[] };
      assert.deepEqual(arg.trail, ['overview', 'bit-reader']);
      assert.ok(arg.dir.endsWith('/.sidestory/bit-reader'));
    });

    it('lenses follow a WorkspaceEdit', async () => {
      const first = async () => Math.min(...ours(await lensesOf(bitReader)).map((l) => l.range.start.line));
      const before = await first();
      const edit = new vscode.WorkspaceEdit();
      edit.insert(bitReader, new vscode.Position(0, 0), `// a${nl}// b${nl}`);
      assert.ok(await vscode.workspace.applyEdit(edit));
      await until('the first lens two lines lower', async () => (await first()) === before + 2);
      await vscode.commands.executeCommand('workbench.action.files.revert');
    });

    (caseInsensitiveFs ? it : it.skip)('a manifest naming the file in different letter case still puts lenses on it', async () => {
      const manifestPath = join(workspace, '.sidestory', 'bit-reader', 'manifest.json');
      const raw = readFileSync(manifestPath, 'utf8');
      writeFileSync(manifestPath, raw.replace(/"rtl\/bit_reader\.sv"/g, '"RTL/BIT_READER.SV"'));
      try {
        await vscode.commands.executeCommand('sidestory.tree.refresh');
        await until('lenses for bit-reader through upper-case manifest paths', async () => ours(await lensesOf(bitReader)).some((l) => l.command!.title.includes('A backward bit reader')));
      } finally {
        writeFileSync(manifestPath, raw);
      }
    });

    it('sidestory.openAt with a trail opens the panel and puts the editor on the step', async () => {
      const dir = vscode.Uri.file(join(workspace, '.sidestory', 'bit-reader')).toString();
      await vscode.commands.executeCommand('sidestory.openAt', { dir, anchor: 'refill', trail: ['overview', 'bit-reader'] });
      await until('the panel', () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).some((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.includes('sidestory.explainer')));
      await until('bit_reader.sv on the refill step', () =>
        vscode.window.visibleTextEditors.some((e) => e.document.uri.fsPath.toLowerCase().endsWith('bit_reader.sv') && e.visibleRanges.some((r) => r.end.line > 30)),
      );
    });

    it('rejects bad openAt arguments without opening anything', async () => {
      const tabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).length;
      const n = tabs();
      await vscode.commands.executeCommand('sidestory.openAt', { dir: vscode.Uri.file(join(workspace, 'rtl')).toString(), trail: ['../x'] });
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(tabs(), n);
    });

    it('only .sidestory/ counts: a stray .explain/ folder is ignored', async () => {
      const before = (await stats()).sidestories;
      const stray = join(workspace, '.explain', 'old');
      mkdirSync(stray, { recursive: true });
      writeFileSync(join(stray, 'manifest.json'), '{"version":2,"title":"Old","anchors":{}}');
      writeFileSync(join(stray, 'sidestory.html'), '<p>old</p>');
      try {
        await vscode.commands.executeCommand('sidestory.tree.refresh');
        assert.equal((await stats()).sidestories, before);
      } finally {
        rmSync(join(workspace, '.explain'), { recursive: true, force: true });
      }
    });

    (process.env.CX_PERF ? it : it.skip)('perf smoke: 1,000 sidestories with 50 anchors each over 5,000 files', async function () {
      this.timeout(300_000);
      const root = join(workspace, 'perf');
      for (let f = 0; f < 5000; f++) {
        mkdirSync(join(root, 'src', String(f % 50)), { recursive: true });
        writeFileSync(join(root, 'src', String(f % 50), `f${f}.ts`), Array.from({ length: 120 }, (_, i) => `export const v${i} = ${i};`).join(nl));
      }
      for (let s = 0; s < 1000; s++) {
        const dir = join(root, '.sidestory', `s${s}`);
        mkdirSync(dir, { recursive: true });
        const anchors: Record<string, unknown> = {};
        let html = '';
        for (let a = 0; a < 50; a++) {
          const f = (s * 50 + a) % 5000;
          anchors[`a${a}`] = { file: `src/${f % 50}/f${f}.ts`, range: [a + 1, a + 3] };
          html += `<section data-explain-anchor="a${a}"><h2>Step ${a}</h2><p>About v${a}.</p></section>`;
        }
        writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version: 2, title: `Sidestory ${s}`, anchors }));
        writeFileSync(join(dir, 'sidestory.html'), html);
      }
      const t0 = Date.now();
      await vscode.commands.executeCommand('sidestory.tree.refresh');
      const s = await until('the index over the generated workspace', async () => {
        const x = await stats();
        return x.sidestories >= 1000 && x.steps >= 50_000 ? x : undefined;
      }, 120_000);
      const ms = Date.now() - t0;
      console.log(`[perf] index ready in ${ms} ms: ${s.sidestories} sidestories, ${s.anchors} anchors, ${s.steps} steps`);
      assert.ok(ms < 5000 * 3, `index ready in ${ms} ms`);
      // Keystrokes in an anchored file.
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(join(root, 'src', '0', 'f0.ts')));
      await vscode.window.showTextDocument(doc);
      const k0 = Date.now();
      for (let i = 0; i < 50; i++) {
        const e = new vscode.WorkspaceEdit();
        e.insert(doc.uri, new vscode.Position(0, 0), 'x');
        await vscode.workspace.applyEdit(e);
      }
      console.log(`[perf] 50 edits in an anchored file: ${((Date.now() - k0) / 50).toFixed(2)} ms each (includes VS Code's own edit round trip)`);
      await vscode.commands.executeCommand('workbench.action.files.revert');
      rmSync(root, { recursive: true, force: true });
    });
  });
}

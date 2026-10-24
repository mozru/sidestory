// Desktop VS Code: code blocks are colored with the grammars of VS Code's own language extensions and its own
// Oniguruma wasm (docs/HIGHLIGHT-PLAN.md §10), through the hidden test command `sidestory._highlight`.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

interface Result {
  theme: string;
  palette: { color?: string; font?: number }[];
  runs: number[] | null;
  engine?: 'oniguruma' | 'javascript';
}

/** The color of the run holding `text`. */
function colorOf(code: string, r: Result, text: string): string | undefined {
  const at = code.indexOf(text);
  let pos = 0;
  for (let i = 0; i < r.runs!.length; i += 2) {
    if (at >= pos && at < pos + r.runs![i]!) return r.palette[r.runs![i + 1]!]?.color;
    pos += r.runs![i]!;
  }
  return undefined;
}

export function highlightTests(): void {
  describe('Code block colors from installed grammars', () => {
    before(async () => {
      await vscode.extensions.getExtension('paperkite.sidestory')!.activate();
    });

    it("colors a TypeScript block with the built-in grammar, on VS Code's Oniguruma", async () => {
      // The built-in TypeScript grammar is there even with --disable-extensions.
      assert.ok(vscode.extensions.getExtension('vscode.typescript'), 'the built-in TypeScript language extension is installed');
      const code = 'const answer: number = 42; // the answer\nexport function ask() { return "why"; }';
      const r = (await vscode.commands.executeCommand<Result>('sidestory._highlight', 'ts', code))!;
      assert.ok(r.runs, 'the block is colored');
      assert.equal(r.runs.filter((_, i) => i % 2 === 0).reduce((a, b) => a + b, 0), code.length);
      const keyword = colorOf(code, r, 'const');
      const str = colorOf(code, r, '"why"');
      const comment = colorOf(code, r, '// the answer');
      assert.ok(keyword && str && comment, `keyword ${keyword}, string ${str}, comment ${comment}`);
      assert.notEqual(keyword, str);
      assert.notEqual(str, comment);
      assert.equal(r.engine, 'oniguruma', `onig.wasm found under ${vscode.env.appRoot}`);
    });

    it('colors markdown with the fenced languages it embeds, and leaves unknown languages plain', async () => {
      const md = '# Title\n\n```python\ndef f(): pass\n```\n';
      const r = (await vscode.commands.executeCommand<Result>('sidestory._highlight', 'md', md))!;
      assert.ok(r.runs);
      // Python's keyword color inside the fence, where a fence of an unknown language leaves `def` as plain code.
      const unknown = md.replace('python', 'klingon');
      const plain = (await vscode.commands.executeCommand<Result>('sidestory._highlight', 'md', unknown))!;
      assert.ok(colorOf(md, r, 'def'), 'python inside markdown is colored');
      assert.notEqual(colorOf(md, r, 'def'), colorOf(unknown, plain, 'def'), 'the fence uses the python grammar');
      const none = (await vscode.commands.executeCommand<Result>('sidestory._highlight', 'klingon', 'x'))!;
      assert.equal(none.runs, null);
    });
  });
}

// Every command package.json contributes is registered at startup (bootstrap-shared.ts COMMANDS), or VS Code says
// "command not found" when it runs: the right-click menu's commands once were.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { COMMANDS } from '../../src/extension/bootstrap-shared.ts';

it('registers every contributed command', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { contributes: { commands: { command: string }[] } };
  const missing = pkg.contributes.commands.map((c) => c.command).filter((c) => !(COMMANDS as readonly string[]).includes(c));
  expect(missing).toEqual([]);
});

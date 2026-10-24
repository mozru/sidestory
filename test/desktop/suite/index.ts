// Mocha entry point, loaded by VS Code's extension host (see test/desktop/run.mjs).
import Mocha from 'mocha';
import { explainerTests } from './explainer.test.ts';
import { navigationTests } from './navigation.test.ts';
import { changesTests } from './changes.test.ts';
import { diffStepsTests } from './diff-steps.test.ts';
import { highlightTests } from './highlight.test.ts';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', timeout: 30_000, color: true });
  mocha.suite.emit('pre-require', globalThis, 'desktop', mocha);
  // The Changes view runs on its own workspace, the fixture repository (run.mjs's last run).
  if (process.env.CX_SUITE === 'changes') changesTests();
  // Steps in diff editors run on the fixture with a sidestory that explains part of the branch (release 1b).
  else if (process.env.CX_SUITE === 'diffsteps') diffStepsTests();
  else {
    explainerTests();
    navigationTests();
    highlightTests();
  }
  return new Promise((resolve, reject) => mocha.run((failures) => (failures ? reject(new Error(`${failures} desktop test(s) failed`)) : resolve())));
}

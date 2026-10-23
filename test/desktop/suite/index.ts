// Mocha entry point, loaded by VS Code's extension host (see test/desktop/run.mjs).
import Mocha from 'mocha';
import { explainerTests } from './explainer.test.ts';
import { navigationTests } from './navigation.test.ts';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', timeout: 30_000, color: true });
  mocha.suite.emit('pre-require', globalThis, 'desktop', mocha);
  explainerTests();
  navigationTests();
  return new Promise((resolve, reject) => mocha.run((failures) => (failures ? reject(new Error(`${failures} desktop test(s) failed`)) : resolve())));
}

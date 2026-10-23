import { createHash } from 'node:crypto';
import { defineConfig } from 'vitest/config';
import { WIDGET_BOOTSTRAP } from './src/shared/widget-bootstrap.ts';

export default defineConfig({
  // As scripts/build.mjs defines it for the webview bundle.
  define: { __CX_BOOTSTRAP_HASH__: JSON.stringify(`sha256-${createHash('sha256').update(WIDGET_BOOTSTRAP, 'utf8').digest('base64')}`) },
  test: {
    projects: [
      { extends: true, test: { name: 'unit', include: ['test/unit/**/*.test.ts'], exclude: ['test/unit/memory.test.ts'] } },
      // The index memory test measures the heap: its own processes, with gc() exposed (docs/NAVIGATION-PLAN.md §12.1).
      { extends: true, test: { name: 'memory', include: ['test/unit/memory.test.ts'], pool: 'forks', execArgv: ['--expose-gc'] } },
    ],
  },
});

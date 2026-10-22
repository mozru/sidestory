import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '*.e2e.ts',
  outputDir: '../../test-results/e2e',
  globalSetup: './setup.ts',
  // One VS Code server, one workspace: run tests one at a time.
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:3100', viewport: { width: 1440, height: 900 }, screenshot: 'only-on-failure' },
});

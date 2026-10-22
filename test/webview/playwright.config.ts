import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '*.pw.ts',
  outputDir: '../../test-results/webview',
  fullyParallel: true,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:4173', viewport: { width: 600, height: 900 }, colorScheme: 'dark' },
  webServer: { command: 'node scripts/serve.mjs . 4173', cwd: '../..', url: 'http://127.0.0.1:4173/test/webview/harness.html', reuseExistingServer: true },
});

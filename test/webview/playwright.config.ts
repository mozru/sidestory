import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.CX_HARNESS_PORT ?? 4291);

export default defineConfig({
  testDir: '.',
  testMatch: '*.pw.ts',
  outputDir: '../../test-results/webview',
  fullyParallel: true,
  reporter: [['list']],
  retries: process.env.CI ? 2 : 0,
  forbidOnly: !!process.env.CI,
  use: { baseURL: `http://127.0.0.1:${PORT}`, viewport: { width: 600, height: 900 }, colorScheme: 'dark' },
  // Never reuse a server someone else started on this port: it could be serving another copy of the repo.
  projects: [
    { name: 'panel' },
    // Widget frames out of process, as in desktop VS Code: the panel then sees no input inside them.
    { name: 'isolated', testMatch: ['widgets.pw.ts', 'isolation.pw.ts'], use: { launchOptions: { args: ['--site-per-process', '--enable-features=IsolateSandboxedIframes'] } } },
  ],
  webServer: { command: `node scripts/serve.mjs . ${PORT}`, cwd: '../..', url: `http://127.0.0.1:${PORT}/test/webview/harness.html`, reuseExistingServer: false },
});

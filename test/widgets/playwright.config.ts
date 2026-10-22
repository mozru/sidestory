import { defineConfig } from '@playwright/test';

// Widget frames in a sandboxed srcdoc iframe under the panel's CSP (see fixtures.ts). No server: the
// harness and libraries are served through page.route. The libraries are rebuilt first (global-setup.ts).
export default defineConfig({
  testDir: '.',
  testMatch: '*.pw.ts',
  outputDir: '../../test-results/widgets',
  globalSetup: './global-setup.ts',
  fullyParallel: true,
  reporter: [['list']],
  retries: process.env.CI ? 2 : 0,
  forbidOnly: !!process.env.CI,
  use: { viewport: { width: 640, height: 900 }, colorScheme: 'dark' },
});

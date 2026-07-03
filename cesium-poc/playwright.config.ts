import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  workers: 3,        // cap workers: SwiftShader tests are GPU-intensive; 5 workers causes timeout flakiness
  timeout: 40_000,   // per-test: live Booth residual needs > 30 s to warm up (35 s waitForFunction + overhead)
  reporter: [['list'], ['html', { open: 'never' }]],
  // Dedicated port 5188 (NOT 5180) so this worktree never collides with a sibling session's
  // Vite dev server on the default port — they share localhost even though the files are isolated.
  use: {
    baseURL: 'http://localhost:5188',
    headless: true,
    viewport: { width: 1400, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: {
      args: [
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--ignore-gpu-blocklist',
        '--enable-webgl',
      ],
    },
  },
  webServer: {
    command: 'npx vite --port 5188',
    url: 'http://localhost:5188',
    reuseExistingServer: true,
    timeout: 60000,
  },
});

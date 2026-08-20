import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './apps/web/test',
  timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:5173', trace: 'retain-on-failure', ...devices['Desktop Chrome'] },
  webServer: { command: 'pnpm dev:web', url: 'http://127.0.0.1:5173', reuseExistingServer: true, timeout: 60_000 }
});

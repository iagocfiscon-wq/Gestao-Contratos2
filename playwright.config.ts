import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './apps/web/test',
  timeout: 45_000,
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome']
  },
  webServer: [
    { command: 'pnpm dev:api', url: 'http://127.0.0.1:3333/health', reuseExistingServer: true, timeout: 60_000 },
    { command: 'pnpm dev:web', url: 'http://127.0.0.1:5173', reuseExistingServer: true, timeout: 60_000 }
  ]
});

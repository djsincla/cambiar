import { defineConfig, devices } from '@playwright/test';
import { rmSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

// Each E2E run starts from a clean DB. We reset BEFORE Playwright spawns the
// webServer so the bootstrap admin/admin is fresh.
const E2E_DATA_DIR = resolve(process.cwd(), 'data-e2e');
rmSync(E2E_DATA_DIR, { recursive: true, force: true });
mkdirSync(E2E_DATA_DIR, { recursive: true });

const PORT = process.env.E2E_PORT ?? '3500';
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1, // tests share one backend; running serially keeps state predictable
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : 'list',

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],

  webServer: {
    command: 'npm start',
    url: `${BASE_URL}/api/health`,
    timeout: 60_000,
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PORT,
      NODE_ENV: 'production',
      DATA_DIR: E2E_DATA_DIR,
      JWT_SECRET: 'e2e-secret-not-for-production-e2e-secret-not-for-production',
      LOG_LEVEL: 'error',
    },
  },
});

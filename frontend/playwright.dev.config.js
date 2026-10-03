import { defineConfig } from '@playwright/test';

// Отдельный Vite development server сохраняет React StrictMode effect replay.
// Все API-запросы тесты перехватывают до Vite proxy; backend не запускается.
export default defineConfig({
  testDir: './e2e-dev',
  testMatch: '**/*.spec.js',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  outputDir: 'test-results/dev',
  use: {
    browserName: 'chromium',
    baseURL: 'http://127.0.0.1:5175',
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    serviceWorkers: 'block',
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 5175 --strictPort',
    url: 'http://127.0.0.1:5175',
    reuseExistingServer: false,
    timeout: 60_000,
    env: { VITE_API_BASE_URL: '/api/v1' },
  },
});

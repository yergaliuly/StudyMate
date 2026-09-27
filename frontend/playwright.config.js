import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.js',

  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),

  timeout: 30_000,

  expect: {
    timeout: 10_000,
  },

  reporter: 'list',
  outputDir: 'test-results',

  use: {
    browserName: 'chromium',
    baseURL: 'http://127.0.0.1:4173',
    viewport: {
      width: 1280,
      height: 800,
    },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  webServer: {
    command:
      'npm run preview -- --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
import { defineConfig, devices } from '@playwright/test';

/**
 * Browser smoke tests against the built game (npm run test:e2e builds first).
 * Covers the three engines people actually use: Chromium (Chrome, Edge, Android), Firefox and
 * WebKit (Safari, and every browser on iOS), plus phone-sized WebKit and Chromium.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: 'http://127.0.0.1:4173/', trace: 'retain-on-failure' },
  webServer: { command: 'node scripts/serve.mjs --port 4173', url: 'http://127.0.0.1:4173/', reuseExistingServer: !process.env.CI },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'iphone', use: { ...devices['iPhone 13'] } },
    { name: 'android', use: { ...devices['Pixel 7'] } },
  ],
});

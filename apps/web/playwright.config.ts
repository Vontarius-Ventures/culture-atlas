import { defineConfig, devices } from '@playwright/test';

/**
 * Browser journeys. Chromium is preinstalled at PLAYWRIGHT_BROWSERS_PATH
 * (/opt/pw-browsers); never run `playwright install`. @playwright/test is
 * pinned to the version matching that Chromium build (1.56.1 -> chromium-1194).
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: true,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
    { name: 'minimum', use: { ...devices['Desktop Chrome'], viewport: { width: 360, height: 740 } } },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : { command: 'pnpm dev', url: 'http://localhost:3000/v1/health', reuseExistingServer: true, timeout: 120_000 },
});

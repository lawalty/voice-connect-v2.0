import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './checks/browser', timeout: 90_000, expect: { timeout: 12_000 },
  fullyParallel: false, workers: 1, retries: 0,
  use: { baseURL: 'http://127.0.0.1:5180', trace: 'retain-on-failure', screenshot: 'only-on-failure', launchOptions: { args: ['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'] } },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 960 }, baseURL: 'http://127.0.0.1:5180' } },
    { name: 'android-layout', use: { ...devices['Pixel 7'], defaultBrowserType: 'chromium', baseURL: 'http://127.0.0.1:5182' } },
  ],
  // Each project has its own service, database, gateway and production rate-limit budget.
  webServer: [
    { command: 'node checks/browser-fixture.mjs 5180 5181 18791', url: 'http://127.0.0.1:5181/ready', timeout: 40_000, reuseExistingServer: false },
    { command: 'node checks/browser-fixture.mjs 5182 5183 18792', url: 'http://127.0.0.1:5183/ready', timeout: 40_000, reuseExistingServer: false },
  ],
});

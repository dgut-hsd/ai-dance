import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/browser',
  timeout: 90000,
  workers: 1,
  use: { browserName: 'chromium', channel: 'chrome', headless: true },
});

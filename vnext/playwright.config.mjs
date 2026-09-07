import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests', testMatch: '**/browser.spec.mjs', workers: 1, timeout: 60000,
  use: { headless: true, channel: 'chromium', viewport: { width: 1280, height: 900 }, trace: 'retain-on-failure' },
})

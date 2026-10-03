import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4200',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ],
  webServer: [
    {
      command: 'npm run start -- --host 127.0.0.1 --port 4200',
      url: 'http://127.0.0.1:4200',
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
    {
      // Starts the OCR server-mode API (see container-storage-mgmt-api-ocr/docker-compose.e2e.yml).
      // Reuses an already-running instance (e.g. a manually started `ocr-api` container) instead of
      // starting a second one, same as the Angular dev server above.
      command: 'docker compose -f container-storage-mgmt-api-ocr/docker-compose.e2e.yml up --build',
      // /health also triggers the (first-call) model load, so this doubles as the readiness probe.
      url: 'http://127.0.0.1:8000/health',
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
  ],
});

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  use: { ...devices['Pixel 7'], baseURL: 'http://localhost:4173/' },
  webServer: { command: 'python3 -m http.server 4173', stdout: 'ignore', stderr: 'ignore', url: 'http://localhost:4173/', reuseExistingServer: true },
});

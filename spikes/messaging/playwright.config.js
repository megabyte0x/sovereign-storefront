import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 240_000,
  expect: { timeout: 30_000 },
  retries: 0,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4173",
    headless: true,
    launchOptions: {
      executablePath: "/usr/bin/chromium",
      args: ["--no-sandbox", "--disable-dev-shm-usage"]
    }
  },
  webServer: {
    command: "npx vite --host 127.0.0.1 --port 4173 --strictPort",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
    timeout: 120_000
  }
});

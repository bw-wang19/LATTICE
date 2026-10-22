import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: "list",
  use: {
    contextOptions: { reducedMotion: "reduce" },
    baseURL: "http://127.0.0.1:4173",
    viewport: { width: 1440, height: 960 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions: {
      ...(process.env.LATTICE_CHROMIUM_PATH
        ? { executablePath: process.env.LATTICE_CHROMIUM_PATH }
        : {}),
    },
  },
  webServer: [
    {
      command: "../.venv/bin/python e2e/server.py",
      url: "http://127.0.0.1:8021/healthz",
      reuseExistingServer: false,
    },
    {
      command: "npm run dev -- --port 4173 --strictPort",
      url: "http://127.0.0.1:4173",
      env: { LATTICE_API_TARGET: "http://127.0.0.1:8021" },
      reuseExistingServer: false,
    },
  ],
});

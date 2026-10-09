import { defineConfig, devices } from "@playwright/test";

// E2E specs live in e2e/. Vitest only collects src/**/*.test.ts(x), so it never runs these.
// Every test starts its own roomsd on one pair of ports, so they run one at a time. A second run on
// the same machine sets ROOMS_E2E_API_PORT, ROOMS_E2E_FILES_PORT and ROOMS_E2E_APP_PORT.
const APP_PORT = Number(process.env.ROOMS_E2E_APP_PORT ?? 4173);
const APP_ORIGIN = `http://localhost:${APP_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: APP_ORIGIN,
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: `bun run --silent build && bunx vite preview --port ${APP_PORT} --strictPort`,
    url: APP_ORIGIN,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
  projects: [
    { name: "chromium" },
    // The desktop app runs on macOS WebKit (WKWebView): pointer-heavy specs run there too.
    { name: "webkit", use: { ...devices["Desktop Safari"], viewport: { width: 1440, height: 900 } }, testMatch: /(reorder|plugins|tabs)\.spec\.ts/ },
  ],
});

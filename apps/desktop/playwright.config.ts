import { defineConfig, devices } from "@playwright/test";

// E2E specs live in e2e/. Vitest only collects src/**/*.test.ts(x), so it never runs these.
// Every test starts its own roomsd on the fixed ports 14317/14318, so they run one at a time.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://localhost:4173",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "bun run --silent build && bun run --silent preview",
    url: "http://localhost:4173",
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

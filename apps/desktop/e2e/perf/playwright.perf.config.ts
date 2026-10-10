// The perf probe's own config: serves a built `dist` folder (ROOMS_PERF_DIST) instead of building,
// so e2e/perf/gate.sh can alternate a trunk build and a head build on one port.
//   ROOMS_PERF=1 ROOMS_PERF_DIST=dist-perf/head bunx playwright test --config e2e/perf/playwright.perf.config.ts
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const APP_PORT = Number(process.env.ROOMS_E2E_APP_PORT ?? 4173);
const APP_ORIGIN = `http://localhost:${APP_PORT}`;
const DIST = path.resolve(import.meta.dirname, "../..", process.env.ROOMS_PERF_DIST ?? "dist");

export default defineConfig({
  testDir: "..",
  testMatch: /perf\/surface-perf\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: { ...devices["Desktop Chrome"], baseURL: APP_ORIGIN, viewport: { width: 1440, height: 900 } },
  webServer: {
    command: `bunx vite preview --outDir ${DIST} --port ${APP_PORT} --strictPort`,
    url: APP_ORIGIN,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import pkg from "./package.json" with { type: "json" };
import { appCsp } from "./e2e/appCsp";

// The perf gate (e2e/perf/gate.sh) builds with ROOMS_PROFILE=1: React's profiling bundle, which
// times each commit for a DevTools hook the probe installs. Never set for a shipped build.
const profiling: Record<string, string> = process.env.ROOMS_PROFILE === "1" ? { "react-dom/client": "react-dom/profiling" } : {};
// The e2e suite (playwright.config.ts sets ROOMS_E2E_CSP=1) previews the build under the desktop app's CSP.
const previewHeaders = process.env.ROOMS_E2E_CSP === "1" ? { "content-security-policy": appCsp() } : undefined;

// Tauri expects a fixed dev port (tauri.conf.json build.devUrl = http://localhost:1420).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src"), ...profiling } },
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  preview: { port: 4173, strictPort: true, headers: previewHeaders },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: { target: "safari16", outDir: "dist" },
  // The quit-flush verification probe (lib/flushProbe.ts) is compiled in only
  // with ALTO_FLUSH_PROBE=1; otherwise the constant is false and it tree-shakes out.
  // __APP_VERSION__: plugins declare a minAppVersion, checked against this.
  define: { __FLUSH_PROBE__: JSON.stringify(process.env.ALTO_FLUSH_PROBE === "1"), __APP_VERSION__: JSON.stringify(pkg.version) },
});

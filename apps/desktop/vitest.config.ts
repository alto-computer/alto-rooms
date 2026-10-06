import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
  define: { __FLUSH_PROBE__: "false", __APP_VERSION__: JSON.stringify(pkg.version) },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["e2e/**", "node_modules/**"],
    setupFiles: ["./src/test/setup.ts"],
  },
});

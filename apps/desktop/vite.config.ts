import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// Tauri expects a fixed dev port (tauri.conf.json build.devUrl = http://localhost:1420).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  preview: { port: 4173, strictPort: true },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: { target: "safari16", outDir: "dist" },
});

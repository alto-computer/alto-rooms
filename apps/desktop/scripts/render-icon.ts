/*
 * Rebuilds every app icon in src-tauri/icons from src-tauri/icons/source.svg.
 * Chromium rasterises the SVG at 1024px and `tauri icon` downsizes that PNG; fed the SVG
 * directly, tauri's own renderer draws the 16 and 32px sizes visibly fainter.
 * The Android and iOS sets tauri also writes are dropped: the app ships only on desktop.
 *
 *   bun scripts/render-icon.ts
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";

const root = path.resolve(import.meta.dirname, "..");
const icons = path.join(root, "src-tauri", "icons");
const tmp = mkdtempSync(path.join(os.tmpdir(), "rooms-icon-"));
const png = path.join(tmp, "source.png");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
await page.setContent(
  `<style>html,body{margin:0}svg{display:block}</style>${readFileSync(path.join(icons, "source.svg"), "utf8")}`,
);
await page.screenshot({ path: png, omitBackground: true });
await browser.close();

const out = path.join(tmp, "out");
execFileSync(path.join(root, "node_modules", ".bin", "tauri"), ["icon", png, "-o", out], { cwd: root, stdio: "inherit" });
for (const entry of readdirSync(out, { withFileTypes: true })) {
  if (entry.isFile()) cpSync(path.join(out, entry.name), path.join(icons, entry.name));
}
rmSync(tmp, { recursive: true });

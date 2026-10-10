/*
 * Rebuilds every app icon in src-tauri/icons from two drawings: source.svg, and source-small.svg,
 * which has fewer, heavier wraps and is used at SMALL_UP_TO px and below so the yarn still reads there.
 * Chromium rasterises each size straight from the SVG; tauri's own renderer draws small sizes visibly fainter.
 * icon.icns is packed by macOS's iconutil, so run this on a Mac.
 *
 *   bun scripts/render-icon.ts
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";

const SMALL_UP_TO = 72;

const root = path.resolve(import.meta.dirname, "..");
const icons = path.join(root, "src-tauri", "icons");
const drawing = (name: string) => readFileSync(path.join(icons, name), "utf8");
const big = drawing("source.svg");
const small = drawing("source-small.svg");

const pngFiles: Record<string, number> = {
  "32x32.png": 32,
  "64x64.png": 64,
  "128x128.png": 128,
  "128x128@2x.png": 256,
  "icon.png": 512,
  "StoreLogo.png": 50,
  ...Object.fromEntries([30, 44, 71, 89, 107, 142, 150, 284, 310].map((n) => [`Square${n}x${n}Logo.png`, n])),
};
const icnsPoints = [16, 32, 128, 256, 512];
const icoSizes = [16, 24, 32, 48, 64, 256];

const browser = await chromium.launch();
const page = await browser.newPage();
const rendered = new Map<number, Buffer>();
async function render(px: number): Promise<Buffer> {
  const cached = rendered.get(px);
  if (cached) return cached;
  await page.setViewportSize({ width: px, height: px });
  await page.setContent(
    `<style>html,body{margin:0}svg{display:block;width:${px}px;height:${px}px}</style>${px <= SMALL_UP_TO ? small : big}`,
  );
  const png = await page.screenshot({ omitBackground: true });
  rendered.set(px, png);
  return png;
}

for (const [file, px] of Object.entries(pngFiles)) writeFileSync(path.join(icons, file), await render(px));

const tmp = mkdtempSync(path.join(os.tmpdir(), "rooms-icon-"));
const iconset = path.join(tmp, "icon.iconset");
mkdirSync(iconset);
for (const pt of icnsPoints) {
  writeFileSync(path.join(iconset, `icon_${pt}x${pt}.png`), await render(pt));
  writeFileSync(path.join(iconset, `icon_${pt}x${pt}@2x.png`), await render(pt * 2));
}
execFileSync("iconutil", ["-c", "icns", iconset, "-o", path.join(icons, "icon.icns")]);
rmSync(tmp, { recursive: true });

const icoImages: [number, Buffer][] = [];
for (const px of icoSizes) icoImages.push([px, await render(px)]);
writeFileSync(path.join(icons, "icon.ico"), ico(icoImages));
await browser.close();

/** An .ico holding each image as PNG (Windows Vista and later read PNG entries). */
function ico(images: [px: number, png: Buffer][]): Buffer {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(([px, png], i) => {
    const at = 6 + 16 * i;
    header.writeUInt8(px % 256, at);
    header.writeUInt8(px % 256, at + 1);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(png.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map(([, png]) => png)]);
}

/*
 * Fills src-tauri/resources/plugins/<id>/ with the plugins the app ships, as listed in
 * bundled-plugins.json: each one's release zip (<repo>/releases/download/v<version>/<id>.zip),
 * checked against its sha256. The app never builds plugin code; it only ships their releases.
 *
 * For local work, ROOMS_PLUGIN_<ID>=<folder> uses that built folder instead (e.g. ../rooms-plugin-goals/dist).
 *
 *   bun scripts/bundle-plugins.ts
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

type Entry = { id: string; repo: string; version: string; sha256: string };

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, "src-tauri", "resources", "plugins");
const { plugins } = JSON.parse(readFileSync(path.join(root, "bundled-plugins.json"), "utf8")) as { plugins: Entry[] };

async function fromRelease(p: Entry, dest: string) {
  const url = `${p.repo}/releases/download/v${p.version}/${p.id}.zip`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${p.id}: GET ${url} → ${res.status}`);
  const zip = Buffer.from(await res.arrayBuffer());
  const sum = createHash("sha256").update(zip).digest("hex");
  if (sum !== p.sha256) throw new Error(`${p.id}: sha256 ${sum} does not match bundled-plugins.json (${p.sha256 || "empty"})`);
  const file = path.join(os.tmpdir(), `rooms-bundle-${p.id}-${process.pid}.zip`);
  writeFileSync(file, zip);
  mkdirSync(dest, { recursive: true });
  execFileSync("unzip", ["-q", file, "-d", dest]);
  rmSync(file);
}

for (const p of plugins) {
  const dest = path.join(out, p.id);
  rmSync(dest, { recursive: true, force: true });
  const local = process.env[`ROOMS_PLUGIN_${p.id.toUpperCase().replace(/-/g, "_")}`];
  if (local) {
    if (!existsSync(path.join(local, "manifest.json"))) throw new Error(`${p.id}: no manifest.json in ${local}`);
    cpSync(local, dest, { recursive: true });
    console.log(`${p.id}: from ${local}`);
  } else {
    await fromRelease(p, dest);
    console.log(`${p.id}: ${p.version}`);
  }
  const m = JSON.parse(readFileSync(path.join(dest, "manifest.json"), "utf8"));
  if (m.id !== p.id || m.version !== p.version)
    throw new Error(`${p.id}: manifest says ${m.id}@${m.version}, expected ${p.id}@${p.version}`);
}

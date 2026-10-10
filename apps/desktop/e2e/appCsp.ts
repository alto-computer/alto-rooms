/*
 * The e2e ports, and the desktop app's Content Security Policy as Tauri serves the bundle, for the
 * Vite preview server to send with every document. Tauri gives the bundle's inline <style> a nonce
 * and adds it to style-src; a nonce or hash in that directive makes the browser ignore
 * 'unsafe-inline', so a <style> element made at runtime gets no sheet. The web build has no CSP
 * of its own and would hide that. Here each inline <style> of dist/index.html gets its hash, which
 * has the same effect. Shared by vite.config.ts (headers) and fixtures.ts (ports), so it imports
 * nothing from Playwright.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const envPort = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
export const API_PORT = envPort("ROOMS_E2E_API_PORT", 14317);
export const FILES_PORT = envPort("ROOMS_E2E_FILES_PORT", 14318);
export const APP_PORT = envPort("ROOMS_E2E_APP_PORT", 4173);
export const APP_ORIGIN = `http://localhost:${APP_PORT}`;

const DESKTOP = path.resolve(import.meta.dirname, "..");

/** tauri.conf.json's policy on the e2e ports, with a hash for each inline <style> the build left in index.html. */
export function appCsp(): string {
  const conf = JSON.parse(readFileSync(path.join(DESKTOP, "src-tauri", "tauri.conf.json"), "utf8")) as { app: { security: { csp: string } } };
  const index = path.join(DESKTOP, "dist", "index.html");
  const html = existsSync(index) ? readFileSync(index, "utf8") : "";
  const hashes = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => `'sha256-${createHash("sha256").update(m[1]).digest("base64")}'`);
  const csp = conf.app.security.csp
    .replaceAll("127.0.0.1:4317", `127.0.0.1:${API_PORT}`)
    .replaceAll("127.0.0.1:4318", `127.0.0.1:${FILES_PORT}`)
    .replace("style-src 'self' 'unsafe-inline'", ["style-src 'self' 'unsafe-inline'", ...hashes].join(" "));
  if (hashes.length > 0 && !csp.includes(hashes[0])) throw new Error("tauri.conf.json's style-src changed shape; the e2e CSP mirror no longer matches it");
  return csp;
}

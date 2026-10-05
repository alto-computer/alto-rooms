/*
 * E2E fixtures: a real roomsd per test, on its own temp home and test ports,
 * driven through the web build (Vite preview on 4173).
 *
 * - roomsd is built once per run (`cargo build -p roomsd` at the repo root).
 * - Each test gets a fresh home, ROOMS_API_PORT=14317, ROOMS_FILES_PORT=14318
 *   and ROOMS_DEV_ORIGIN=http://localhost:4173; the daemon is killed and the
 *   home removed in teardown, even when the test fails.
 * - The connection reaches the page through `page.addInitScript`, never the URL.
 */
import { test as base, expect } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const API_PORT = 14317;
export const FILES_PORT = 14318;
export const APP_ORIGIN = "http://localhost:4173";
const BASE = `http://127.0.0.1:${API_PORT}`;

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const ROOMSD = path.join(REPO_ROOT, "target", "debug", "roomsd");

type Room = { id: string; name: string; path: string; artifactCount: number };

export type Daemon = {
  /** The daemon's home (canonical, as /v1/info reports it). */
  home: string;
  token: string;
  baseUrl: string;
  /** GET /v1/rooms. */
  listRooms(): Promise<Room[]>;
  /** POST /v1/rooms with the token. */
  createRoom(name: string): Promise<Room>;
  /** PUT a note with the token. */
  saveNote(date: string, name: string, body: string): Promise<void>;
  /** Writes a file under the home, creating parent folders. */
  write(rel: string, contents: string): Promise<void>;
  exists(rel: string): Promise<boolean>;
  read(rel: string): Promise<string>;
};

/** Today in the local time zone, as the app computes it (YYYY-MM-DD). */
export function today(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function cargoEnv(): NodeJS.ProcessEnv {
  const cargoBin = path.join(os.homedir(), ".cargo", "bin");
  return { ...process.env, PATH: `${cargoBin}:${process.env.PATH ?? ""}` };
}

async function portFree(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(300) });
    return false;
  } catch {
    return true;
  }
}

async function waitForInfo(child: ChildProcess, log: () => string): Promise<{ home: string }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`roomsd exited with ${child.exitCode}:\n${log()}`);
    try {
      const r = await fetch(`${BASE}/v1/info`, { signal: AbortSignal.timeout(500) });
      if (r.ok) return (await r.json()) as { home: string };
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`roomsd did not answer /v1/info within 10s:\n${log()}`);
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const timedOut = await Promise.race([exited.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), 3000))]);
  if (timedOut) {
    child.kill("SIGKILL");
    await exited;
  }
}

export const test = base.extend<{ daemon: Daemon }, { roomsdBinary: string }>({
  roomsdBinary: [
    async ({}, use) => {
      execFileSync("cargo", ["build", "-q", "-p", "roomsd"], { cwd: REPO_ROOT, env: cargoEnv(), stdio: "pipe" });
      if (!existsSync(ROOMSD)) throw new Error(`roomsd not built at ${ROOMSD}`);
      await use(ROOMSD);
    },
    { scope: "worker", timeout: 600_000 },
  ],

  daemon: async ({ page, roomsdBinary }, use, testInfo) => {
    for (const port of [API_PORT, FILES_PORT]) {
      if (!(await portFree(port))) throw new Error(`port ${port} is busy; stop whatever holds it before running e2e`);
    }
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rooms-e2e-"));
    let output = "";
    const child = spawn(roomsdBinary, [], {
      env: {
        ...process.env,
        ROOMS_HOME: dir,
        ROOMS_API_PORT: String(API_PORT),
        ROOMS_FILES_PORT: String(FILES_PORT),
        ROOMS_DEV_ORIGIN: APP_ORIGIN,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (b) => (output += b));
    child.stderr?.on("data", (b) => (output += b));
    try {
      const info = await waitForInfo(child, () => output);
      const home = info.home;
      const token = (await fs.readFile(path.join(home, ".rooms", "token"), "utf8")).trim();

      await page.addInitScript(
        ({ base, token, home }) => {
          (window as unknown as { __ROOMS_DEV__: unknown }).__ROOMS_DEV__ = { baseUrl: base, token, home };
        },
        { base: BASE, token, home },
      );

      const auth = { authorization: `Bearer ${token}` };
      const abs = (rel: string) => path.join(home, rel);
      const daemon: Daemon = {
        home,
        token,
        baseUrl: BASE,
        async listRooms() {
          const r = await fetch(`${BASE}/v1/rooms`);
          if (!r.ok) throw new Error(`listRooms: ${r.status}`);
          return (await r.json()) as Room[];
        },
        async createRoom(name) {
          const r = await fetch(`${BASE}/v1/rooms`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json" },
            body: JSON.stringify({ name }),
          });
          if (!r.ok) throw new Error(`createRoom: ${r.status} ${await r.text()}`);
          return (await r.json()) as Room;
        },
        async saveNote(date, name, body) {
          const r = await fetch(`${BASE}/v1/journal/${date}/notes/${encodeURIComponent(name)}`, {
            method: "PUT",
            headers: { ...auth, "content-type": "text/markdown" },
            body,
          });
          if (!r.ok) throw new Error(`saveNote: ${r.status} ${await r.text()}`);
        },
        async write(rel, contents) {
          await fs.mkdir(path.dirname(abs(rel)), { recursive: true });
          await fs.writeFile(abs(rel), contents);
        },
        async exists(rel) {
          return fs.access(abs(rel)).then(
            () => true,
            () => false,
          );
        },
        read: (rel) => fs.readFile(abs(rel), "utf8"),
      };
      await use(daemon);
    } finally {
      await stop(child);
      if (testInfo.status !== testInfo.expectedStatus && output) {
        await testInfo.attach("roomsd.log", { body: output, contentType: "text/plain" });
      }
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
});

export { expect };

/** The macOS-or-Ctrl modifier the app listens for. */
export const MOD = process.platform === "darwin" ? "Meta" : "Control";

/** A small artifact page with a title and some visible content. */
export function artifactHtml(title: string, body = "", accent = "#222"): string {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;margin:0;padding:64px;color:#222;background:#fff}
h1{font-size:56px;margin:0 0 24px}p{font-size:24px;line-height:1.6;color:#555}
.bar{height:24px;border-radius:12px;background:${accent};margin:16px 0;opacity:.85}</style></head>
<body><h1>${title}</h1><p>${body}</p><div class="bar" style="width:70%"></div><div class="bar" style="width:45%"></div><div class="bar" style="width:60%"></div></body></html>`;
}

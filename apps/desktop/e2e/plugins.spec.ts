import fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test, type Daemon } from "./fixtures";

const sidebarPlugins = (page: Page) => page.getByRole("list", { name: "Plugins" });
const echoFrame = (page: Page) => page.frameLocator('iframe[title="Echo"]');

async function api(daemon: Daemon, method: string, p: string, body?: unknown) {
  const r = await fetch(`${daemon.baseUrl}${p}`, {
    method,
    headers: { authorization: `Bearer ${daemon.token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

async function setup(page: Page, daemon: Daemon) {
  const bench = await daemon.createRoom("Bench");
  const other = await daemon.createRoom("Other");
  await daemon.write("Bench/latency.html", "<title>Latency report</title><p>p95 118 ms</p>");
  await daemon.installPlugin("echo");
  await page.goto("/");
  return { bench, other };
}

async function turnOnFromCard(page: Page) {
  const card = page.getByRole("dialog", { name: "New plugin: Echo" });
  await expect(card).toBeVisible({ timeout: 5000 });
  await expect(card.getByText("Can see your rooms and documents")).toBeVisible();
  await card.getByRole("button", { name: "Turn on" }).click();
  await expect(card).toBeHidden();
}

async function openDoc(page: Page, roomName: string) {
  await page.getByRole("list", { name: "Rooms" }).getByRole("button", { name: roomName }).click();
  await page.getByTestId("artifact-card").filter({ hasText: "Latency report" }).getByRole("button", { name: "Latency report" }).click();
  await expect(page.getByRole("tab", { name: "Latency report", selected: true })).toBeVisible();
}

test("a plugin is asked about, runs beside a document, keeps its notes across a move, and opens as a tab", async ({ page, daemon }) => {
  const { bench, other } = await setup(page, daemon);
  await expect(page.locator('iframe[title="Echo"]')).toHaveCount(0); // nothing runs before Turn on
  await turnOnFromCard(page);
  await expect(sidebarPlugins(page).getByRole("button", { name: "Echo" })).toBeVisible();

  type Doc = { id: string; fileKey: string };
  await expect.poll(async () => ((await api(daemon, "GET", `/v1/rooms/${bench.id}/artifacts`)) as Doc[]).length).toBe(1);
  const [doc] = (await api(daemon, "GET", `/v1/rooms/${bench.id}/artifacts`)) as Doc[];
  await openDoc(page, "Bench");
  await page.getByRole("button", { name: "Open Echo" }).click();
  await expect(echoFrame(page).locator("#ctx")).toHaveText(`doc ${doc.fileKey}`);
  await echoFrame(page).getByRole("button", { name: "Save" }).click();
  await expect(echoFrame(page).locator("#out")).toHaveText(`saved ${doc.fileKey}`);
  expect(await daemon.read(".rooms/plugins/echo/data/echo.txt")).toBe(doc.fileKey);

  // Rooms moves the (plain-file) doc to another room: same original, same fileKey, same notes.
  await api(daemon, "POST", "/v1/artifacts/move", { roomId: bench.id, artifactId: doc.id, toRoomId: other.id });
  await openDoc(page, "Other");
  await expect(echoFrame(page).locator("#ctx")).toHaveText(`doc ${doc.fileKey}`);

  // The sidebar item opens the plugin as a tab; it can list rooms (rooms.read).
  await sidebarPlugins(page).getByRole("button", { name: "Echo" }).click();
  await expect(page.getByRole("tab", { name: "Echo", selected: true })).toBeVisible();
  await expect(echoFrame(page).locator("#ctx")).toHaveText("tab");
  await echoFrame(page).getByRole("button", { name: "List rooms" }).click();
  await expect(echoFrame(page).locator("#out")).toContainText("Bench");
  await expect(echoFrame(page).locator("#out")).toContainText("Other");
});

test("right-click turns a plugin off; new permissions close it after it saves, and ask again", async ({ page, daemon }) => {
  await setup(page, daemon);
  await turnOnFromCard(page);

  await sidebarPlugins(page).getByRole("button", { name: "Echo" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Turn off" }).click();
  await expect(sidebarPlugins(page)).toHaveCount(0);
  await turnOnFromCard(page); // off means it needs approval again

  await openDoc(page, "Bench");
  await page.getByRole("button", { name: "Open Echo" }).click();
  await expect(echoFrame(page).locator("#ctx")).toContainText("doc ");

  const manifest = path.join(daemon.home, ".rooms/plugins/echo/manifest.json");
  const m = JSON.parse(await fs.readFile(manifest, "utf8"));
  m.permissions = ["rooms.read", "clipboard"];
  await fs.writeFile(manifest, JSON.stringify(m));

  const card = page.getByRole("dialog", { name: "New plugin: Echo" });
  await expect(card).toBeVisible({ timeout: 5000 });
  await expect(card.getByText("Can copy and paste")).toBeVisible();
  await expect(page.locator('iframe[title="Echo"]')).toHaveCount(0);
  await expect.poll(() => daemon.exists(".rooms/plugins/echo/data/closed.txt")).toBe(true);
});

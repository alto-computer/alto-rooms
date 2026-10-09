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

const manifestPath = (daemon: Daemon) => path.join(daemon.home, ".rooms/plugins/echo/manifest.json");

async function setPermissions(daemon: Daemon, permissions: string[]) {
  const m = JSON.parse(await fs.readFile(manifestPath(daemon), "utf8"));
  m.permissions = permissions;
  await fs.writeFile(manifestPath(daemon), JSON.stringify(m));
}

async function setup(page: Page, daemon: Daemon, permissions?: string[]) {
  const bench = await daemon.createRoom("Bench");
  const other = await daemon.createRoom("Other");
  await daemon.write("Bench/latency.html", "<title>Latency report</title><p>p95 118 ms</p>");
  await daemon.installPlugin("echo");
  if (permissions) await setPermissions(daemon, permissions);
  await page.goto("/");
  return { bench, other };
}

async function turnOnFromCard(page: Page, asks: string[] = ["Can see your rooms and artifacts"]) {
  const card = page.getByRole("dialog", { name: "New plugin: Echo" });
  await expect(card).toBeVisible({ timeout: 5000 });
  for (const text of asks) await expect(card.getByText(text)).toBeVisible();
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
  await expect(page.getByRole("button", { name: "Open Echo" }).locator("svg.lucide-palette")).toBeVisible();
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

  // ⌘[ goes back to the document the tab showed before. In the app ⌘[ is a menu accelerator and works from
  // inside a frame; in a browser the key would stay in the frame, so give focus back to the app first.
  await page.getByRole("tab", { name: "Echo", selected: true }).focus();
  await page.keyboard.press("Meta+BracketLeft");
  await expect(page.getByRole("tab", { name: "Latency report", selected: true })).toBeVisible();
});

test("a plugin without rooms.read is refused when it lists rooms", async ({ page, daemon }) => {
  await setup(page, daemon, []);
  await turnOnFromCard(page, []);
  await sidebarPlugins(page).getByRole("button", { name: "Echo" }).click();
  await expect(echoFrame(page).locator("#ctx")).toHaveText("tab");
  await echoFrame(page).getByRole("button", { name: "List rooms" }).click();
  await expect(echoFrame(page).locator("#out")).toHaveText("error permission_denied");
});

test("right-click turns a plugin off and on; new permissions close it after it saves, and ask again", async ({ page, daemon }) => {
  await setup(page, daemon);
  await turnOnFromCard(page);

  await sidebarPlugins(page).getByRole("button", { name: "Echo" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Turn off" }).click();
  // Off is the user's choice: no card, the row stays, dimmed.
  await expect(sidebarPlugins(page).getByText("Off")).toBeVisible();
  await expect(page.getByRole("dialog", { name: /Echo/ })).toHaveCount(0);
  await sidebarPlugins(page).getByText("Echo").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Turn on" }).click();
  await expect(sidebarPlugins(page).getByRole("button", { name: "Echo" })).toBeVisible();

  await openDoc(page, "Bench");
  await page.getByRole("button", { name: "Open Echo" }).click();
  await expect(echoFrame(page).locator("#ctx")).toContainText("doc ");

  await setPermissions(daemon, ["rooms.read", "clipboard"]);

  const card = page.getByRole("dialog", { name: "Updated plugin: Echo" });
  await expect(card).toBeVisible({ timeout: 5000 });
  await expect(card.getByText("Can copy and paste")).toBeVisible();
  await expect(card.getByText("Can see your rooms and artifacts")).toHaveCount(0); // only what's new
  await expect(page.locator('iframe[title="Echo"]')).toHaveCount(0);
  await expect.poll(() => daemon.exists(".rooms/plugins/echo/data/closed.txt")).toBe(true);

  await card.getByRole("button", { name: "Turn on" }).click();
  await expect(card).toBeHidden();
  await expect(echoFrame(page).locator("#ctx")).toContainText("doc ");
});

test("a content-script plugin says it reads documents, and turning it on adds no tab or panel", async ({ page, daemon }) => {
  await daemon.createRoom("Bench");
  await daemon.write("Bench/latency.html", "<title>Latency report</title><p>p95 118 ms</p>");
  await daemon.write(
    ".rooms/plugins/marker/manifest.json",
    JSON.stringify({
      id: "marker",
      name: "Marker",
      version: "0.1.0",
      minAppVersion: "0.3.0",
      permissions: ["artifact.content"],
      contentScripts: ["content.js"],
    }),
  );
  await daemon.write(".rooms/plugins/marker/content.js", "document.documentElement.dataset.marker = '1';");
  await page.goto("/");

  const card = page.getByRole("dialog", { name: "New plugin: Marker" });
  await expect(card).toBeVisible({ timeout: 5000 });
  await expect(card.getByRole("listitem")).toHaveText(["Adds scripts inside artifacts", "Can read the text of artifacts and use the network inside them"]);
  await card.getByRole("button", { name: "Turn on" }).click();
  await expect(card).toBeHidden();

  await expect(sidebarPlugins(page).getByText("Marker")).toBeVisible();
  await expect(sidebarPlugins(page).getByRole("button", { name: "Marker" })).toHaveCount(0);
  await openDoc(page, "Bench");
  await expect(page.getByRole("button", { name: "Open Marker" })).toHaveCount(0);
  await expect(page.locator('iframe[title="Marker"]')).toHaveCount(0);
});

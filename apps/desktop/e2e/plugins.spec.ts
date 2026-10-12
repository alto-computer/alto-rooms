import fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test, type Daemon } from "./fixtures";

/** Opens the sidebar's Plugins flyout and returns it. */
async function flyout(page: Page) {
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  return page.getByRole("menu", { name: "Plugins" });
}
const pluginSwitch = (page: Page, name: string) => page.getByRole("region", { name: "Plugins" }).getByRole("switch", { name });
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

async function openArtifact(page: Page, roomName: string) {
  await page.getByRole("list", { name: "Rooms" }).getByRole("button", { name: roomName }).click();
  await page.getByTestId("artifact-card").filter({ hasText: "Latency report" }).getByRole("button", { name: "Latency report" }).click();
  await expect(page.getByRole("tab", { name: "Latency report", selected: true })).toBeVisible();
}

test("a plugin is asked about, runs beside a document, keeps its notes across a move, and opens as a tab", async ({ page, daemon }) => {
  const { bench, other } = await setup(page, daemon);
  await expect(page.locator('iframe[title="Echo"]')).toHaveCount(0); // nothing runs before Turn on
  await turnOnFromCard(page);
  await expect((await flyout(page)).getByRole("menuitem", { name: "Echo" })).toBeVisible();
  await page.keyboard.press("Escape");

  type Artifact = { id: string; fileKey: string };
  await expect.poll(async () => ((await api(daemon, "GET", `/v1/rooms/${bench.id}/artifacts`)) as Artifact[]).length).toBe(1);
  const [artifact] = (await api(daemon, "GET", `/v1/rooms/${bench.id}/artifacts`)) as Artifact[];
  await openArtifact(page, "Bench");
  await expect(page.getByRole("button", { name: "Open Echo" }).locator("svg.lucide-palette")).toBeVisible();
  await page.getByRole("button", { name: "Open Echo" }).click();
  await expect(echoFrame(page).locator("#ctx")).toHaveText(`artifact ${artifact.fileKey}`);
  await echoFrame(page).getByRole("button", { name: "Save" }).click();
  await expect(echoFrame(page).locator("#out")).toHaveText(`saved ${artifact.fileKey}`);
  expect(await daemon.read(".rooms/plugins/echo/data/echo.txt")).toBe(artifact.fileKey);

  // Rooms moves the (plain-file) artifact to another room: same original, same fileKey, same notes.
  await api(daemon, "POST", "/v1/artifacts/move", { roomId: bench.id, artifactId: artifact.id, toRoomId: other.id });
  await openArtifact(page, "Other");
  await expect(echoFrame(page).locator("#ctx")).toHaveText(`artifact ${artifact.fileKey}`);

  // The flyout opens the plugin as a tab; it can list rooms (rooms.read).
  await (await flyout(page)).getByRole("menuitem", { name: "Echo" }).click();
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
  await (await flyout(page)).getByRole("menuitem", { name: "Echo" }).click();
  await expect(echoFrame(page).locator("#ctx")).toHaveText("tab");
  await echoFrame(page).getByRole("button", { name: "List rooms" }).click();
  await expect(echoFrame(page).locator("#out")).toHaveText("error permission_denied");
});

test("Settings turns a plugin off and on; new permissions close it after it saves, and ask again", async ({ page, daemon }) => {
  await setup(page, daemon);
  await turnOnFromCard(page);

  await (await flyout(page)).getByRole("menuitem", { name: "Plugin settings…" }).click();
  await expect(page.getByRole("tab", { name: "Settings", selected: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Plugins" })).toBeInViewport();
  await expect(page.getByRole("list", { name: "Echo: what it adds and can do" }).getByRole("listitem")).toHaveText(["Adds a tab", "Adds a panel beside artifacts", "Can see your rooms and artifacts"]);
  await pluginSwitch(page, "Echo").click();
  await expect(pluginSwitch(page, "Echo")).not.toBeChecked();
  // Off is the user's choice: no card, and nothing beside documents.
  await expect(page.getByRole("dialog", { name: /Echo/ })).toHaveCount(0);
  await openArtifact(page, "Bench");
  await expect(page.getByRole("button", { name: "Open Echo" })).toHaveCount(0);
  await page.getByRole("button", { name: /^Settings/ }).click();
  await pluginSwitch(page, "Echo").click();
  await expect(pluginSwitch(page, "Echo")).toBeChecked();

  await openArtifact(page, "Bench");
  await page.getByRole("button", { name: "Open Echo" }).click();
  await expect(echoFrame(page).locator("#ctx")).toContainText("artifact ");

  await setPermissions(daemon, ["rooms.read", "clipboard"]);

  const card = page.getByRole("dialog", { name: "Updated plugin: Echo" });
  await expect(card).toBeVisible({ timeout: 5000 });
  await expect(card.getByText("Can copy and paste")).toBeVisible();
  await expect(card.getByText("Can see your rooms and artifacts")).toHaveCount(0); // only what's new
  await expect(page.locator('iframe[title="Echo"]')).toHaveCount(0);
  await expect.poll(() => daemon.exists(".rooms/plugins/echo/data/closed.txt")).toBe(true);

  await card.getByRole("button", { name: "Turn on" }).click();
  await expect(card).toBeHidden();
  await expect(echoFrame(page).locator("#ctx")).toContainText("artifact ");
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

  // No tab to open: the flyout leaves it out, and Settings lists it.
  await expect((await flyout(page)).getByRole("menuitem")).toHaveText(["Plugin settings…"]);
  await page.getByRole("menuitem", { name: "Plugin settings…" }).click();
  await expect(pluginSwitch(page, "Marker")).toBeChecked();
  await openArtifact(page, "Bench");
  await expect(page.getByRole("button", { name: "Open Marker" })).toHaveCount(0);
  await expect(page.locator('iframe[title="Marker"]')).toHaveCount(0);
});

test("a plugin page takes the app's theme, and follows it into dark", async ({ page, daemon }) => {
  await setup(page, daemon);
  await page.emulateMedia({ colorScheme: "light" });
  await turnOnFromCard(page);
  await (await flyout(page)).getByRole("menuitem", { name: "Echo" }).click();
  await expect(echoFrame(page).locator("#ctx")).toHaveText("tab");

  // The app's pane colour as the browser would paint it, so it compares with the plugin page's computed background.
  const pane = () =>
    page.evaluate(() => {
      const probe = document.createElement("div");
      probe.style.background = "var(--pane)";
      document.body.append(probe);
      const colour = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return colour;
    });
  const pageStyle = () =>
    echoFrame(page)
      .locator("html")
      .evaluate((el) => {
        const s = getComputedStyle(el);
        return { background: s.backgroundColor, colorScheme: s.colorScheme, bg: s.getPropertyValue("--rooms-bg").trim() };
      });

  const light = await pane();
  await expect.poll(pageStyle).toMatchObject({ background: light, colorScheme: "light" });

  await page.getByRole("button", { name: /^Settings/ }).click();
  await page.getByRole("radiogroup", { name: "Appearance" }).getByRole("radio", { name: "Dark" }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(true);
  const dark = await pane();
  expect(dark).not.toBe(light);
  await page.getByRole("tab", { name: "Echo" }).click();
  await expect.poll(pageStyle).toMatchObject({ background: dark, colorScheme: "dark" });
  expect((await pageStyle()).bg).not.toBe("");
});

test("a plugin on an older SDK keeps a white frame in dark, while one on this SDK gets the pane colour", async ({ page, daemon }) => {
  // Relic: a tab plugin shaped like a plugin on SDK 0.6: it says ready without a theme flag and never styles itself.
  await daemon.write(
    ".rooms/plugins/relic/manifest.json",
    JSON.stringify({ id: "relic", name: "Relic", version: "0.1.0", minAppVersion: "0.1.0", permissions: [], slots: { tab: { title: "Relic", icon: "puzzle", sidebar: true } } }),
  );
  await daemon.write(".rooms/plugins/relic/index.html", '<!doctype html><html><head><meta charset="utf-8"><title>Relic</title></head><body><p id="ctx">connecting</p><script src="main.js"></script></body></html>');
  await daemon.write(
    ".rooms/plugins/relic/main.js",
    [
      'window.addEventListener("message", (e) => {',
      '  if (e.source !== window.parent || !e.data || e.data.rooms !== 1) return;',
      '  if (e.data.type === "context") document.getElementById("ctx").textContent = e.data.context.slot;',
      '  if (e.data.type === "ping") window.parent.postMessage({ rooms: 1, type: "pong", id: e.data.id }, "*");',
      "});",
      'window.parent.postMessage({ rooms: 1, type: "ready" }, "*");',
    ].join("\n"),
  );
  await setup(page, daemon);
  await turnOnFromCard(page);
  const relicCard = page.getByRole("dialog", { name: "New plugin: Relic" });
  await expect(relicCard).toBeVisible({ timeout: 5000 });
  await relicCard.getByRole("button", { name: "Turn on" }).click();
  await expect(relicCard).toBeHidden();

  await page.getByRole("button", { name: /^Settings/ }).click();
  await page.getByRole("radiogroup", { name: "Appearance" }).getByRole("radio", { name: "Dark" }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(true);

  const frameBackground = (title: string) => page.locator(`iframe[title="${title}"]`).evaluate((el) => getComputedStyle(el).backgroundColor);
  await (await flyout(page)).getByRole("menuitem", { name: "Relic" }).click();
  const relic = page.frameLocator('iframe[title="Relic"]');
  await expect(relic.locator("#ctx")).toHaveText("tab");
  expect(await frameBackground("Relic"), "a page that never said it applies the theme sits on white").toBe("rgb(255, 255, 255)");
  // In WKWebView the page itself is transparent, so the white frame is what keeps its default black text readable.
  expect(await relic.locator("body").evaluate((el) => ({ color: getComputedStyle(el).color, background: getComputedStyle(el.ownerDocument.documentElement).backgroundColor }))).toEqual({
    color: "rgb(0, 0, 0)",
    background: "rgba(0, 0, 0, 0)",
  });

  await (await flyout(page)).getByRole("menuitem", { name: "Echo" }).click();
  await expect(echoFrame(page).locator("#ctx")).toHaveText("tab");
  const pane = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.background = "var(--pane)";
    document.body.append(probe);
    const colour = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return colour;
  });
  await expect.poll(() => frameBackground("Echo"), "a page on this SDK said so on ready, and its frame took the pane colour").toBe(pane);
  expect(pane).not.toBe("rgb(255, 255, 255)");
});

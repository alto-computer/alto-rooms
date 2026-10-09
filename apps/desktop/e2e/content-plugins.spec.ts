/*
 * Content scripts: roomsd splices the content scripts of the plugins the user
 * turned on into a doc tab's document, right after <head>, next to the selection
 * bridge. Card previews get the bridge alone. The name matches the WebKit
 * project's pattern, so this runs on both engines.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { FrameLocator, Page } from "@playwright/test";
import { expect, FILES_PORT, test, type Daemon } from "./fixtures";

const CSP_FIXTURES = path.join(import.meta.dirname, "fixtures", "csp");

async function api(daemon: Daemon, method: string, p: string, body?: unknown) {
  const r = await fetch(`${daemon.baseUrl}${p}`, {
    method,
    headers: { authorization: `Bearer ${daemon.token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

async function turnOnMarker(page: Page) {
  const card = page.getByRole("dialog", { name: "New plugin: Marker" });
  await expect(card).toBeVisible({ timeout: 5000 });
  await card.getByRole("button", { name: "Turn on" }).click();
  await expect(card).toBeHidden();
}

/** Opens the doc from its card in the Bench room grid, once the card's preview has loaded. */
async function openDoc(page: Page, title: string) {
  if (!(await page.getByRole("tab", { name: "Bench", selected: true }).isVisible())) {
    await page.getByRole("list", { name: "Rooms" }).getByRole("button", { name: "Bench" }).click();
  }
  const button = page.getByTestId("artifact-card").filter({ hasText: title }).getByRole("button", { name: title });
  await button.scrollIntoViewIfNeeded();
  await expect(cardFrame(page, title).locator("#text")).toBeVisible();
  await button.click();
  await expect(page.getByRole("tab", { name: title, selected: true })).toBeVisible();
}

/** The doc tab's frame: the card preview frame has the same title but is aria-hidden. */
const docFrameEl = (page: Page, title: string) => page.locator(`iframe[title="${title}"]:not([aria-hidden])`);
const docFrame = (page: Page, title: string): FrameLocator => page.frameLocator(`iframe[title="${title}"]:not([aria-hidden])`);
const cardFrame = (page: Page, title: string): FrameLocator => page.getByTestId("artifact-card").filter({ hasText: title }).frameLocator(`iframe[title="${title}"]`);

/** Selects the paragraph's text inside the frame the way a drag would end up: a selection change the bridge reports. */
async function selectText(frame: FrameLocator) {
  await frame.locator("#text").evaluate((el) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    const s = getSelection()!;
    s.removeAllRanges();
    s.addRange(r);
  });
}

test("a doc tab runs the content scripts of plugins that are on; cards don't; off reloads the doc without them", async ({ page, daemon }) => {
  await daemon.createRoom("Bench");
  await daemon.write("Bench/report.html", "<!doctype html><html><head><meta charset=\"utf-8\"><title>Report</title></head><body><p id=\"text\">p95 118 ms</p></body></html>");
  await daemon.installPlugin("marker");
  await page.goto("/");
  await turnOnMarker(page);

  await page.getByRole("list", { name: "Rooms" }).getByRole("button", { name: "Bench" }).click();
  const card = cardFrame(page, "Report");
  await expect(card.locator("#text")).toHaveText("p95 118 ms");
  await expect(card.locator("html")).not.toHaveAttribute("data-marker");

  await openDoc(page, "Report");
  const doc = docFrame(page, "Report");
  await expect(doc.locator("html")).toHaveAttribute("data-marker", "1");
  const withMarker = await docFrameEl(page, "Report").getAttribute("src");
  expect(withMarker).toContain("doc=1&cs=");

  await page.getByRole("button", { name: "Back (⌘[)" }).click();
  await expect(card.locator("#text")).toHaveText("p95 118 ms");
  await expect(card.locator("html"), "the card preview keeps running without the script").not.toHaveAttribute("data-marker");
  await page.getByRole("button", { name: "Forward (⌘])" }).click();
  await expect(doc.locator("html")).toHaveAttribute("data-marker", "1");

  await api(daemon, "PATCH", "/v1/plugins/marker", { enabled: false });
  await expect(docFrameEl(page, "Report"), "turning the plugin off gives the doc frame a new URL").not.toHaveAttribute("src", withMarker!);
  await expect(doc.locator("#text")).toHaveText("p95 118 ms");
  await expect(doc.locator("html"), "the reloaded doc runs no content script").not.toHaveAttribute("data-marker");

  await api(daemon, "PATCH", "/v1/plugins/marker", { enabled: true });
  const [bench] = await daemon.listRooms().then((rs) => rs.filter((r) => r.name === "Bench"));
  const files = `http://127.0.0.1:${FILES_PORT}/${bench.id}/report.html`;
  const served = await (await fetch(`${files}?doc=1`)).text();
  expect(served, "the doc variant: bridge, then the tag, right after <head>").toMatch(
    new RegExp(`^<!doctype html><html><head><script data-rooms-bridge>[\\s\\S]*</script>\n<script src="http://127\\.0\\.0\\.1:${FILES_PORT}/_plugins/marker/content\\.js\\?r=[0-9a-f]{12}"></script>\n<meta charset="utf-8">`),
  );
  expect(served.endsWith("</body></html>"), "nothing after </html>").toBe(true);
  const preview = await (await fetch(files)).text();
  expect(preview, "the card variant has no plugin tag").not.toContain("_plugins");
  expect(preview).toContain("<head><script data-rooms-bridge>");
});

test("the bridge and the content scripts run under every artifact CSP, and a late <meta charset> still decodes", async ({ page, daemon }) => {
  await daemon.createRoom("Bench");
  const names = (await fs.readdir(CSP_FIXTURES)).filter((f) => f.endsWith(".html")).sort();
  for (const f of names) await daemon.write(`Bench/${f}`, await fs.readFile(path.join(CSP_FIXTURES, f), "utf8"));
  const korean = "한글 본문이 깨지지 않고 보여야 합니다.";
  await daemon.write("Bench/korean.html", `<!doctype html><html><head>${"<!-- 채움 -->".repeat(100)}<meta charset="utf-8"><title>Korean</title></head><body><p id="text">${korean}</p></body></html>`);
  await daemon.installPlugin("marker");
  await page.goto("/");
  await turnOnMarker(page);

  const titles = new Map<string, string>();
  for (const f of names) titles.set(f, (await fs.readFile(path.join(CSP_FIXTURES, f), "utf8")).match(/<title>(.*)<\/title>/)![1]);
  titles.set("korean.html", "Korean");
  for (const [f, title] of titles) {
    await openDoc(page, title);
    const doc = docFrame(page, title);
    await expect(doc.locator("html"), f).toHaveAttribute("data-marker", "1");
    await selectText(doc);
    await expect(page.getByRole("button", { name: "Ask" }), f).toBeVisible();
    if (f === "csp-nonce.html") await expect(doc.locator("html"), "the document's own nonce script still runs").toHaveAttribute("data-own", "1");
    if (f === "korean.html") await expect(doc.locator("#text"), "the header charset wins when the splice pushes <meta charset> past the 1,024-byte prescan").toHaveText(korean);
    await page.keyboard.press("Escape");
  }
});

/** Every file under a plugin's data folder, relative to it. */
async function dataFiles(daemon: Daemon, plugin: string): Promise<string[]> {
  const dir = path.join(daemon.home, ".rooms", "plugins", plugin, "data");
  if (!(await fs.stat(dir).catch(() => null))) return [];
  return (await fs.readdir(dir, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).map((e) => path.relative(dir, path.join(e.parentPath, e.name))).sort();
}

async function fileKeyOf(daemon: Daemon, room: string, title: string): Promise<string> {
  const [r] = (await daemon.listRooms()).filter((x) => x.name === room);
  const list = (await api(daemon, "GET", `/v1/rooms/${r.id}/artifacts`)) as { title: string; fileKey: string }[];
  return list.find((a) => a.title === title)!.fileKey;
}

test("a content script stores data for its document through the app, and its action joins Ask in one bar", async ({ page, daemon }) => {
  await daemon.createRoom("Bench");
  await daemon.write("Bench/report.html", "<!doctype html><html><head><meta charset=\"utf-8\"><title>Report</title></head><body><p id=\"text\">p95 118 ms</p></body></html>");
  await daemon.installPlugin("marker");
  await page.goto("/");
  await turnOnMarker(page);
  await openDoc(page, "Report");
  const doc = docFrame(page, "Report");
  await expect(doc.locator("html"), "wrote marks.json, then read it back").toHaveAttribute("data-marker-read", "Report");
  const key = await fileKeyOf(daemon, "Bench", "Report");
  expect(await dataFiles(daemon, "marker")).toEqual([`docs/${key}/marks.json`]);
  expect(JSON.parse(await daemon.read(`.rooms/plugins/marker/data/docs/${key}/marks.json`))).toEqual({ title: "Report" });

  await selectText(doc);
  const bar = page.getByRole("toolbar", { name: "Selection actions" });
  await expect(bar).toBeVisible();
  await expect(bar.getByRole("button")).toHaveText(["Ask", "Mark"]);
  await bar.getByRole("button", { name: "Mark" }).click();
  await expect(doc.locator("html")).toHaveAttribute("data-marker-selected", "p95 118 ms");
  await expect(bar).toBeHidden();

  await selectText(doc);
  await page.getByRole("button", { name: "Ask" }).click();
  await expect(page.getByRole("list", { name: "Quoted text" })).toContainText("p95 118 ms");
});

test("a hostile document can only touch its own folder of the plugins that are on, and only 20 writes a second", async ({ page, daemon }) => {
  await daemon.createRoom("Bench");
  const forged = "ffffffffffffffff";
  await daemon.write(
    "Bench/hostile.html",
    `<!doctype html><html><head><meta charset="utf-8"><title>Hostile</title></head><body><p id="text">hostile</p><script>
const results = {};
addEventListener("message", (e) => {
  const d = e.data;
  if (!d || d.rooms !== "content" || d.type !== "reply") return;
  results[d.id] = d.error ? d.error.code : "ok";
  document.body.dataset.results = JSON.stringify(results);
});
const send = (m) => parent.postMessage({ rooms: "content", v: 1, ...m }, "*");
send({ plugin: "marker", type: "storage.write", id: "escape", path: "../other/marks.json", text: "x" });
send({ plugin: "marker", type: "storage.write", id: "token", path: "../../../../token", text: "x" });
send({ plugin: "marker", type: "storage.read", id: "readToken", path: "../../../../token" });
send({ plugin: "echo", type: "storage.write", id: "otherPlugin", path: "stolen.json", text: "x" });
send({ plugin: "marker", type: "storage.write", id: "forgedKey", fileKey: "${forged}", path: "forged.json", text: "x" });
send({ plugin: "marker", type: "storage.write", id: "nested", path: "docs/${forged}/marks.json", text: "x" });
setTimeout(() => { for (let i = 0; i < 500; i++) send({ plugin: "marker", type: "storage.write", id: "flood" + i, path: "flood/" + i + ".json", text: String(i) }); }, 1500);
</script></body></html>`,
  );
  await daemon.installPlugin("marker");
  await daemon.installPlugin("echo");
  await api(daemon, "PATCH", "/v1/plugins/echo", { enabled: true, permissions: ["rooms.read"] });
  const tokenBefore = await daemon.read(".rooms/token");
  await page.goto("/");
  await turnOnMarker(page);
  await openDoc(page, "Hostile");
  const doc = docFrame(page, "Hostile");
  await expect(doc.locator("html")).toHaveAttribute("data-marker-read", "Hostile");
  const results = async () => JSON.parse((await doc.locator("body").getAttribute("data-results")) ?? "{}") as Record<string, string>;
  await expect.poll(async () => Object.keys(await results()).filter((k) => k.startsWith("flood")).length, { timeout: 10_000 }).toBe(500);
  const r = await results();
  expect({ escape: r.escape, token: r.token, readToken: r.readToken, otherPlugin: r.otherPlugin }).toEqual({
    escape: "invalid_path",
    token: "invalid_path",
    readToken: "invalid_path",
    otherPlugin: undefined,
  });
  const flood = Object.entries(r).filter(([k]) => k.startsWith("flood"));
  const ok = flood.filter(([, v]) => v === "ok").length;
  expect(ok, "at most 20 writes in that second").toBeLessThanOrEqual(20);
  expect(ok).toBeGreaterThan(0);
  expect(flood.filter(([, v]) => v !== "ok" && v !== "rate_limited")).toEqual([]);

  const key = await fileKeyOf(daemon, "Bench", "Hostile");
  const files = await dataFiles(daemon, "marker");
  expect(files.filter((f) => !f.startsWith(`docs/${key}/flood/`)), "every write landed under this document's folder").toEqual(
    [`docs/${key}/docs/${forged}/marks.json`, `docs/${key}/forged.json`, `docs/${key}/marks.json`].sort(),
  );
  expect(files.filter((f) => f.startsWith(`docs/${key}/flood/`))).toHaveLength(ok);
  expect(await dataFiles(daemon, "echo"), "a plugin without artifact.content gets nothing").toEqual([]);
  expect(await daemon.read(".rooms/token")).toBe(tokenBefore);
  await page.getByRole("button", { name: "Back (⌘[)" }).click();
  await expect(page.getByRole("tab", { name: "Bench", selected: true }), "the app stays responsive").toBeVisible({ timeout: 1000 });
});

const tabs = (page: Page) => page.getByRole("tablist", { name: "Tabs" }).getByRole("tab");
const tabNamed = (page: Page, name: string) => page.getByRole("tablist", { name: "Tabs" }).getByRole("tab", { name, exact: true });
const pluginFrame = (page: Page, title: string) => page.frameLocator(`iframe[title="${title}"]`);

async function writeDocs(daemon: Daemon) {
  await daemon.createRoom("Bench");
  for (const [file, title] of [["report.html", "Report"], ["second.html", "Second"]]) {
    await daemon.write(`Bench/${file}`, `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><p id="text">${title} body</p></body></html>`);
  }
}

/** Types into the marker tab and clicks "Open at anchor". */
async function openFromMarker(page: Page, fileKey: string, anchor: string) {
  const tab = pluginFrame(page, "Marker");
  await tab.locator("#fileKey").fill(fileKey);
  await tab.locator("#anchor").fill(anchor);
  await tab.getByRole("button", { name: "Open at anchor" }).click();
}

test("a plugin tab opens a doc next to it at an anchor; an open doc comes forward and gets the next one; a reopened doc gets none", async ({ page, daemon }) => {
  await writeDocs(daemon);
  await daemon.installPlugin("marker");
  await page.goto("/");
  await turnOnMarker(page);
  const key = await fileKeyOf(daemon, "Bench", "Report");

  await page.getByRole("list", { name: "Plugins" }).getByRole("button", { name: "Marker" }).click();
  await expect(tabNamed(page, "Marker")).toHaveAttribute("aria-selected", "true");
  await openFromMarker(page, key, '{"mark":"x"}');
  await expect(tabNamed(page, "Report"), "the doc opens in its own tab").toHaveAttribute("aria-selected", "true");
  await expect(tabs(page), "the plugin tab stays, with the doc right after it").toHaveText(["Marker", "Report"]);
  const doc = docFrame(page, "Report");
  await expect(doc.locator("html")).toHaveAttribute("data-marker-reveal", '{"mark":"x"}');
  await expect(doc.locator("html")).toHaveAttribute("data-marker-reveals", "1");

  await tabNamed(page, "Marker").click();
  await openFromMarker(page, key, '{"mark":"y"}');
  await expect(tabNamed(page, "Report")).toHaveAttribute("aria-selected", "true");
  await expect(tabs(page), "no second tab for the same doc").toHaveCount(2);
  await expect(doc.locator("html"), "the doc kept in the background gets the new anchor").toHaveAttribute("data-marker-reveal", '{"mark":"y"}');
  await expect(doc.locator("html")).toHaveAttribute("data-marker-reveals", "2");
  await selectText(doc);
  await expect(page.getByRole("toolbar", { name: "Selection actions" }).getByRole("button"), "its plugin actions survive the trip to the background").toHaveText(["Ask", "Mark"]);
  await page.keyboard.press("Escape");

  await tabNamed(page, "Marker").click();
  await openFromMarker(page, key, JSON.stringify({ pad: "x".repeat(5 * 1024) }));
  await expect(pluginFrame(page, "Marker").locator("#out")).toHaveText("error bad_request");
  await expect(tabNamed(page, "Marker"), "a refused anchor opens nothing").toHaveAttribute("aria-selected", "true");

  await page.getByRole("tablist", { name: "Tabs" }).locator("[role=presentation]", { has: page.getByRole("tab", { name: "Report", exact: true }) }).getByRole("button", { name: "Close tab" }).click();
  await expect(tabs(page)).toHaveCount(1);
  await openDoc(page, "Report");
  await expect(doc.locator("html"), "the reopened doc's script ran").toHaveAttribute("data-marker-read", "Report");
  await expect(doc.locator("html"), "and got no stale anchor").not.toHaveAttribute("data-marker-reveal");
});

test("open from a side panel replaces its doc tab; from a plugin tab it opens a new tab and keeps the plugin tab", async ({ page, daemon }) => {
  await writeDocs(daemon);
  await daemon.installPlugin("echo");
  await api(daemon, "PATCH", "/v1/plugins/echo", { enabled: true, permissions: ["rooms.read"] });
  await page.goto("/");
  const echo = pluginFrame(page, "Echo");

  await openDoc(page, "Report");
  await page.getByRole("button", { name: "Open Echo" }).click();
  await echo.locator("#fileKey").fill(await fileKeyOf(daemon, "Bench", "Second"));
  await echo.getByRole("button", { name: "Open doc" }).click();
  await expect(tabNamed(page, "Second")).toHaveAttribute("aria-selected", "true");
  await expect(tabs(page), "the side panel navigated its own tab").toHaveText(["Second"]);

  await page.getByRole("list", { name: "Plugins" }).getByRole("button", { name: "Echo" }).click();
  await expect(tabNamed(page, "Echo")).toHaveAttribute("aria-selected", "true");
  await echo.locator("#fileKey").fill(await fileKeyOf(daemon, "Bench", "Report"));
  await echo.getByRole("button", { name: "Open doc" }).click();
  await expect(tabNamed(page, "Report")).toHaveAttribute("aria-selected", "true");
  await expect(tabs(page)).toHaveText(["Echo", "Report"]);
});

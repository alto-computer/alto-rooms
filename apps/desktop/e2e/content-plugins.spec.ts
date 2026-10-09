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

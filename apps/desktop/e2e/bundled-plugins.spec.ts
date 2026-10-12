/*
 * The plugins the desktop app ships (Goals, Excalidraw notes, Highlights), from their real builds.
 * Fill src-tauri/resources/plugins first: `bun run plugins` (or with ROOMS_PLUGIN_<ID> for local builds).
 */
import { existsSync } from "node:fs";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { APP_ORIGIN, expect, test, type Daemon } from "./fixtures";

const BUNDLED = path.resolve(import.meta.dirname, "../src-tauri/resources/plugins");
test.skip(!existsSync(path.join(BUNDLED, "goals", "manifest.json")), "bundled plugins missing: run `bun run plugins`");
test.use({ bundledPlugins: BUNDLED });

type Artifact = { id: string; fileKey: string };

async function setup(page: Page, daemon: Daemon) {
  const bench = await daemon.createRoom("Bench");
  await daemon.write("Bench/latency.html", "<title>Latency report</title><p>p95 118 ms</p>");
  const csp: string[] = [];
  // The app's own page breaks its CSP with inline styles (since the e2e serves that CSP, 75ac1d5); only plugin frames count here.
  page.on("console", (m) => /Content Security Policy|Refused to/.test(m.text()) && !m.location().url.startsWith(APP_ORIGIN) && csp.push(m.text()));
  await page.goto("/");
  await expect.poll(async () => ((await (await fetch(`${daemon.baseUrl}/v1/rooms/${bench.id}/artifacts`)).json()) as Artifact[]).length).toBe(1);
  const [artifact] = (await (await fetch(`${daemon.baseUrl}/v1/rooms/${bench.id}/artifacts`)).json()) as Artifact[];
  // Bundled plugins get every permission but reading artifacts, which the user approves once on Highlights' card.
  const highlightsCard = page.getByRole("dialog", { name: "Updated plugin: Highlights" });
  await expect(highlightsCard).toContainText("Can read the text of artifacts");
  return { artifact, csp, highlightsCard };
}

async function notNow(card: Locator) {
  await card.getByRole("button", { name: "Not now" }).click();
  await expect(card).toBeHidden();
}

async function openArtifact(page: Page) {
  await page.getByRole("list", { name: "Rooms" }).getByRole("button", { name: "Bench" }).click();
  await page.getByTestId("artifact-card").filter({ hasText: "Latency report" }).getByRole("button", { name: "Latency report" }).click();
  await expect(page.getByRole("tab", { name: "Latency report", selected: true })).toBeVisible();
}

test("Goals comes with the app: no card, a goal links a document and opens it", async ({ page, daemon }) => {
  const { artifact, csp, highlightsCard } = await setup(page, daemon);
  await notNow(highlightsCard);
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  await page.getByRole("menu", { name: "Plugins" }).getByRole("menuitem", { name: "Goals" }).click();
  await expect(page.getByRole("dialog", { name: /plugin/i })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Goals", selected: true })).toBeVisible();

  const goals = page.frameLocator('iframe[title="Goals"]');
  const mid = goals.getByRole("region", { name: "Mid term · this quarter" });
  await mid.getByRole("button", { name: "Add" }).click();
  await mid.getByRole("textbox", { name: "New item" }).fill("Cut p95 below 100 ms");
  await mid.getByRole("textbox", { name: "New item" }).press("Enter");
  await mid.getByRole("textbox", { name: "New item" }).press("Escape");
  await expect(mid.getByText("Cut p95 below 100 ms")).toBeVisible();

  await goals.getByRole("button", { name: "Link a document to Cut p95 below 100 ms" }).click();
  const picker = goals.getByRole("dialog", { name: "Link a document" });
  await picker.getByRole("button", { name: "Bench" }).click();
  await picker.getByRole("button", { name: "Latency report" }).click();
  await expect.poll(() => daemon.read(".rooms/plugins/goals/data/goals.json").catch(() => "")).toContain(artifact.fileKey);

  await goals.getByRole("button", { name: "Open Latency report" }).click();
  await expect(page.getByRole("tab", { name: "Latency report", selected: true })).toBeVisible();
  expect(csp).toEqual([]);
});

test("Excalidraw notes come with the app: a drawing is saved per document and exports as PNG", async ({ page, daemon }) => {
  const { artifact, csp, highlightsCard } = await setup(page, daemon);
  await notNow(highlightsCard);
  await openArtifact(page);
  await page.getByRole("button", { name: "Open Notes" }).click();

  const frame = page.frameLocator('iframe[title="Excalidraw notes"]');
  const canvas = frame.locator("canvas.interactive");
  await expect(canvas).toBeVisible({ timeout: 15_000 });
  // Its handwriting font comes from the plugin folder: the sandbox has no network.
  const plugin = page.frames().find((f) => f.url().includes("/_plugins/excalidraw/"))!;
  expect(
    await plugin.evaluate(() => document.fonts.load("20px Excalifont").then((faces) => faces.some((f) => f.status === "loaded"))),
  ).toBe(true);
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 20);
  await page.keyboard.press("r");
  await page.mouse.move(box.x + 60, box.y + 120);
  await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y + 200, { steps: 8 });
  await page.mouse.up();

  const notes = `.rooms/plugins/excalidraw/data/notes/${artifact.fileKey}.excalidraw`;
  await expect.poll(() => daemon.read(notes).catch(() => ""), { timeout: 5000 }).toContain('"type":"rectangle"');

  const download = page.waitForEvent("download");
  await frame.getByTestId("main-menu-trigger").click();
  await frame.getByText("Export PNG").click();
  expect((await download).suggestedFilename()).toBe("Latency report notes.png");

  // Closing the panel and opening it again shows the same drawing.
  await page.getByRole("button", { name: "Close Notes" }).click();
  await page.getByRole("button", { name: "Open Notes" }).click();
  await expect(frame.locator("canvas.interactive")).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => daemon.read(notes)).toContain('"type":"rectangle"');
  expect(csp).toEqual([]);
});


test("Highlights comes with the app: a highlight in a document is saved, listed in its tab and opens back", async ({ page, daemon }) => {
  const { artifact, csp, highlightsCard } = await setup(page, daemon);
  await highlightsCard.getByRole("button", { name: "Turn on" }).click();
  await expect(highlightsCard).toBeHidden();

  await openArtifact(page);
  const report = page.frameLocator('iframe[title="Latency report"]:not([aria-hidden])');
  await expect(report.locator("rooms-highlight-ui"), "the content script ran").toBeAttached();
  await report.locator("p").click({ clickCount: 3 });
  const bar = page.getByRole("toolbar", { name: "Selection actions" });
  await bar.getByRole("button", { name: "Agree", exact: true }).click();
  await expect(bar).toBeHidden();
  const stored = () =>
    daemon
      .read(`.rooms/plugins/highlight/data/docs/${artifact.fileKey}/highlights.json`)
      .then((t) => (JSON.parse(t) as { highlights: { color: string; text: string }[] }).highlights.map((h) => [h.color, h.text.trim()]))
      .catch(() => []);
  await expect.poll(stored).toEqual([["agree", "p95 118 ms"]]);

  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  await page.getByRole("menu", { name: "Plugins" }).getByRole("menuitem", { name: "Highlights" }).click();
  const tab = page.frameLocator('xpath=//iframe[@title="Highlights"][not(ancestor::*[@data-background-frames])]');
  await expect(tab.locator(".quote")).toHaveText(["p95 118 ms"]);
  await tab.getByRole("button", { name: /p95 118 ms/ }).click();
  await expect(page.getByRole("tab", { name: "Latency report", selected: true })).toBeVisible();
  expect(csp).toEqual([]);
});

test("Notes resize follows across both frames, persists once per drag and cancels cleanly", async ({ page, daemon }, testInfo) => {
  const { csp, highlightsCard } = await setup(page, daemon);
  await notNow(highlightsCard);
  await openArtifact(page);
  await page.getByRole("button", { name: "Open Notes" }).click();
  await expect(page.frameLocator('iframe[title="Excalidraw notes"]').locator("canvas.interactive")).toBeVisible();
  const handle = page.getByRole("separator", { name: "Resize panel" });
  const panel = page.getByRole("complementary", { name: "Notes" });
  await page.evaluate(() => {
    const w = window as any;
    w.resizeWrites = 0;
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "alto-rooms.viewer.v1") w.resizeWrites++;
      return original.call(this, key, value);
    };
  });
  const measurements: unknown[] = [];
  for (const delta of [-300, 300, -200, 200]) {
    const box = (await handle.boundingBox())!;
    const before = (await panel.boundingBox())!.width;
    const x = box.x + box.width / 2;
    const y = box.y + 240;
    const writes = await page.evaluate(() => (window as any).resizeWrites);
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let i = 1; i <= 20; i++) {
      await page.mouse.move(x + delta * i / 20, y);
      await page.evaluate(() => new Promise(requestAnimationFrame));
    }
    const during = (await panel.boundingBox())!.width;
    expect(Math.abs(during - (before - delta))).toBeLessThanOrEqual(2);
    expect(await page.evaluate(() => (window as any).resizeWrites)).toBe(writes);
    await page.mouse.up();
    // Viewer state writes are coalesced (300 ms): one write lands after the drop, never more.
    await expect.poll(() => page.evaluate(() => (window as any).resizeWrites)).toBe(writes + 1);
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => (window as any).resizeWrites)).toBe(writes + 1);
    measurements.push({ delta, before, during, error: during - (before - delta), writes: 1 });
  }
  const box = (await handle.boundingBox())!;
  const beforeCancel = (await panel.boundingBox())!.width;
  await page.mouse.move(box.x + box.width / 2, box.y + 240);
  await page.mouse.down();
  await page.mouse.move(box.x - 100, box.y + 240, { steps: 5 });
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.mouse.up();
  await page.mouse.move(box.x - 200, box.y + 240);
  await expect.poll(async () => (await panel.boundingBox())!.width).toBe(beforeCancel);
  expect(csp).toEqual([]);
  console.log("RESIZE_MEASUREMENTS", testInfo.project.name, JSON.stringify(measurements));
  await testInfo.attach("resize-measurements", { body: JSON.stringify(measurements, null, 2), contentType: "application/json" });
});

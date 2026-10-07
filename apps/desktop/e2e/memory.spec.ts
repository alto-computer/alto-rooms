/*
 * Memory profile: runs the same heavy workload a few times and records the
 * page's heap, DOM nodes, listeners, frames and documents after each run
 * (forced GC first). Growth after the first cycle should be about flat.
 *
 * Skipped unless PROFILE=1 (and chromium only, for CDP):
 *   PROFILE=1 bunx playwright test memory --project chromium
 * The table is printed and attached as memory.json. Set PROFILE_CYCLES to change the count (default 3).
 */
import type { CDPSession, Page } from "@playwright/test";
import { expect, MOD, test, type Daemon } from "./fixtures";

test.skip(!process.env.PROFILE, "memory profile: set PROFILE=1 to run");
// A stuck step should fail in seconds, not at the hour-long test timeout.
// No trace: its DOM snapshot cache holds on to removed nodes and would read as a leak.
test.use({ actionTimeout: 30_000, trace: "off" });

const log = (...a: unknown[]) => console.log(`[memory ${new Date().toISOString().slice(11, 19)}]`, ...a);

const CYCLES = Number(process.env.PROFILE_CYCLES ?? 3);
const DOCS = 80;
const OPEN_CLOSE = 50;

type Sample = { phase: string; heapMB: number; nodes: number; attached: number; listeners: number; frames: number; documents: number; iframeTargets: number };

/** A doc: some run timers and keep a little state, like real agent output. */
function docHtml(i: number): string {
  const script =
    i % 3 === 0
      ? `<script>let n=0;const keep=new Array(2000).fill(0).map((_, k)=>({k,s:"x"+k}));setInterval(()=>{n++;document.getElementById("c").textContent=n+" "+keep.length},100);
requestAnimationFrame(function f(){document.body.style.setProperty("--t",String(performance.now()));requestAnimationFrame(f)});</script>`
      : i % 3 === 1
        ? `<script>setTimeout(()=>{document.getElementById("c").textContent="later"},300);window.addEventListener("resize",()=>{});</script>`
        : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Doc ${i}</title></head>
<body style="font-family:system-ui;padding:48px"><h1>Doc ${i}</h1><p id="c">0</p>${"<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>".repeat(20)}${script}</body></html>`;
}

async function seed(daemon: Daemon) {
  await daemon.createRoom("Alpha");
  await daemon.createRoom("Beta");
  for (let i = 0; i < DOCS; i++) await daemon.write(`Alpha/doc-${String(i).padStart(2, "0")}.html`, docHtml(i));
  for (let i = 0; i < 20; i++) await daemon.write(`Beta/b-${i}.html`, docHtml(i));
  await expect
    .poll(async () => (await daemon.listRooms()).filter((r) => r.name !== "inbox").map((r) => `${r.name}:${r.artifactCount}`).sort(), { timeout: 60_000 })
    .toEqual([`Alpha:${DOCS}`, "Beta:20"]);
}

/** With PROFILE_SNAPSHOT=<prefix>, writes <prefix>-<phase>.heapsnapshot, for finding what grows or holds detached nodes. */
async function snapshot(cdp: CDPSession, phase: string) {
  const prefix = process.env.PROFILE_SNAPSHOT;
  if (!prefix) return;
  const chunks: string[] = [];
  const onChunk = (e: { chunk: string }) => chunks.push(e.chunk);
  cdp.on("HeapProfiler.addHeapSnapshotChunk", onChunk);
  await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
  cdp.off("HeapProfiler.addHeapSnapshotChunk", onChunk);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(`${prefix}-${phase.replace(/\W+/g, "")}.heapsnapshot`, chunks.join(""));
}

async function sample(page: Page, cdp: CDPSession, phase: string): Promise<Sample> {
  for (let i = 0; i < 3; i++) await cdp.send("HeapProfiler.collectGarbage");
  const heap = (await cdp.send("Runtime.getHeapUsage")) as { usedSize: number };
  const { metrics } = (await cdp.send("Performance.getMetrics")) as { metrics: { name: string; value: number }[] };
  const m = (name: string) => metrics.find((x) => x.name === name)?.value ?? -1;
  const { targetInfos } = (await cdp.send("Target.getTargets")) as { targetInfos: { type: string }[] };
  return {
    phase,
    heapMB: Math.round((heap.usedSize / 1024 / 1024) * 100) / 100,
    nodes: m("Nodes"),
    // Nodes in the page's own document; the rest of `nodes` is detached (or in same-process frames).
    attached: await page.evaluate(() => document.getElementsByTagName("*").length),
    listeners: m("JSEventListeners"),
    frames: m("Frames"),
    documents: m("Documents"),
    iframeTargets: targetInfos.filter((t) => t.type === "iframe").length,
  };
}

const tabs = (page: Page) => page.getByRole("tablist", { name: "Tabs" }).getByRole("tab");
const roomButton = (page: Page, name: string) => page.getByRole("list", { name: "Rooms" }).getByRole("button", { name, exact: true });
const cards = (page: Page) => page.getByTestId("artifact-card");

async function scrollGrid(page: Page) {
  const grid = page.locator("[data-grid]");
  await expect(grid).toBeVisible();
  for (let i = 0; i < 12; i++) {
    await grid.evaluate((el) => el.scrollBy(0, 600));
    await page.waitForTimeout(120);
  }
  await grid.evaluate((el) => el.scrollTo(0, 0));
  await page.waitForTimeout(300);
}

/** Opens card `i` of the active room in a new (active) tab and waits for its frame. */
async function openDoc(page: Page, i: number) {
  const card = cards(page).nth(i);
  await card.scrollIntoViewIfNeeded();
  await card.hover();
  await card.getByRole("button", { name: "Open in new tab" }).click();
  await expect(page.locator("main iframe[title^='Doc ']:not([aria-hidden])").first()).toBeAttached();
}

async function closeActive(page: Page) {
  const n = await tabs(page).count();
  // The close button, not ⌘W: that is ignored while the ask input has focus.
  await page
    .getByRole("tablist", { name: "Tabs" })
    .locator("[role=presentation]", { has: page.getByRole("tab", { selected: true }) })
    .getByRole("button", { name: "Close tab" })
    .click();
  await expect(tabs(page)).toHaveCount(Math.max(1, n - 1));
}

async function cycle(page: Page, daemon: Daemon, c: number) {
  log("rooms + grid");
  await roomButton(page, "Beta").click();
  await expect(cards(page)).toHaveCount(20);
  await roomButton(page, "Alpha").click();
  await expect(cards(page)).toHaveCount(DOCS);
  await scrollGrid(page);

  log("edits");
  // Docs changing while shown: artifact events, new preview URLs, reloaded frames.
  for (let i = 0; i < 10; i++) await daemon.write(`Alpha/doc-${String(70 + i).padStart(2, "0")}.html`, docHtml(1000 * c + i));
  await expect(cards(page).filter({ hasText: `Doc ${1000 * c + 9}` })).toHaveCount(1, { timeout: 30_000 });
  await page.waitForTimeout(1000);

  log("open/close docs");
  for (let i = 0; i < OPEN_CLOSE; i++) {
    await openDoc(page, i % DOCS);
    if (i % 5 === 0) {
      await page.keyboard.press(`${MOD}+j`);
      await page.keyboard.press(`${MOD}+j`);
    }
    await closeActive(page);
    await expect(tabs(page)).toHaveCount(1);
  }

  log("switch tabs");
  for (let i = 0; i < 9; i++) {
    await openDoc(page, 10 + i);
    await page.keyboard.press(`${MOD}+1`);
  }
  await expect(tabs(page)).toHaveCount(10);
  for (let k = 1; k <= 9; k++) {
    await page.keyboard.press(`${MOD}+${k}`);
    await page.waitForTimeout(50);
  }
  for (let k = 0; k < 20; k++) {
    await page.keyboard.press(`${MOD}+Shift+BracketRight`);
    await page.waitForTimeout(50);
  }
  // Ask bar on a doc tab.
  await page.keyboard.press(`${MOD}+2`);
  for (let k = 0; k < 6; k++) await page.keyboard.press(`${MOD}+j`);

  log("find");
  for (let k = 0; k < 5; k++) {
    await page.keyboard.press(`${MOD}+k`);
    const input = page.getByPlaceholder("Find a room or doc");
    await expect(input).toBeVisible();
    await input.fill(`Doc ${k}`);
    await page.waitForTimeout(100);
    await page.keyboard.press("Escape");
    await expect(input).toHaveCount(0);
  }

  // Back to one Alpha tab.
  await page.keyboard.press(`${MOD}+1`);
  while ((await tabs(page).count()) > 1) {
    await page.keyboard.press(`${MOD}+2`);
    await closeActive(page);
  }
  await roomButton(page, "Alpha").click();
  // Let card unload delays and slot timeouts run out.
  await page.waitForTimeout(6000);
}

test("memory stays flat across repeated workloads", async ({ page, daemon, browserName }, testInfo) => {
  test.skip(browserName !== "chromium", "needs CDP");
  test.setTimeout(60 * 60_000);
  await seed(daemon);
  await page.goto("/");
  await roomButton(page, "Alpha").click();
  await expect(cards(page)).toHaveCount(DOCS, { timeout: 30_000 });

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("HeapProfiler.enable");
  await page.waitForTimeout(3000);
  const samples = [await sample(page, cdp, "start")];
  for (let c = 1; c <= CYCLES; c++) {
    await cycle(page, daemon, c);
    samples.push(await sample(page, cdp, `cycle ${c}`));
    log(JSON.stringify(samples.at(-1)));
    await snapshot(cdp, `cycle ${c}`);
  }
  console.table(samples);
  await testInfo.attach("memory.json", { body: JSON.stringify(samples, null, 2), contentType: "application/json" });

  // Loose guard: after the first cycle, nodes and frames should not keep climbing.
  const [, first, ...rest] = samples;
  for (const s of rest) {
    expect(s.frames, `${s.phase} frames`).toBeLessThanOrEqual(first.frames + 2);
    expect(s.nodes, `${s.phase} nodes`).toBeLessThan(first.nodes * 1.25 + 500);
    expect(s.listeners, `${s.phase} listeners`).toBeLessThan(first.listeners * 1.25 + 100);
  }
});

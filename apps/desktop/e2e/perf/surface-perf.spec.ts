/*
 * Perf probe for host text surfaces. Not part of `bun run e2e`: run it with
 *   ROOMS_PERF=1 bun run e2e -- perf/surface-perf.spec.ts --project chromium
 * It writes a 30-turn room thread straight into the ask log, then measures, in ms:
 *   - selection-to-bar: triple-click release to the selection bar on screen, with and without tagger;
 *   - paint: the host's cost of one `paint` of 200 ranges (the message listener's capture-to-bubble
 *     span around the hub's work) and the frames until the paint is on screen;
 *   - idle: CPU seconds and RSS of this run's Chromium processes over 10 s, with and without tagger.
 * One JSON line per metric goes to stdout, prefixed PERF.
 */
import { execFileSync } from "node:child_process";
import type { Frame, Page } from "@playwright/test";
import { expect, test, type Daemon } from "../fixtures";


test.skip(!process.env.ROOMS_PERF, "set ROOMS_PERF=1 to run the perf probe");
test.setTimeout(240_000);

const TURNS = 30;
const RANGES = 200;
const RUNS = 20;

const SENTENCE = "The quick brown fox jumps over the lazy dog while the committee reviews the quarterly report. ";
const ANSWER = Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1}. ${SENTENCE.repeat(3)}`).join("\n\n");

function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}
const report = (metric: string, extra: Record<string, unknown>, samples?: number[]) =>
  console.log("PERF", JSON.stringify({ metric, ...extra, ...(samples ? { n: samples.length, p50: quantile(samples, 0.5), p95: quantile(samples, 0.95) } : {}) }));

/** A done thread of `n` long answers, written the way roomsd writes it. */
async function writeThread(daemon: Daemon, roomId: string, n: number) {
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    const at = new Date(Date.UTC(2026, 9, 10, 0, i)).toISOString();
    lines.push(
      JSON.stringify({
        id: `turn${String(i).padStart(12, "0")}`,
        fileKey: null,
        question: `Question ${i + 1}: what does paragraph ${i + 1} say?`,
        answer: ANSWER,
        agent: "fake-stream",
        model: null,
        mode: "resume",
        status: "done",
        error: null,
        startedAt: at,
        endedAt: at,
        images: [],
        kind: "question",
        leftOut: 0,
      }),
    );
  }
  await daemon.write(`.rooms/asks/room-${roomId}.jsonl`, lines.join("\n") + "\n");
}

async function openRoom(page: Page, room: string) {
  await page.getByRole("list", { name: "Rooms" }).getByRole("button", { name: room, exact: true }).click();
  await expect(page.getByRole("tab", { name: room, exact: true, selected: true })).toBeVisible();
  await expect(page.locator("[data-turn-id]")).toHaveCount(TURNS);
}

/** Triple-click release to the bar's first paint, read with a MutationObserver inside the page. */
async function selectionToBar(page: Page, withTag: boolean): Promise<number> {
  const paragraph = page.locator("[data-turn-id]").last().locator("p").last();
  await paragraph.scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    const w = window as unknown as { __barAt?: number };
    w.__barAt = undefined;
    const mo = new MutationObserver(() => {
      if (document.querySelector("[data-selection-ask]")) {
        w.__barAt = performance.now();
        mo.disconnect();
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("mouseup", () => void ((window as unknown as { __upAt?: number }).__upAt = performance.now()), { once: true, capture: true });
  });
  await paragraph.click({ clickCount: 3 });
  const bar = withTag ? page.getByRole("toolbar", { name: "Selection actions" }) : page.getByRole("button", { name: "Ask" });
  await expect(bar).toBeVisible();
  if (withTag) await expect(bar.getByRole("button")).toHaveText(["Ask", "Tag"]);
  const ms = await page.evaluate(() => {
    const w = window as unknown as { __barAt: number; __upAt: number };
    return w.__barAt - w.__upAt;
  });
  await page.keyboard.press("Escape");
  await expect(bar).toBeHidden();
  return ms;
}

/** The host's time inside the `message` event that carries a 200-range paint, and frames until painted. */
async function paintCost(page: Page, frame: Frame): Promise<{ handler: number; frames: number }> {
  await page.evaluate((n) => {
    const w = window as unknown as { __paint?: { start?: number; end?: number; frames?: number } };
    w.__paint = {};
    const isPaint = (e: MessageEvent) => e.data?.rooms === "surface" && e.data?.type === "paint" && Array.isArray(e.data.ranges) && e.data.ranges.length === n;
    window.addEventListener("message", (e) => void (isPaint(e) && (w.__paint!.start = performance.now())), { capture: true, once: false });
    window.addEventListener(
      "message",
      (e) => {
        if (!isPaint(e)) return;
        w.__paint!.end = performance.now();
        let frames = 0;
        const tick = () => {
          frames++;
          const h = CSS.highlights.get("rooms-tagger-amber");
          if (h && h.size === n) w.__paint!.frames = frames;
          else if (frames < 120) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      },
      { capture: false },
    );
  }, RANGES);
  await frame.evaluate((n) => (window as unknown as { tagger: { paintMany(n: number): void } }).tagger.paintMany(n), RANGES);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __paint: { frames?: number } }).__paint.frames)).toBeGreaterThan(0);
  return page.evaluate(() => {
    const p = (window as unknown as { __paint: { start: number; end: number; frames: number } }).__paint;
    return { handler: p.end - p.start, frames: p.frames };
  });
}

/** CPU seconds and RSS (MB) summed over this run's Playwright Chromium processes. */
function chromium(): { cpu: number; rssMb: number; pids: number } {
  const out = execFileSync("ps", ["-axo", "pid=,rss=,cputime=,command="], { encoding: "utf8" });
  let cpu = 0;
  let rss = 0;
  let pids = 0;
  for (const line of out.split("\n")) {
    if (!/ms-playwright.*(chrom|headless)/i.test(line)) continue;
    const [, rssKb, time] = line.trim().split(/\s+/);
    const [h, m, s] = time.split(":").length === 3 ? time.split(":") : ["0", ...time.split(":")];
    cpu += Number(h) * 3600 + Number(m) * 60 + Number(s);
    rss += Number(rssKb) / 1024;
    pids++;
  }
  return { cpu, rssMb: rss, pids };
}

async function idle(page: Page, label: string) {
  await page.waitForTimeout(2000);
  const a = chromium();
  await page.waitForTimeout(10_000);
  const b = chromium();
  report("idle", { label, cpuSeconds: Number((b.cpu - a.cpu).toFixed(2)), rssMb: Number(b.rssMb.toFixed(1)), pids: b.pids });
}

test("surface perf: selection-to-bar, 200-range paint, idle cost", async ({ page, daemon }) => {
  const room = await daemon.createRoom("perf");
  await daemon.write("perf/alpha.html", "<html><head><title>Alpha</title></head><body>a</body></html>");
  await writeThread(daemon, room.id, TURNS);
  const hasTagger = !!process.env.ROOMS_PERF_TAGGER;
  if (hasTagger) await daemon.installPlugin("tagger");
  await page.goto("/");
  let frame: Frame | null = null;
  if (hasTagger) {
    const card = page.getByRole("dialog", { name: "New plugin: Tagger" });
    await card.getByRole("button", { name: "Turn on" }).click();
    await expect(page.locator('iframe[title="Tagger"]')).toHaveCount(1);
    frame = page.frame({ url: /\/_plugins\/tagger\/background\.html/ })!;
    await expect.poll(() => frame!.evaluate(() => typeof (window as unknown as { tagger?: unknown }).tagger)).toBe("object");
  }
  await idle(page, hasTagger ? "tagger on, thread closed" : "no plugin, thread closed");

  const t0 = performance.now();
  await openRoom(page, "perf");
  if (frame) await expect.poll(() => frame!.evaluate(() => (window as unknown as { tagger: { surfaces(): unknown[] } }).tagger.surfaces().length)).toBe(TURNS);
  report("open-30-turns", { label: hasTagger ? "tagger on" : "no plugin", ms: Math.round(performance.now() - t0) });

  const bar: number[] = [];
  for (let i = 0; i < RUNS; i++) bar.push(await selectionToBar(page, hasTagger));
  report("selection-to-bar", { label: hasTagger ? "Ask + Tag" : "Ask only" }, bar);

  if (frame) {
    const handler: number[] = [];
    const frames: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const r = await paintCost(page, frame);
      handler.push(r.handler);
      frames.push(r.frames);
    }
    report("paint-200-handler-ms", { label: "200 ranges, one answer" }, handler);
    report("paint-200-frames", { label: "rAF ticks until CSS.highlights holds 200" }, frames);
    expect(await page.evaluate(() => CSS.highlights.get("rooms-tagger-amber")?.size)).toBe(RANGES);
  }
  await idle(page, hasTagger ? "tagger on, 30 turns open" : "no plugin, 30 turns open");
});

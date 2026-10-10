/*
 * Perf probe for host text surfaces. Not part of `bun run e2e`: run it with
 *   ROOMS_PERF=1 bun run e2e -- perf/surface-perf.spec.ts --project chromium
 * and ROOMS_PERF_TAGGER=1 to add the tagger fixture. It writes a 30-turn room thread straight into
 * the ask log, then measures, in ms:
 *   - selection-to-bar: triple-click release to the selection bar on screen;
 *   - paint: for one `paint` of 200 ranges, the wall-clock latency from the frame's post to the
 *     CSS.highlights.set that lands it, and the frames until the paint is on screen;
 *   - idle: CPU seconds and RSS of this worker's Chromium process tree over 10 s.
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
const FRAME_URL = /\/_plugins\/tagger\/background\.html/;

const SENTENCE = "The quick brown fox jumps over the lazy dog while the committee reviews the quarterly report. ";
const ANSWER = Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1}. ${SENTENCE.repeat(3)}`).join("\n\n");

type TaggerApi = { surfaces(): unknown[]; paintMany(n: number): void };
type PaintProbe = { setAt?: number; setSize?: number; frames?: number };

function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}
const round = (x: number) => Math.round(x * 100) / 100;
const report = (metric: string, extra: Record<string, unknown>, samples?: number[]) =>
  console.log(
    "PERF",
    JSON.stringify({
      metric,
      ...extra,
      ...(samples ? { n: samples.length, p50: round(quantile(samples, 0.5)), p95: round(quantile(samples, 0.95)), min: round(Math.min(...samples)), max: round(Math.max(...samples)) } : {}),
    }),
  );

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
    const w = window as unknown as { __barAt?: number; __upAt?: number };
    w.__barAt = undefined;
    const mo = new MutationObserver(() => {
      if (document.querySelector("[data-selection-ask]")) {
        w.__barAt = performance.now();
        mo.disconnect();
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("mouseup", () => void (w.__upAt = performance.now()), { once: true, capture: true });
  });
  await paragraph.click({ clickCount: 3 });
  const bar = withTag ? page.getByRole("toolbar", { name: "Selection actions" }) : page.getByRole("button", { name: "Ask" });
  const shown = await bar.waitFor({ timeout: 3000 }).then(() => true, () => false);
  if (!shown) {
    await page.evaluate(() => getSelection()?.removeAllRanges());
    return NaN;
  }
  if (withTag) await expect(bar.getByRole("button")).toHaveText(["Ask", "Tag"]);
  const ms = await page.evaluate(() => {
    const w = window as unknown as { __barAt: number; __upAt: number };
    return w.__barAt - w.__upAt;
  });
  await page.evaluate(() => getSelection()?.removeAllRanges());
  await expect(bar).toBeHidden();
  return ms;
}

/** One 200-range paint: wall-clock latency from the frame's post to the highlight set, and frames until on screen. */
async function paintCost(page: Page, frame: Frame): Promise<{ latency: number; frames: number }> {
  await page.evaluate((n) => {
    const w = window as unknown as { __paint?: PaintProbe; __patched?: boolean };
    w.__paint = {};
    if (!w.__patched) {
      w.__patched = true;
      const set = CSS.highlights.set.bind(CSS.highlights);
      CSS.highlights.set = (name, h) => {
        if (name === "rooms-tagger-amber" && h.size === n) Object.assign(w.__paint!, { setAt: Date.now(), setSize: h.size });
        return set(name, h);
      };
    }
    const isPaint = (e: MessageEvent) => e.data?.rooms === "surface" && e.data?.type === "paint" && Array.isArray(e.data.ranges) && e.data.ranges.length === n;
    const onMessage = (e: MessageEvent) => {
      if (!isPaint(e)) return;
      window.removeEventListener("message", onMessage, true);
      let frames = 0;
      const tick = () => {
        frames++;
        const h = CSS.highlights.get("rooms-tagger-amber");
        if (h && h.size === n) w.__paint!.frames = frames;
        else if (frames < 120) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };
    window.addEventListener("message", onMessage, true);
  }, RANGES);
  const postedAt = await frame.evaluate((n) => {
    const at = Date.now();
    (window as unknown as { tagger: TaggerApi }).tagger.paintMany(n);
    return at;
  }, RANGES);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __paint: PaintProbe }).__paint.frames)).toBeGreaterThan(0);
  const p = await page.evaluate(() => (window as unknown as { __paint: PaintProbe }).__paint);
  expect(p.setSize, "the highlight set carried every range").toBe(RANGES);
  return { latency: p.setAt! - postedAt, frames: p.frames! };
}

/** CPU seconds and RSS (MB) summed over the Chromium processes under this worker, so other runs on the machine do not count. */
function chromium(): { cpu: number; rssMb: number; pids: number } {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,cputime=,command="], { encoding: "utf8" })
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .filter((f) => f.length >= 5)
    .map(([pid, ppid, rssKb, time, ...cmd]) => ({ pid: Number(pid), ppid: Number(ppid), rssKb: Number(rssKb), time, cmd: cmd.join(" ") }));
  const mine = new Set([process.pid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of rows) {
      if (mine.has(r.ppid) && !mine.has(r.pid)) {
        mine.add(r.pid);
        grew = true;
      }
    }
  }
  let cpu = 0;
  let rss = 0;
  let pids = 0;
  for (const r of rows) {
    if (!mine.has(r.pid) || !/chrom|headless/i.test(r.cmd)) continue;
    const parts = r.time.split(":");
    const [h, m, s] = parts.length === 3 ? parts : ["0", ...parts];
    cpu += Number(h) * 3600 + Number(m) * 60 + Number(s);
    rss += r.rssKb / 1024;
    pids++;
  }
  return { cpu, rssMb: rss, pids };
}

async function idle(page: Page, label: string) {
  await page.waitForTimeout(2000);
  const a = chromium();
  await page.waitForTimeout(10_000);
  const b = chromium();
  report("idle", { label, cpuSeconds: round(b.cpu - a.cpu), rssMb: round(b.rssMb), pids: b.pids });
}

test("surface perf: selection-to-bar, 200-range paint, idle cost", async ({ page, daemon }) => {
  const room = await daemon.createRoom("perf");
  await daemon.write("perf/alpha.html", "<html><head><title>Alpha</title></head><body>a</body></html>");
  await writeThread(daemon, room.id, TURNS);
  const hasTagger = !!process.env.ROOMS_PERF_TAGGER;
  const label = hasTagger ? "tagger on" : "no plugin";
  if (hasTagger) await daemon.installPlugin("tagger");
  await page.goto("/");
  let frame: Frame | null = null;
  if (hasTagger) {
    await page.getByRole("dialog", { name: "New plugin: Tagger" }).getByRole("button", { name: "Turn on" }).click();
    await expect.poll(() => page.frame({ url: FRAME_URL }) !== null).toBe(true);
    frame = page.frame({ url: FRAME_URL })!;
    await expect.poll(() => frame!.evaluate(() => typeof (window as unknown as { tagger?: unknown }).tagger)).toBe("object");
  }
  await idle(page, `${label}, thread closed`);

  const t0 = performance.now();
  await openRoom(page, "perf");
  report("open-30-turns", { label, ms: Math.round(performance.now() - t0) });
  if (frame) {
    const t1 = performance.now();
    await expect.poll(() => frame!.evaluate(() => (window as unknown as { tagger: TaggerApi }).tagger.surfaces().length), { intervals: [10] }).toBe(TURNS);
    report("surfaces-registered-after-open", { label: "30 surface.open received by the plugin, each answered with a storage read and a paint", ms: Math.round(performance.now() - t1) });
  }

  const bar: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const ms = await selectionToBar(page, hasTagger);
    if (Number.isNaN(ms)) break;
    bar.push(ms);
  }
  if (bar.length) report("selection-to-bar", { label: hasTagger ? "Ask + Tag" : "Ask only" }, bar);
  else report("selection-to-bar", { label: hasTagger ? "Ask + Tag" : "Ask only", failed: "no bar within 3 s of the triple-click" });

  if (frame) {
    const latency: number[] = [];
    const frames: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const r = await paintCost(page, frame);
      latency.push(r.latency);
      frames.push(r.frames);
    }
    report("paint-200-latency-ms", { label: "frame's post to CSS.highlights.set, wall clock" }, latency);
    report("paint-200-frames", { label: "rAF ticks until CSS.highlights holds 200" }, frames);
    expect(await page.evaluate(() => CSS.highlights.get("rooms-tagger-amber")?.size)).toBe(RANGES);
  }
  await idle(page, `${label}, 30 turns open`);
});

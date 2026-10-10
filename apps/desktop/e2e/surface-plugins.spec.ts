/*
 * Host text surfaces: a plugin with `surfaces.text` runs a hidden background page that hears the
 * text of every chat answer on screen, adds buttons to the selection bar after Ask, and paints the
 * ranges it stores with the CSS Custom Highlight API. Core never mutates the answer's DOM, and the
 * tagger fixture is the plugin.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "@playwright/test";
import { expect, FILES_PORT, test, type Daemon } from "./fixtures";
import { installStreamingAgent } from "./streamingAgent";

/** The highlight the tagger's first style paints into: `rooms-<plugin>-<style>`. */
const AMBER = "rooms-tagger-important";

async function api(daemon: Daemon, method: string, p: string, body?: unknown) {
  const r = await fetch(`${daemon.baseUrl}${p}`, {
    method,
    headers: { authorization: `Bearer ${daemon.token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

async function turnOnTagger(page: Page) {
  const card = page.getByRole("dialog", { name: "New plugin: Tagger" });
  await expect(card).toBeVisible({ timeout: 5000 });
  await expect(card.getByRole("listitem")).toHaveText(["Can read and mark chat answers"]);
  await card.getByRole("button", { name: "Turn on" }).click();
  await expect(card).toBeHidden();
}

/** The background frame once its script is up. */
async function backgroundFrame(page: Page): Promise<Frame> {
  await expect.poll(() => page.frame({ url: /\/_plugins\/tagger\/background\.html/ }) !== null).toBe(true);
  const frame = page.frame({ url: /\/_plugins\/tagger\/background\.html/ })!;
  await expect.poll(() => frame.evaluate(() => typeof window.tagger)).toBe("object");
  return frame;
}

async function openRoom(page: Page, room: string) {
  await page.getByRole("list", { name: "Rooms" }).getByRole("button", { name: room, exact: true }).click();
  await expect(page.getByRole("tab", { name: room, exact: true, selected: true })).toBeVisible();
}

async function openDocTab(page: Page, title: string) {
  const card = page.getByTestId("artifact-card").filter({ hasText: title });
  await card.hover();
  await card.getByRole("button", { name: "Open in new tab" }).click();
  await expect(page.getByRole("tab", { name: title, selected: true })).toBeVisible();
}

async function ask(page: Page, placeholder: string, question: string) {
  const input = page.getByPlaceholder(placeholder);
  await input.fill(question);
  await input.press("Enter");
  const answer = page.locator("[data-surface] p").filter({ hasText: `answer to ${question}` });
  await expect(answer).toBeVisible({ timeout: 10_000 });
  return answer;
}

/** The text of every range painted under `name`, in document order. */
const painted = (page: Page, name = AMBER) =>
  page.evaluate((n) => {
    const h = CSS.highlights.get(n);
    return h ? Array.from(h as unknown as Iterable<Range>, (r) => r.toString().trim()) : [];
  }, name);

const bar = (page: Page) => page.getByRole("toolbar", { name: "Selection actions" });

/** Triple-click selects the paragraph, the way a user would. */
async function tag(page: Page, answer: ReturnType<Page["locator"]>) {
  await answer.click({ clickCount: 3 });
  await expect(bar(page).getByRole("button")).toHaveText(["Ask", "Tag"]);
  await bar(page).getByRole("button", { name: "Tag" }).click();
  await expect(bar(page)).toBeHidden();
}

/** Clicks the middle of the first painted range. */
async function clickPainted(page: Page) {
  const at = await page.evaluate((n) => {
    const [r] = Array.from(CSS.highlights.get(n) as unknown as Iterable<Range>);
    const rects = r.getClientRects();
    const box = rects[rects.length - 1];
    return { x: box.left + Math.min(20, box.width / 2), y: box.top + box.height / 2 };
  }, AMBER);
  await page.mouse.click(at.x, at.y);
}

async function tagFiles(daemon: Daemon): Promise<string[]> {
  const dir = path.join(daemon.home, ".rooms", "plugins", "tagger", "data");
  if (!(await fs.stat(dir).catch(() => null))) return [];
  return (await fs.readdir(dir, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).map((e) => path.relative(dir, path.join(e.parentPath, e.name))).sort();
}

test("tagging words in a room answer and a doc answer paints them in their own threads, survives a reload, and leaves the DOM alone", async ({ page, daemon }) => {
  installStreamingAgent(daemon, "Room");
  const room = await daemon.createRoom("harness");
  await daemon.write("harness/alpha.html", "<html><head><title>Alpha</title></head><body>a</body></html>");
  await daemon.installPlugin("tagger");
  await page.goto("/");
  await turnOnTagger(page);
  await backgroundFrame(page);

  await openRoom(page, "harness");
  const roomAnswer = await ask(page, "Ask about this room…", "Which doc is first?");
  const roomText = (await roomAnswer.textContent())!;
  const before = await roomAnswer.locator("xpath=ancestor::*[@data-surface]").innerHTML();
  await tag(page, roomAnswer);
  await expect.poll(() => painted(page)).toEqual([roomText]);
  expect(await roomAnswer.locator("xpath=ancestor::*[@data-surface]").innerHTML(), "paint changes no DOM").toBe(before);
  const [turn] = (await api(daemon, "GET", `/v1/asks?scope=room:${room.id}`)) as { id: string }[];
  expect(await tagFiles(daemon)).toEqual([`answer/room/${room.id}/${turn.id}.json`]);

  await openDocTab(page, "Alpha");
  await expect.poll(() => painted(page), "the room thread left the screen with its paint").toEqual([]);
  const docAnswer = await ask(page, "Ask about this artifact…", "What is this?");
  const docText = (await docAnswer.textContent())!;
  await tag(page, docAnswer);
  await expect.poll(() => painted(page)).toEqual([docText]);
  await expect(page.getByText(roomText)).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("tab", { name: "Alpha", selected: true })).toBeVisible();
  await expect(page.getByText(docText)).toBeVisible();
  await expect.poll(() => painted(page), "the plugin repaints from its storage").toEqual([docText]);
  await page.getByRole("tab", { name: "harness", exact: true }).click();
  await expect(page.getByText(roomText)).toBeVisible();
  await expect.poll(() => painted(page)).toEqual([roomText]);
});

test("a click on a painted range shows the plugin's menu; Untag removes the paint; Open flashes the range", async ({ page, daemon }) => {
  installStreamingAgent(daemon, "Room");
  await daemon.createRoom("harness");
  await daemon.write("harness/alpha.html", "<html><head><title>Alpha</title></head><body>a</body></html>");
  await daemon.installPlugin("tagger");
  await page.goto("/");
  await turnOnTagger(page);
  await backgroundFrame(page);
  await openRoom(page, "harness");
  const answer = await ask(page, "Ask about this room…", "Which doc is first?");
  const text = (await answer.textContent())!;
  await tag(page, answer);
  await expect.poll(() => painted(page)).toEqual([text]);

  await clickPainted(page);
  await expect(bar(page).getByRole("button")).toHaveText(["Untag", "Open"]);
  await page.keyboard.press("Escape");
  await expect(bar(page)).toBeHidden();

  await clickPainted(page);
  await bar(page).getByRole("button", { name: "Open" }).click();
  await expect.poll(() => painted(page, "rooms-flash"), { timeout: 1000, intervals: [25] }).toEqual([text]);
  await expect.poll(() => painted(page, "rooms-flash"), { timeout: 3000 }).toEqual([]);

  await clickPainted(page);
  await bar(page).getByRole("button", { name: "Untag" }).click();
  await expect.poll(() => painted(page)).toEqual([]);
  await expect(bar(page)).toBeHidden();
  const [file] = await tagFiles(daemon);
  expect(JSON.parse(await daemon.read(path.join(".rooms", "plugins", "tagger", "data", file)))).toEqual({ version: 1, tags: [] });
});

test("open({ surface, rangeId }) from the background is refused unless the user just clicked the plugin; then it opens the thread's tab, unfolds it, and flashes the range", async ({ page, daemon }) => {
  installStreamingAgent(daemon, "Room");
  await daemon.createRoom("harness");
  await daemon.write("harness/alpha.html", "<html><head><title>Alpha</title></head><body>a</body></html>");
  await daemon.installPlugin("tagger");
  await page.goto("/");
  await turnOnTagger(page);
  const frame = await backgroundFrame(page);
  await openRoom(page, "harness");
  const answer = await ask(page, "Ask about this room…", "Which doc is first?");
  const text = (await answer.textContent())!;
  await tag(page, answer);
  await expect.poll(() => painted(page)).toEqual([text]);
  const [surface] = await frame.evaluate(() => window.tagger.surfaces());
  const [file] = await tagFiles(daemon);
  const { tags } = JSON.parse(await daemon.read(path.join(".rooms", "plugins", "tagger", "data", file))) as { tags: { id: string }[] };
  const open = () =>
    frame.evaluate(
      ({ surface, rangeId }) => window.tagger.open(surface, rangeId).then(() => "ok", (e: { code?: string }) => e.code ?? "error"),
      { surface, rangeId: tags[0].id },
    );

  await openDocTab(page, "Alpha");
  await expect.poll(() => painted(page)).toEqual([]);
  await page.waitForTimeout(2100);
  expect(await open(), "no click on the plugin in the last 2 s").toBe("permission_denied");
  await expect(page.getByRole("tab", { name: "Alpha", selected: true })).toBeVisible();

  await page.getByRole("tab", { name: "harness", exact: true }).click();
  await expect.poll(() => painted(page)).toEqual([text]);
  await clickPainted(page);
  await expect(bar(page).getByRole("button")).toHaveText(["Untag", "Open"]);
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: "Alpha", exact: true }).click();
  await expect.poll(() => painted(page)).toEqual([]);
  expect(await open(), "right after the click on its range").toBe("ok");
  await expect(page.getByRole("tab", { name: "harness", exact: true, selected: true })).toBeVisible();
  await expect.poll(() => painted(page, "rooms-flash"), { timeout: 5000, intervals: [25] }).toEqual([text]);
  await expect.poll(() => painted(page)).toEqual([text]);
});

test("the background frame is sandboxed without network; hostile paint is dropped; turning the plugin off removes paint, button and frame", async ({ page, daemon }) => {
  installStreamingAgent(daemon, "Room");
  await daemon.createRoom("harness");
  await daemon.write("harness/alpha.html", "<html><head><title>Alpha</title></head><body>a</body></html>");
  await daemon.installPlugin("tagger");
  await page.goto("/");
  await turnOnTagger(page);
  const frame = await backgroundFrame(page);
  const el = page.locator('iframe[title="Tagger"]');
  await expect(el).toHaveAttribute("sandbox", "allow-scripts");
  await expect(el.locator("xpath=ancestor::*[@data-background-frames]")).toHaveAttribute("hidden", "");
  expect(await frame.evaluate((url) => window.tagger.fetchBlocked(url), `${daemon.baseUrl}/v1/info`)).toBe(true);
  const csp = (await fetch(`http://127.0.0.1:${FILES_PORT}/_plugins/tagger/background.html`)).headers.get("content-security-policy") ?? "";
  expect(csp).toContain("connect-src 'none'");
  expect(csp).toContain("sandbox allow-scripts");

  await openRoom(page, "harness");
  const answer = await ask(page, "Ask about this room…", "Which doc is first?");
  const text = (await answer.textContent())!;
  await tag(page, answer);
  await expect.poll(() => painted(page)).toEqual([text]);

  await frame.evaluate(() => window.tagger.hostile());
  await expect.poll(() => painted(page, "rooms-tagger-agree"), "the one good range of a hostile paint is kept").toEqual([text.slice(0, 4)]);
  expect(await painted(page, "rooms-tagger-disagree"), "a range past the text is dropped").toEqual([]);
  expect(await painted(page), "a paint replaces the plugin's ranges on that surface").toEqual([]);
  expect(await page.evaluate(() => [...CSS.highlights.keys()].filter((k) => k.startsWith("rooms-tagger-")).sort()), "no highlight for a refused style").toEqual([
    "rooms-tagger-agree",
    "rooms-tagger-disagree",
    "rooms-tagger-idk",
    "rooms-tagger-important",
  ]);
  const styles = await page.evaluate(() => document.querySelector("style[data-surface-highlights]")!.textContent);
  expect(styles).not.toContain("display:none");
  expect(styles).not.toContain("url(");
  expect(styles).toContain("::highlight(rooms-tagger-important) { background-color: rgba(199,154,62,0.28); }");
  await expect(page.locator("body")).toBeVisible();

  await api(daemon, "PATCH", "/v1/plugins/tagger", { enabled: false });
  await expect(el).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => CSS.highlights.has("rooms-tagger-agree"))).toBe(false);
  await answer.click({ clickCount: 3 });
  await expect(page.getByRole("button", { name: "Ask" })).toBeVisible();
  await expect(bar(page), "Ask alone, as with no surface plugin").toHaveCount(0);
  await page.keyboard.press("Escape");
});

/*
 * Plan 3 onboarding: the first-run card on a fresh home, and moving an inbox
 * doc onto a room by dragging its "방을 기다리는 문서" row onto the sidebar.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { APP_ORIGIN, artifactHtml, expect, test, today } from "./fixtures";

const SCREENS = path.join(import.meta.dirname, "__screens__");
const HEADING = "Rooms에 오신 걸 환영해요";
const MARKER = "<!-- rooms-onboarding v3 -->";

const waitingList = (page: Page) => page.getByRole("region", { name: "방을 기다리는 문서" });

test("a fresh home shows the welcome page, and roomsd wrote ONBOARD.md with the marker", async ({ page, daemon }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: HEADING, exact: true })).toBeVisible();
  const onboard = await daemon.read("ONBOARD.md");
  expect(onboard.split("\n")[0]).toBe(MARKER);

  // The chip shows the one-liner pointing at this home's ONBOARD.md; 복사 copies it.
  const line = `${daemon.home}/ONBOARD.md 를 읽고 따라 해줘`;
  await expect(page.getByTestId("welcome-prompt")).toHaveText(line);
  const copy = page.getByTestId("welcome-copy");
  await expect(copy).toHaveText("복사");
  const cards = page.getByTestId("example-card");
  await expect(cards).toHaveCount(3);

  // Wide: the example cards sit in a tilted pile, and nothing overflows the page.
  // (The pointer rests in the empty margin right of the column, off every card.)
  await page.mouse.move(1420, 600);
  await page.waitForTimeout(300);
  for (const [i, deg] of [-2, 1.5, -1].entries()) {
    expect(await cards.nth(i).evaluate((el) => getComputedStyle(el).rotate)).toBe(`${deg}deg`);
  }
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: path.join(SCREENS, "onboarding.png") });

  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: APP_ORIGIN });
  await copy.click();
  await expect(copy).toHaveText("복사했어요");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(line);
  await expect(copy).toHaveText("복사");

  // An example card copies its own text.
  const example = "오늘 대화를 복습용 HTML로 만들어서 오늘 Journal에 넣어줘";
  await page.getByRole("button", { name: `예시 복사: ${example}`, exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(example);

  // Narrow: the pile falls back to a straight stacked column inside the panel.
  await page.setViewportSize({ width: 900, height: 900 });
  await page.mouse.move(890, 600);
  await page.waitForTimeout(300);
  for (let i = 0; i < 3; i++) expect(await cards.nth(i).evaluate((el) => getComputedStyle(el).rotate)).toBe("none");
  const boxes = await Promise.all([0, 1, 2].map((i) => cards.nth(i).boundingBox()));
  expect(boxes[0]!.x).toBe(boxes[1]!.x);
  expect(boxes[1]!.y).toBeGreaterThan(boxes[0]!.y + boxes[0]!.height - 1);
  expect(boxes[2]!.y).toBeGreaterThan(boxes[1]!.y + boxes[1]!.height - 1);
  await expectNoHorizontalOverflow(page);
  await cards.nth(2).scrollIntoViewIfNeeded(); // show the stacked cards and the tips box
  await page.getByRole("complementary", { name: "팁" }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(SCREENS, "onboarding-narrow.png") });
});

/** The welcome page and every example card stay inside the scrolling panel horizontally. */
async function expectNoHorizontalOverflow(page: Page) {
  const welcome = page.getByTestId("welcome");
  const panel = await welcome.evaluate((el) => {
    const p = el.parentElement!;
    return { overflow: p.scrollWidth - p.clientWidth, right: p.getBoundingClientRect().right };
  });
  expect(panel.overflow).toBe(0);
  for (const card of await page.getByTestId("example-card").all()) {
    const box = (await card.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(panel.right);
  }
}

test("dragging an inbox row onto room a moves the link, keeps the original and its Journal day", async ({ page, daemon }) => {
  // The original lives outside the home; the inbox only holds a symlink to it.
  const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rooms-e2e-orig-")));
  try {
    const original = path.join(outside, "x.html");
    await fs.writeFile(original, artifactHtml("기다리는 문서"));
    const before = { bytes: await fs.readFile(original), ino: (await fs.stat(original)).ino };
    await fs.mkdir(path.join(daemon.home, "inbox"), { recursive: true });
    await fs.symlink(original, path.join(daemon.home, "inbox", "x.html"));
    await daemon.createRoom("a");

    // Wait for the watcher to index the inbox link, then note its Journal entry.
    const waiting = () => journalDay(daemon.baseUrl, today()).then((d) => d.artifacts.find((a) => a.title === "기다리는 문서"));
    await expect.poll(async () => (await waiting())?.roomId).toBe("inbox");
    const inJournalBefore = (await waiting())!;

    await page.goto("/");
    const row = waitingList(page).getByTestId("inbox-row").filter({ hasText: "기다리는 문서" });
    await expect(row).toBeVisible();
    const target = page.getByRole("list", { name: "방" }).getByRole("button", { name: "a", exact: true });
    await expect(target).toBeVisible();

    await row.dragTo(target);

    await expect(waitingList(page)).toHaveCount(0); // the only waiting doc left, so the list goes away
    const moved = path.join(daemon.home, "a", "x.html");
    await expect.poll(() => fs.lstat(moved).then((s) => s.isSymbolicLink(), () => false)).toBe(true);
    expect(await fs.realpath(moved)).toBe(original);
    expect(await daemon.exists("inbox/x.html")).toBe(false);

    // The original is untouched: same bytes, same inode.
    expect((await fs.readFile(original)).equals(before.bytes)).toBe(true);
    expect((await fs.stat(original)).ino).toBe(before.ino);

    // Same Journal day, same first-seen time, now labelled with room a.
    const roomA = (await daemon.listRooms()).find((r) => r.name === "a")!;
    await expect.poll(async () => (await waiting())?.roomId).toBe(roomA.id);
    expect((await waiting())?.createdAt).toBe(inJournalBefore.createdAt);
  } finally {
    await fs.rm(outside, { recursive: true, force: true });
  }
});

type JournalArtifact = { id: string; roomId: string; title: string; createdAt: string };

async function journalDay(base: string, date: string): Promise<{ artifacts: JournalArtifact[] }> {
  const r = await fetch(`${base}/v1/journal/${date}`);
  if (!r.ok) throw new Error(`journal ${date}: ${r.status}`);
  return (await r.json()) as { artifacts: JournalArtifact[] };
}

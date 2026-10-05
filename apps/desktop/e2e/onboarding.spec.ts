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
const HEADING = "이 한 줄을 에이전트에게 붙여넣으세요";
const MARKER = "<!-- rooms-onboarding v2 -->";

const waitingList = (page: Page) => page.getByRole("region", { name: "방을 기다리는 문서" });

test("a fresh home shows the full first-run card, and roomsd wrote ONBOARD.md with the marker", async ({ page, daemon }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: HEADING, exact: true })).toBeVisible();
  const onboard = await daemon.read("ONBOARD.md");
  expect(onboard.split("\n")[0]).toBe(MARKER);

  // The chip shows and copies the one-liner pointing at this home's ONBOARD.md.
  const line = `${daemon.home}/ONBOARD.md 를 읽고 따라 해줘`;
  const chip = page.getByRole("button", { name: line, exact: true });
  await expect(chip).toBeVisible();

  await page.mouse.move(720, 880);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SCREENS, "onboarding.png") });

  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: APP_ORIGIN });
  await chip.click();
  await expect(page.getByText("복사했어요")).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(line);
});

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

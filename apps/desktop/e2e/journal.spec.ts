import type { Page } from "@playwright/test";
import { artifactHtml, expect, test, today } from "./fixtures";

/** An artifact stamped as written `minutesAgo` (but still today), so order doesn't hang on file times. */
const stamped = (title: string, minutesAgo: number) =>
  artifactHtml(title).replace("<head>", `<head><meta name="rooms:created" content="${new Date(Math.max(Date.now() - minutesAgo * 60_000, new Date().setHours(0, 0, minutesAgo))).toISOString()}">`);

async function openJournal(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Journal", exact: true }).click();
  await expect(page.getByRole("tab", { name: /^Journal · /, selected: true })).toBeVisible();
}

test("AC-10: the Journal lists the day in time order, the Dream as Review and room artifacts with their room", async ({ page, daemon }) => {
  const date = today();
  await daemon.createRoom("벤치마크");
  await daemon.write("벤치마크/report.html", stamped("주간 리포트", 2));
  await daemon.write(`journal/${date}/dream.html`, stamped("어젯밤 복습", 1));

  await openJournal(page);
  const rows = page.getByRole("list", { name: "Your day" }).getByTestId("day-artifact");
  await expect(rows).toHaveCount(2, { timeout: 2000 });
  await expect(rows.nth(0)).toContainText("주간 리포트");
  await expect(rows.nth(0)).toContainText("벤치마크");
  await expect(rows.nth(1)).toContainText("어젯밤 복습");
  await expect(rows.nth(1)).toContainText("Review");
});

test("the Today tally lists every room's artifacts newest first on hover, and one opens on click", async ({ page, daemon }) => {
  await daemon.createRoom("벤치마크");
  await daemon.createRoom("리서치");
  // A minute apart, written out of order, so newest-first is not just write order.
  await daemon.write("리서치/second.html", stamped("둘째 메모", 2));
  await daemon.write("inbox/third.html", stamped("셋째 초안", 1));
  await daemon.write("벤치마크/first.html", stamped("첫 보고서", 3));

  await openJournal(page);
  const cell = page.getByRole("region", { name: "Today" }).getByRole("button", { name: "3 artifacts" });
  await expect(cell).toBeVisible({ timeout: 2000 });
  await cell.hover();
  const list = page.getByRole("dialog", { name: "3 artifacts" });
  await expect(list.getByRole("button")).toHaveText([/셋째 초안/, /둘째 메모/, /첫 보고서/]);
  await list.getByRole("button", { name: /둘째 메모/ }).click();
  await expect(page.getByRole("tab", { name: "둘째 메모", selected: true })).toBeVisible();
});

test("the tally's list opens above its cell when there is no room below, and scrolls when long", async ({ page, daemon }) => {
  await daemon.createRoom("벤치마크");
  for (let i = 0; i < 12; i++) await daemon.write(`벤치마크/r${i}.html`, artifactHtml(`보고서 ${i}`));
  await page.setViewportSize({ width: 1440, height: 440 });
  await openJournal(page);
  const cell = page.getByRole("region", { name: "Today" }).getByRole("button", { name: "12 artifacts" });
  await cell.scrollIntoViewIfNeeded();
  await cell.hover();
  const list = page.getByRole("dialog", { name: "12 artifacts" });
  await expect(list).toBeVisible();
  const [c, l] = [await cell.boundingBox(), await list.boundingBox()];
  expect(l!.y + l!.height).toBeLessThanOrEqual(c!.y + 1);
  const rows = list.getByRole("list");
  expect(await rows.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
});

test("AC-11: Write a note opens New Note with the cursor in the body; typing autosaves to journal/<today>/New Note.md", async ({ page, daemon }) => {
  const date = today();
  await openJournal(page);
  await page.getByRole("button", { name: "Write a note" }).click();
  await expect(page.getByRole("tab", { name: "New Note", selected: true })).toBeVisible();

  const body = page.getByRole("textbox", { name: "Note" });
  await expect(body).toBeFocused();
  await page.keyboard.type("- 할 일");
  await page.waitForTimeout(1500);
  expect(await daemon.read(`journal/${date}/New Note.md`)).toContain("- 할 일");
});

test("renaming a note from its heading moves the file and keeps the body typed just before", async ({ page, daemon }) => {
  const date = today();
  await openJournal(page);
  await page.getByRole("button", { name: "Write a note" }).click();
  const body = page.getByRole("textbox", { name: "Note" });
  await expect(body).toBeFocused();
  await page.keyboard.type("방금 쓴 글");
  // Rename at once, before the autosave debounce fires.
  await page.getByRole("heading", { level: 1, name: "New Note" }).click();
  const title = page.getByRole("textbox", { name: "Note name" });
  await title.fill("회고");
  await title.press("Enter");
  await expect(page.getByRole("tab", { name: "회고", selected: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "회고" })).toBeVisible();
  await expect.poll(() => daemon.read(`journal/${date}/회고.md`).catch(() => null)).toBe("방금 쓴 글");
  await expect(daemon.read(`journal/${date}/New Note.md`)).rejects.toThrow();

  // A second new note is New Note again (the first was renamed); renaming it to 회고 is refused.
  await page.getByRole("tab", { name: /^Journal · / }).click();
  await expect(page.getByRole("list", { name: "Your day" }).getByRole("button", { name: "회고" })).toBeVisible();
  await page.getByRole("button", { name: "Write a note" }).click();
  await expect(page.getByRole("tab", { name: "New Note", selected: true })).toBeVisible();
  await page.getByRole("heading", { level: 1, name: "New Note" }).click();
  await page.getByRole("textbox", { name: "Note name" }).fill("회고");
  await page.getByRole("textbox", { name: "Note name" }).press("Enter");
  await expect(page.getByText("A note with that name already exists")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Note name" })).toHaveValue("회고");
});

test("in a narrow window the tally sits above the day in one column, and nothing overlaps it", async ({ page, daemon }) => {
  await daemon.createRoom("벤치마크");
  await daemon.write("벤치마크/report.html", stamped("주간 리포트", 2));
  for (const [width, stacked] of [[900, true], [1440, false]] as const) {
    await page.setViewportSize({ width, height: 800 });
    await openJournal(page);
    const tally = await page.getByRole("region", { name: "Today" }).boundingBox();
    const day = await page.getByRole("region", { name: "Your day" }).boundingBox();
    const thumb = await page.getByTestId("day-artifact").first().boundingBox();
    if (!tally || !day || !thumb) throw new Error("the Journal did not lay out");
    const apart = (a: typeof tally, b: typeof tally) => a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
    expect(apart(tally, day), `${width}px: the tally and the day overlap`).toBe(true);
    expect(apart(tally, thumb), `${width}px: an artifact overlaps the tally`).toBe(true);
    expect(tally.y + tally.height <= day.y, `${width}px: tally above the day`).toBe(stacked);
  }
});

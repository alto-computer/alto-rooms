import type { Page } from "@playwright/test";
import { artifactHtml, expect, test, today } from "./fixtures";

async function openJournal(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Journal", exact: true }).click();
  await expect(page.getByRole("tab", { name: /^Journal · /, selected: true })).toBeVisible();
}

test("AC-10: the Journal lists the day in time order, the Dream as Review and room artifacts with their room", async ({ page, daemon }) => {
  const date = today();
  await daemon.createRoom("벤치마크");
  await daemon.write("벤치마크/report.html", artifactHtml("주간 리포트"));
  await daemon.write(`journal/${date}/dream.html`, artifactHtml("어젯밤 복습"));

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
  // Stamped a minute apart (but still today), so newest-first is not just write order.
  const stamped = (title: string, minutesAgo: number) =>
    artifactHtml(title).replace("<head>", `<head><meta name="rooms:created" content="${new Date(Math.max(Date.now() - minutesAgo * 60_000, new Date().setHours(0, 0, 1))).toISOString()}">`);
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

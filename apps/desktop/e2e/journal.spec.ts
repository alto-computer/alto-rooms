import type { Page } from "@playwright/test";
import { artifactHtml, expect, test, today } from "./fixtures";

async function openJournal(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Journal" }).click();
  await expect(page.getByRole("tab", { name: /^Journal · /, selected: true })).toBeVisible();
}

test("AC-10: the Journal shows the Dream first as 복습, then room artifacts labelled with their room", async ({ page, daemon }) => {
  const date = today();
  await daemon.createRoom("벤치마크");
  await daemon.write("벤치마크/report.html", artifactHtml("주간 리포트"));
  // Written after the room artifact, so dream-first is not just createdAt order.
  await daemon.write(`journal/${date}/dream.html`, artifactHtml("어젯밤 복습"));

  await openJournal(page);
  const agents = page.getByRole("region", { name: "에이전트가 쓴 것" });
  const cards = agents.getByTestId("artifact-card");
  await expect(cards).toHaveCount(2, { timeout: 2000 });
  await expect(cards.nth(0)).toContainText("어젯밤 복습");
  await expect(cards.nth(0)).toContainText("복습");
  await expect(cards.nth(1)).toContainText("주간 리포트");
  await expect(cards.nth(1)).toContainText("벤치마크");
});

test("AC-11: 새 노트 opens New Note with the cursor in the body; typing autosaves to journal/<today>/New Note.md", async ({ page, daemon }) => {
  const date = today();
  await openJournal(page);
  await page.getByRole("button", { name: "새 노트" }).click();
  await expect(page.getByRole("tab", { name: "New Note", selected: true })).toBeVisible();

  const body = page.getByRole("textbox", { name: "노트" });
  await expect(body).toBeFocused();
  await page.keyboard.type("- 할 일");
  await page.waitForTimeout(1500);
  expect(await daemon.read(`journal/${date}/New Note.md`)).toContain("- 할 일");
});

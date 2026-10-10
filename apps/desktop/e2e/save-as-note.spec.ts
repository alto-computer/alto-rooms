import type { Page } from "@playwright/test";
import { artifactHtml, expect, test, today } from "./fixtures";
import { installStreamingAgent } from "./streamingAgent";

async function ask(page: Page, placeholder: string, question: string, answer: string) {
  const input = page.getByPlaceholder(placeholder);
  await input.fill(question);
  await input.press("Enter");
  await expect(page.getByText(answer)).toBeVisible({ timeout: 10_000 });
}

async function saveAsNote(page: Page) {
  await page.getByRole("button", { name: "Save as note" }).click();
  await page.getByRole("textbox", { name: "Note name" }).press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Saved to Journal" })).toBeVisible();
}

test("save a room answer into today's Journal twice, then open the note", async ({ page, daemon }) => {
  installStreamingAgent(daemon, "Room");
  const date = today();
  await daemon.createRoom("harness");
  await daemon.write("harness/alpha.html", artifactHtml("Alpha"));

  await page.goto("/");
  await page.getByRole("list", { name: "Rooms" }).getByRole("button", { name: "harness", exact: true }).click();
  const answer = "Room answer to What is in here? (1 docs)";
  await ask(page, "Ask about this room…", "What is in here?", answer);

  await page.getByRole("button", { name: "Save as note" }).click();
  await expect(page.getByRole("textbox", { name: "Note name" })).toHaveValue("What is in here?");
  await page.getByRole("textbox", { name: "Note name" }).press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Saved to Journal" })).toBeVisible();
  const body = `Room: harness\n\n## What is in here?\n\n${answer}`;
  await expect.poll(() => daemon.read(`journal/${date}/What is in here?.md`)).toBe(body);

  await page.getByRole("button", { name: "Open note" }).click();
  await expect(page.getByRole("tab", { name: "What is in here?", selected: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Note", exact: true })).toHaveValue(body);

  await page.getByRole("tab", { name: "harness", exact: true }).click();
  await page.getByPlaceholder("Ask about this room…").focus();
  await page.getByRole("button", { name: "Save as note" }).click();
  await page.getByRole("textbox", { name: "Note name" }).press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Saved to Journal" })).toBeVisible();
  await expect.poll(() => daemon.read(`journal/${date}/What is in here? (2).md`)).toBe(body);
  expect(await daemon.read(`journal/${date}/What is in here?.md`)).toBe(body);

  await page.getByRole("button", { name: "Journal", exact: true }).click();
  const mine = page.getByRole("region", { name: "From me" });
  await expect(mine.getByRole("button", { name: "What is in here?", exact: true })).toBeVisible();
  await expect(mine.getByRole("button", { name: "What is in here? (2)", exact: true })).toBeVisible();
});

test("save a day answer into the viewed day, not today", async ({ page, daemon }) => {
  installStreamingAgent(daemon, "Day");
  const other = new Date();
  other.setDate(other.getDate() + (other.getDay() === 0 ? 1 : -1));
  const date = today(other);
  await daemon.write(`journal/${date}/dream.html`, artifactHtml("That night's review"));

  await page.goto("/");
  await page.getByRole("button", { name: "Journal", exact: true }).click();
  const strip = `${other.toLocaleString("en-US", { month: "short" })} ${other.getDate()}`;
  await page.getByRole("button", { name: strip, exact: true }).click();
  await expect(page.getByRole("region", { name: "From agents" }).getByTestId("artifact-card")).toHaveCount(1);
  const answer = "Day answer to What happened? (1 docs)";
  await ask(page, "Ask about this day…", "What happened?", answer);
  await saveAsNote(page);

  await expect.poll(() => daemon.read(`journal/${date}/What happened?.md`)).toBe(`## What happened?\n\n${answer}`);
  expect(await daemon.exists(`journal/${today()}/What happened?.md`)).toBe(false);
  await expect(page.getByRole("region", { name: "From me" }).getByRole("button", { name: "What happened?", exact: true })).toBeVisible();
});

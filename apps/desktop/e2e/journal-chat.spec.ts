import type { Page } from "@playwright/test";
import { artifactHtml, expect, MOD, test, today } from "./fixtures";
import { installStreamingAgent } from "./streamingAgent";

const DAY_PLACEHOLDER = "Ask about this day…";

/** The week strip's name for a day, as in "Oct 9". */
const stripLabel = (d: Date) => `${d.toLocaleString("en-US", { month: "short" })} ${d.getDate()}`;

/** Another day in the week strip that shows today: yesterday, or tomorrow when today starts the week. */
function otherDay(): Date {
  const d = new Date();
  d.setDate(d.getDate() + (d.getDay() === 0 ? 1 : -1));
  return d;
}

async function showDay(page: Page, d: Date) {
  const day = page.getByRole("button", { name: stripLabel(d), exact: true });
  await day.click();
  await expect(day).toHaveAttribute("aria-pressed", "true");
}

test("ask about the viewed day, and keep each day's thread and draft across day switches and a reload", async ({ page, daemon }) => {
  installStreamingAgent(daemon, "Day");
  const date = today();
  await daemon.createRoom("work");
  await daemon.write("work/report.html", artifactHtml("Weekly report"));
  await daemon.write(`journal/${date}/dream.html`, artifactHtml("Last night's review"));
  await daemon.saveNote(date, "plan.md", "- ship it");

  await page.goto("/");
  await page.getByRole("button", { name: "Journal", exact: true }).click();
  await expect(page.getByRole("tab", { name: /^Journal · /, selected: true })).toBeVisible();
  await expect(page.getByRole("list", { name: "Your day" }).getByTestId("day-artifact")).toHaveCount(2);
  const input = page.getByPlaceholder(DAY_PLACEHOLDER);
  await expect(input).toBeVisible();

  await page.keyboard.press(`${MOD}+j`);
  await expect(input).toHaveCount(0);
  await page.keyboard.press(`${MOD}+j`);
  await expect(input).toBeFocused();

  await input.fill("What did I do today?");
  await input.press("Enter");
  await expect(page.getByText(/^Read · (dream|report)\.html$|^Read · plan\.md$/)).toBeVisible({ timeout: 10_000 });

  const question = page.getByText("What did I do today?", { exact: true });
  const answer = page.getByText("Day answer to What did I do today? (3 docs)");
  const other = otherDay();
  await showDay(page, other);
  // The bar moves to the other day once that day has loaded.
  await expect(question).toHaveCount(0);
  await expect(input).toHaveValue("");
  await expect(page.getByText(/^Read · /)).toHaveCount(0);
  await input.fill("A draft for the other day");

  await showDay(page, new Date());
  await expect(answer).toBeVisible({ timeout: 10_000 });
  await expect(input).toHaveValue("");

  await showDay(page, other);
  await expect(question).toHaveCount(0);
  await expect(input).toHaveValue("A draft for the other day");
  await expect(answer).toHaveCount(0);

  await showDay(page, new Date());
  await page.reload();
  await expect(page.getByRole("tab", { name: /^Journal · /, selected: true })).toBeVisible();
  await expect(answer).toBeVisible();
});

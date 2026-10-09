import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const isDark = (page: Page) => page.evaluate(() => document.documentElement.classList.contains("dark"));
const desk = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

async function pick(page: Page, appearance: "System" | "Light" | "Dark") {
  await page.getByRole("button", { name: "Rooms", exact: true }).click();
  await page.getByRole("menuitemradio", { name: appearance }).click();
  await page.keyboard.press("Escape");
}

test("System follows the OS scheme live, and paints the dark desk", async ({ page, daemon }) => {
  await daemon.createRoom("Alpha");
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await expect(page.getByRole("list", { name: "Rooms" }).getByRole("button", { name: "Alpha" })).toBeVisible();
  await expect.poll(() => isDark(page)).toBe(false);
  expect(await desk(page)).toBe("rgb(235, 228, 218)");

  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(() => isDark(page)).toBe(true);
  expect(await desk(page)).toBe("rgb(22, 19, 17)");

  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(() => isDark(page)).toBe(false);
});

test("Light and Dark hold against the OS and survive a reload; System lets go again", async ({ page, daemon }) => {
  await daemon.createRoom("Alpha");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expect.poll(() => isDark(page)).toBe(true);

  await pick(page, "Light");
  await expect.poll(() => isDark(page)).toBe(false);
  await page.reload();
  await expect(page.getByRole("list", { name: "Rooms" }).getByRole("button", { name: "Alpha" })).toBeVisible();
  await expect.poll(() => isDark(page)).toBe(false);

  await page.emulateMedia({ colorScheme: "light" });
  await pick(page, "Dark");
  await expect.poll(() => isDark(page)).toBe(true);
  await page.reload();
  await expect(page.getByRole("list", { name: "Rooms" }).getByRole("button", { name: "Alpha" })).toBeVisible();
  await expect.poll(() => isDark(page)).toBe(true);

  await pick(page, "System");
  await expect.poll(() => isDark(page)).toBe(false);
});

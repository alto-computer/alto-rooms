import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const isDark = (page: Page) => page.evaluate(() => document.documentElement.classList.contains("dark"));
const desk = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

async function pick(page: Page, appearance: "System" | "Light" | "Dark") {
  await page.getByRole("button", { name: /^Settings/ }).click();
  await page.getByRole("radiogroup", { name: "Appearance" }).getByRole("radio", { name: appearance }).click();
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

test("Dark dims a light artifact page but leaves a dark one alone; Light dims neither", async ({ page, daemon }) => {
  await daemon.createRoom("Pages");
  await daemon.write("Pages/light.html", "<!doctype html><html><head><title>Light page</title></head><body><h1>Light</h1></body></html>");
  await daemon.write("Pages/dark.html", '<!doctype html><html><head><title>Dark page</title><style>body{background:#0f172a;color:#e2e8f0}</style></head><body><h1>Dark</h1></body></html>');
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  const filterOf = async (title: string) => {
    await page.getByRole("list", { name: "Rooms" }).getByRole("button", { name: "Pages" }).click();
    await page.getByTestId("artifact-card").filter({ hasText: title }).click();
    const frame = page.locator(`iframe[title="${title}"]`);
    await expect(frame).toHaveCSS("opacity", "1");
    return frame;
  };

  await pick(page, "Dark");
  await expect(await filterOf("Light page")).toHaveCSS("filter", /brightness\(0\.86\)/);
  await expect(await filterOf("Dark page")).toHaveCSS("filter", "none");
  await pick(page, "Light");
  await expect(await filterOf("Light page")).toHaveCSS("filter", "none");
});

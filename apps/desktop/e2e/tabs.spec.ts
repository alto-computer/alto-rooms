import type { Page } from "@playwright/test";
import { expect, MOD, test, type Daemon } from "./fixtures";

const tabs = (page: Page) => page.getByRole("tablist", { name: "Tabs" }).getByRole("tab");
const tabNames = (page: Page) => tabs(page).allTextContents();
const tab = (page: Page, name: string) => page.getByRole("tablist", { name: "Tabs" }).getByRole("tab", { name, exact: true });
/** Home's tab label: today's Journal. */
const HOME = `Journal · ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;

/** Rooms Alpha, Beta, Gamma, each open in its own tab (Alpha replaces home in the first tab). */
async function openRoomTabs(page: Page, daemon: Daemon) {
  for (const n of ["Alpha", "Beta", "Gamma"]) await daemon.createRoom(n);
  await page.goto("/");
  const rooms = page.getByRole("list", { name: "Rooms" });
  await rooms.getByRole("button", { name: "Alpha" }).click();
  await rooms.getByRole("button", { name: "Beta" }).click({ modifiers: [MOD] });
  await rooms.getByRole("button", { name: "Gamma" }).click({ modifiers: [MOD] });
  await expect.poll(() => tabNames(page)).toEqual(["Alpha", "Beta", "Gamma"]);
}

/** A real pointer drag of tab `from` to the left or right part of tab `to`, in small steps. */
async function dragTab(page: Page, from: string, to: string, side: "left" | "right") {
  const a = (await tab(page, from).boundingBox())!;
  const b = (await tab(page, to).boundingBox())!;
  const y = a.y + a.height / 2;
  await page.mouse.move(a.x + a.width / 2, y);
  await page.mouse.down();
  const x = side === "left" ? b.x + b.width * 0.15 : b.x + b.width * 0.85;
  await page.mouse.move(x, y, { steps: 16 });
  await page.mouse.up();
}

test("dragging a tab reorders the tab bar and activates the dragged tab", async ({ page, daemon }) => {
  await openRoomTabs(page, daemon);
  await tab(page, "Alpha").click();
  await expect(tab(page, "Alpha")).toHaveAttribute("aria-selected", "true");

  await dragTab(page, "Gamma", "Alpha", "left");
  await expect.poll(() => tabNames(page)).toEqual(["Gamma", "Alpha", "Beta"]);
  // Browser style: the tab you pick up becomes the active one.
  await expect(tab(page, "Gamma")).toHaveAttribute("aria-selected", "true");

  await dragTab(page, "Gamma", "Beta", "right");
  await expect.poll(() => tabNames(page)).toEqual(["Alpha", "Beta", "Gamma"]);

  // A plain click still just switches tabs (the drag needs a few pixels of movement).
  await tab(page, "Beta").click();
  await expect(tab(page, "Beta")).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => tabNames(page)).toEqual(["Alpha", "Beta", "Gamma"]);
});

test("⌘⇧T reopens the last closed tab where it was", async ({ page, daemon }) => {
  await openRoomTabs(page, daemon);
  await tab(page, "Beta").click();
  await page.getByRole("tablist", { name: "Tabs" }).locator("[role=presentation]", { has: page.getByRole("tab", { name: "Beta", exact: true }) }).getByRole("button", { name: "Close tab" }).click();
  await expect.poll(() => tabNames(page)).toEqual(["Alpha", "Gamma"]);

  await page.keyboard.press(`${MOD}+Shift+t`);
  await expect.poll(() => tabNames(page)).toEqual(["Alpha", "Beta", "Gamma"]);
  await expect(tab(page, "Beta")).toHaveAttribute("aria-selected", "true");
});

test("closing the last tab goes home; ⌘T and + find home already open", async ({ page, daemon }) => {
  await daemon.createRoom("Alpha");
  await page.goto("/");
  await page.getByRole("list", { name: "Rooms" }).getByRole("button", { name: "Alpha" }).click();
  await expect(tabs(page)).toHaveCount(1);
  await page.getByRole("tablist", { name: "Tabs" }).getByRole("button", { name: "Close tab" }).click();
  await expect(tabs(page)).toHaveCount(1);
  await expect(tab(page, HOME)).toHaveAttribute("aria-selected", "true");
  await page.getByRole("list", { name: "Rooms" }).getByRole("button", { name: "Alpha" }).click({ modifiers: [MOD] });
  await expect.poll(() => tabNames(page)).toEqual([HOME, "Alpha"]);
  await tab(page, "Alpha").click();
  await page.keyboard.press(`${MOD}+t`);
  await expect(tab(page, HOME)).toHaveAttribute("aria-selected", "true");
  await tab(page, "Alpha").click();
  await page.getByRole("button", { name: "New tab", exact: true }).click();
  await expect(tab(page, HOME)).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => tabNames(page)).toEqual([HOME, "Alpha"]);
});

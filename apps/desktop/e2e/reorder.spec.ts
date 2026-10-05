import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const sidebar = (page: Page) => page.getByRole("list", { name: "Rooms" });
const names = (page: Page) => sidebar(page).getByRole("button").allTextContents();

/** A real pointer drag: press on `from`, move in small steps to `y` inside `to`, release. */
async function drag(page: Page, from: string, to: string, half: "top" | "bottom") {
  const a = (await sidebar(page).getByRole("button", { name: from }).boundingBox())!;
  const b = (await sidebar(page).getByRole("button", { name: to }).boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  const y = half === "top" ? b.y + b.height * 0.2 : b.y + b.height * 0.8;
  await page.mouse.move(a.x + a.width / 2, y, { steps: 12 });
  await page.mouse.up();
}

test("dragging a sidebar room reorders the rooms and the core keeps the order", async ({ page, daemon }) => {
  for (const n of ["Alpha", "Beta", "Gamma"]) await daemon.createRoom(n);
  await page.goto("/");
  await expect.poll(() => names(page)).toEqual(["Alpha", "Beta", "Gamma"]); // the empty inbox is hidden

  await drag(page, "Gamma", "Alpha", "top");
  await expect.poll(() => names(page)).toEqual(["Gamma", "Alpha", "Beta"]);
  await drag(page, "Gamma", "Beta", "bottom");
  await expect.poll(() => names(page)).toEqual(["Alpha", "Beta", "Gamma"]);
  expect((await daemon.listRooms()).map((r) => r.name)).toEqual(["inbox", "Alpha", "Beta", "Gamma"]);
});

import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const list = (page: Page, name: "Pinned" | "Rooms") => page.getByRole("list", { name });
const names = (page: Page, name: "Pinned" | "Rooms") => list(page, name).getByRole("button").allTextContents();

async function pick(page: Page, room: string, colour: string) {
  await page.getByRole("button", { name: room, exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Colour" }).click();
  await page.getByRole("menuitemradio", { name: new RegExp(`^${colour}`) }).click();
}

/** A real pointer drag from `from`'s centre to the top or bottom of `to`. */
async function drag(page: Page, from: string, to: string, half: "top" | "bottom") {
  const a = (await page.getByRole("button", { name: from, exact: true }).boundingBox())!;
  const b = (await page.getByRole("button", { name: to, exact: true }).boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  const y = half === "top" ? b.y + b.height * 0.2 : b.y + b.height * 0.8;
  await page.mouse.move(a.x + a.width / 2, y, { steps: 12 });
  await page.mouse.up();
}

test("a colour pins a room into its own section, drags stay within a section, and None unpins", async ({ page, daemon }) => {
  for (const n of ["Alpha", "Beta", "Gamma", "Delta"]) await daemon.createRoom(n);
  await page.goto("/");
  await expect.poll(() => names(page, "Rooms")).toEqual(["Alpha", "Beta", "Gamma", "Delta"]);
  await expect(list(page, "Pinned")).toHaveCount(0);

  await pick(page, "Gamma", "Sage");
  await expect.poll(() => names(page, "Pinned")).toEqual(["Gamma"]);
  await pick(page, "Alpha", "Rose");
  await expect.poll(() => names(page, "Pinned")).toEqual(["Gamma", "Alpha"]);
  await expect.poll(() => names(page, "Rooms")).toEqual(["Beta", "Delta"]);

  // The menu says which pinned room holds each colour.
  await page.getByRole("button", { name: "Delta", exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Colour" }).click();
  await expect(page.getByRole("menuitemradio", { name: /^Rose/ })).toHaveText("RoseAlpha");
  await expect(page.getByRole("menuitemradio", { name: /^Sage/ })).toHaveText("SageGamma");
  await expect(page.getByRole("menuitemradio", { name: /^None/ })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  await drag(page, "Alpha", "Gamma", "top");
  await expect.poll(() => names(page, "Pinned")).toEqual(["Alpha", "Gamma"]);
  // Beta carried up over the pinned rooms stays in Rooms.
  await drag(page, "Beta", "Alpha", "top");
  await page.waitForTimeout(300);
  expect(await names(page, "Pinned")).toEqual(["Alpha", "Gamma"]);
  expect(await names(page, "Rooms")).toEqual(["Beta", "Delta"]);
  await drag(page, "Delta", "Beta", "top");
  await expect.poll(() => names(page, "Rooms")).toEqual(["Delta", "Beta"]);

  const core = async () => (await daemon.listRooms()).map((r) => `${r.name}:${r.color ?? "-"}`);
  await expect.poll(core).toEqual(["inbox:-", "Alpha:rose", "Gamma:sage", "Delta:-", "Beta:-"]);

  await pick(page, "Gamma", "None");
  await expect.poll(() => names(page, "Pinned")).toEqual(["Alpha"]);
  await expect.poll(() => names(page, "Rooms")).toEqual(["Gamma", "Delta", "Beta"]);
  await expect.poll(core).toEqual(["inbox:-", "Alpha:rose", "Gamma:-", "Delta:-", "Beta:-"]);
});

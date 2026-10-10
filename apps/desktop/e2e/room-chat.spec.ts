import type { Page } from "@playwright/test";
import { expect, MOD, test } from "./fixtures";
import { installStreamingAgent } from "./streamingAgent";

const ROOM_PLACEHOLDER = "Ask about this room…";

async function openRoom(page: Page, room: string) {
  await page.getByRole("list", { name: "Rooms" }).getByRole("button", { name: room, exact: true }).click();
  await expect(page.getByRole("tab", { name: room, exact: true, selected: true })).toBeVisible();
}

test("ask a room, keep its thread across a reload, and keep it out of the doc's thread", async ({ page, daemon }) => {
  installStreamingAgent(daemon, "Room");
  await daemon.createRoom("harness");
  await daemon.write("harness/alpha.html", "<html><head><title>Alpha</title></head><body>a</body></html>");
  await daemon.write("harness/beta.html", "<html><head><title>Beta</title></head><body>b</body></html>");

  await page.goto("/");
  await openRoom(page, "harness");
  await expect(page.getByTestId("artifact-card")).toHaveCount(2);
  const input = page.getByPlaceholder(ROOM_PLACEHOLDER);
  await expect(input).toBeVisible();

  await page.keyboard.press(`${MOD}+j`);
  await expect(input).toHaveCount(0);
  await page.keyboard.press(`${MOD}+j`);
  await expect(input).toBeFocused();

  await input.fill("Which doc is first?");
  await input.press("Enter");
  await expect(page.getByText(/^Read · (alpha|beta)\.html$/)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Room answer to Which doc is first?")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/^Read · /)).toHaveCount(0);
  await expect(page.getByText("fake-stream", { exact: true }).first()).toBeVisible();

  // The room tab comes back on its own; a click elsewhere would fold the thread.
  await page.reload();
  await expect(page.getByRole("tab", { name: "harness", exact: true, selected: true })).toBeVisible();
  await expect(page.getByText("Room answer to Which doc is first?")).toBeVisible();

  const card = page.getByTestId("artifact-card").filter({ hasText: "Alpha" });
  await card.hover();
  await card.getByRole("button", { name: "Open in new tab" }).click();
  await expect(page.getByRole("tab", { name: "Alpha", selected: true })).toBeVisible();
  await expect(page.getByPlaceholder("Ask about this artifact…")).toBeVisible();
  await expect(page.getByText("Room answer to Which doc is first?")).toHaveCount(0);
});

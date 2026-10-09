import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, MOD, test, type Daemon } from "./fixtures";

const ROOM_PLACEHOLDER = "Ask about this room…";

/**
 * A streaming fake agent: one Read of the first listed doc for a second, then the answer in two
 * deltas. Its argv carries the scope settings, so roomsd reports its reads as scoped.
 */
function installStreamingAgent(daemon: Daemon) {
  const bin = join(daemon.home, "fake-stream.sh");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      `doc=$(printf %s "$1" | grep '^- "' | head -n 1 | cut -d '"' -f 2)`,
      `q=$(printf %s "$1" | tail -n 1 | sed 's/^Question: //')`,
      `printf '{"t":"act","p":"%s"}\\n' "$doc"; sleep 1`,
      `printf '{"t":"d","x":"Room answer to "}\\n'; sleep 0.4`,
      `printf '{"t":"d","x":"%s"}\\n' "$q"`,
    ].join("\n") + "\n",
  );
  chmodSync(bin, 0o755);
  mkdirSync(join(daemon.home, ".rooms"), { recursive: true });
  writeFileSync(
    join(daemon.home, ".rooms/agents.toml"),
    [
      'default = "fake-stream"',
      "[agents.fake-stream]",
      `new = ["${bin}", "{prompt}", "--settings", "{scope_settings}"]`,
      "[[agents.fake-stream.events]]",
      'match = { "/t" = "act" }',
      'label = "Read"',
      'activity = ["/p"]',
      "[[agents.fake-stream.events]]",
      'match = { "/t" = "d" }',
      'delta = "/x"',
      "",
    ].join("\n"),
  );
}

async function openRoom(page: Page, room: string) {
  await page.getByRole("list", { name: "Rooms" }).getByRole("button", { name: room, exact: true }).click();
  await expect(page.getByRole("tab", { name: room, exact: true, selected: true })).toBeVisible();
}

test("ask a room, keep its thread across a reload, and keep it out of the doc's thread", async ({ page, daemon }) => {
  installStreamingAgent(daemon);
  const harness = await daemon.createRoom("harness");
  await daemon.write("harness/alpha.html", "<html><head><title>Alpha</title></head><body>a</body></html>");
  await daemon.write("harness/beta.html", "<html><head><title>Beta</title></head><body>b</body></html>");

  await page.goto("/");
  await openRoom(page, "harness");
  await expect(page.getByTestId("artifact-card")).toHaveCount(2);
  const input = page.getByPlaceholder(ROOM_PLACEHOLDER);
  await expect(input).toBeVisible();
  await expect(page.getByRole("img", { name: "Reads only this room's docs" })).toBeVisible();

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
  await expect(page.getByPlaceholder("Ask about this doc…")).toBeVisible();
  await expect(page.getByText("Room answer to Which doc is first?")).toHaveCount(0);

  const thread = (await (await fetch(`${daemon.baseUrl}/v1/asks?scope=room:${harness.id}`)).json()) as { scope: unknown; status: string }[];
  expect(thread).toHaveLength(1);
  expect(thread[0]).toMatchObject({ scope: { kind: "room", roomId: harness.id }, status: "done" });
  expect(await daemon.exists(`.rooms/asks/room-${harness.id}.jsonl`)).toBe(true);
});

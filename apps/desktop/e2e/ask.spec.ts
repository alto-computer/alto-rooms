import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, MOD, test } from "./fixtures";

const PLACEHOLDER = "Ask about this doc…";

async function openDocTab(page: Page, room: string, title: string) {
  await page.getByRole("list", { name: "Rooms" }).getByRole("button", { name: room, exact: true }).click();
  const card = page.getByTestId("artifact-card").filter({ hasText: title });
  await expect(card).toBeVisible({ timeout: 5000 });
  await card.hover();
  await card.getByRole("button", { name: "Open in new tab" }).click();
  await expect(page.getByRole("tab", { name: title, selected: true })).toBeVisible();
}

test("ask a doc and get the fake agent's answer", async ({ page, daemon }) => {
  // A fake agent: prints the last line of its last argument back.
  const bin = join(daemon.home, "fake-agent.sh");
  writeFileSync(bin, '#!/bin/sh\nfor a in "$@"; do last="$a"; done\nprintf "**Answer:** %s\\n" "$(printf %s "$last" | tail -n 1)"\n');
  chmodSync(bin, 0o755);
  mkdirSync(join(daemon.home, ".rooms"), { recursive: true });
  writeFileSync(join(daemon.home, ".rooms/agents.toml"), `[agents.claude-code]\nnew = ["${bin}", "{prompt}"]\n`);

  const harness = await daemon.createRoom("harness");
  await daemon.write("harness/doc.html", "<html><head><title>Doc</title></head><body>hello</body></html>");

  await page.goto("/");
  await openDocTab(page, "harness", "Doc");
  // Open at launch; ⌘J hides it and shows it again.
  const input = page.getByPlaceholder(PLACEHOLDER);
  await expect(input).toBeVisible();
  await page.keyboard.press(`${MOD}+j`);
  await expect(input).toHaveCount(0);
  await page.keyboard.press(`${MOD}+j`);
  await expect(input).toBeFocused();
  await input.fill("왜 이렇게 했어?");
  await input.press("Enter");
  await expect(page.getByText("Question: 왜 이렇게 했어?")).toBeVisible({ timeout: 10_000 });
  const head = page.getByText("claude-code · New conversation", { exact: true });
  await expect(head).toBeVisible();
  await expect(head).toHaveAttribute("title", "Couldn't find the thread that made this doc");

  // Survives a reload: the thread comes back from roomsd.
  await page.reload();
  await openDocTab(page, "harness", "Doc");
  await expect(page.getByText("Question: 왜 이렇게 했어?")).toBeVisible();

  // The thread is keyed by the doc's scope, in the file named by its file key.
  const [art] = (await (await fetch(`${daemon.baseUrl}/v1/rooms/${harness.id}/artifacts`)).json()) as { fileKey: string }[];
  const thread = (await (await fetch(`${daemon.baseUrl}/v1/asks?scope=doc:${art.fileKey}`)).json()) as { scope: unknown; status: string }[];
  expect(thread).toHaveLength(1);
  expect(thread[0]).toMatchObject({ scope: { kind: "doc", fileKey: art.fileKey }, status: "done" });
  expect(await daemon.exists(`.rooms/asks/${art.fileKey}.jsonl`)).toBe(true);
});

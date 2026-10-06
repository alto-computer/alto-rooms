import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, MOD, test } from "./fixtures";

const PLACEHOLDER = "이 문서에 대해 묻기…";

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
  writeFileSync(bin, '#!/bin/sh\nfor a in "$@"; do last="$a"; done\nprintf "**답:** %s\\n" "$(printf %s "$last" | tail -n 1)"\n');
  chmodSync(bin, 0o755);
  mkdirSync(join(daemon.home, ".rooms"), { recursive: true });
  writeFileSync(join(daemon.home, ".rooms/agents.toml"), `[agents.claude-code]\nnew = ["${bin}", "{prompt}"]\n`);

  await daemon.createRoom("harness");
  await daemon.write("harness/doc.html", "<html><head><title>Doc</title></head><body>hello</body></html>");

  await page.goto("/");
  await openDocTab(page, "harness", "Doc");
  await expect(page.getByPlaceholder(PLACEHOLDER)).toHaveCount(0);
  await page.keyboard.press(`${MOD}+j`);
  const input = page.getByPlaceholder(PLACEHOLDER);
  await input.fill("왜 이렇게 했어?");
  await input.press("Enter");
  await expect(page.getByText("질문: 왜 이렇게 했어?")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("claude-code · 새 대화")).toBeVisible();

  // Survives a reload: the thread comes back from roomsd.
  await page.reload();
  await openDocTab(page, "harness", "Doc");
  await page.keyboard.press(`${MOD}+j`);
  await expect(page.getByText("질문: 왜 이렇게 했어?")).toBeVisible();
});

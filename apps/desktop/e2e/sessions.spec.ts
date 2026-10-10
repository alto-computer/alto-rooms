import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, MOD, test } from "./fixtures";

test("a Journal session opens in its own tab, asks in its own session, and goes in a room", async ({ page, daemon }) => {
  // A fake agent: echoes the session it resumed and the question's line from its stdin.
  const bin = join(daemon.home, "fake-agent.sh");
  writeFileSync(bin, '#!/bin/sh\nq=$(tail -n 1)\nprintf "**Resumed** %s, %s\\n" "$1" "$q"\n');
  chmodSync(bin, 0o755);
  mkdirSync(join(daemon.home, ".rooms"), { recursive: true });
  writeFileSync(join(daemon.home, ".rooms/agents.toml"), `[agents.claude-code]\nresume = ["${bin}", "{session}"]\nnew = ["${bin}", "--settings", "{scope_settings}"]\n`);
  await daemon.createRoom("Benchmarks");
  await daemon.createRoom("Research");
  const at = new Date();
  at.setHours(9, 0, 0, 0);
  await daemon.addConversation({
    agent: "claude-code",
    session: "e2e-s1",
    cwd: daemon.home,
    at,
    messages: ["Why is cold start slow?", "Looking.", "Go on.", "Spawning roomsd after first paint fixes most of it."],
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Journal", exact: true }).click();
  const row = page.getByTestId("day-conversation").filter({ hasText: "Why is cold start slow?" });
  await row.hover();
  await expect(row.getByRole("button", { name: "More for Why is cold start slow?" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Continue in/ })).toHaveCount(0);
  await row.click();
  await expect(page.getByRole("tab", { name: "Why is cold start slow?", selected: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "Session actions" }).getByRole("button", { name: "Continue in Claude Code" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Why is cold start slow?");
  await expect(page.getByRole("article")).toContainText("4 messages");
  await expect(page.getByRole("region", { name: "Last reply" })).toContainText("Spawning roomsd after first paint");

  const input = page.getByPlaceholder("Ask about this session…");
  await input.fill("세 줄로 요약해줘");
  await input.press("Enter");
  await expect(page.getByText("Resumed e2e-s1, Question: 세 줄로 요약해줘")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("claude-code · continuing this session", { exact: true })).toBeVisible();
  await page.keyboard.press(`${MOD}+j`);
  await expect(input).toHaveCount(0);
  await page.keyboard.press(`${MOD}+j`);
  await expect(input).toBeFocused();

  // The tab and its thread come back after a reload.
  await page.reload();
  await expect(page.getByRole("tab", { name: "Why is cold start slow?", selected: true })).toBeVisible();
  await expect(page.getByText("Resumed e2e-s1, Question: 세 줄로 요약해줘")).toBeVisible();

  // The room chip opens the room list itself, with no submenu, and the pick moves the session.
  await page.getByRole("button", { name: "Add to Room" }).click();
  const chipMenu = page.getByRole("menu", { name: "Add to Room" });
  await expect(chipMenu.getByRole("menuitem")).toHaveCount(0);
  await chipMenu.getByRole("menuitemradio", { name: "Benchmarks" }).click();
  await expect(page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("button", { name: "Benchmarks" })).toBeVisible();
  await page.getByRole("button", { name: "Room: Benchmarks" }).click();
  await expect(page.getByRole("menuitemradio", { name: "Benchmarks" })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("menuitemradio", { name: "Research" }).click();
  await expect(page.getByRole("button", { name: "Room: Research" })).toBeVisible();
  await page.getByRole("button", { name: "Room: Research" }).click();
  await page.getByRole("menuitem", { name: "Remove from Room" }).click();
  await expect(page.getByRole("button", { name: "Add to Room" })).toBeVisible();
});

test("a Journal row's ⋯ menu adds the session to a room through its submenu", async ({ page, daemon }) => {
  await daemon.createRoom("Benchmarks");
  const at = new Date();
  at.setHours(9, 0, 0, 0);
  await daemon.addConversation({ agent: "claude-code", session: "e2e-s2", cwd: daemon.home, at, messages: ["Why is cold start slow?", "Looking."] });

  await page.goto("/");
  await page.getByRole("button", { name: "Journal", exact: true }).click();
  const row = page.getByTestId("day-conversation").filter({ hasText: "Why is cold start slow?" });
  await row.hover();
  await row.getByRole("button", { name: "More for Why is cold start slow?" }).click();
  await page.getByRole("menuitem", { name: "Add to Room" }).click();
  await page.getByRole("menuitemradio", { name: "Benchmarks" }).click();
  await expect(row).toContainText("Benchmarks");
});

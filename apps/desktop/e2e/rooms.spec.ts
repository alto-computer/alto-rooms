import fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, FILES_PORT, MOD, test } from "./fixtures";

async function openApp(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "새 방" })).toBeVisible();
}

async function createRoomInUi(page: Page, name: string) {
  await page.getByRole("button", { name: "새 방" }).click();
  const input = page.getByLabel("새 방 이름");
  await input.fill(name);
  await input.press("Enter");
  await expect(page.getByRole("tab", { name, selected: true })).toBeVisible();
}

const card = (page: Page, title: string) => page.getByTestId("artifact-card").filter({ hasText: title });

test("AC-5: 새 방 creates the folder and opens an empty room tab", async ({ page, daemon }) => {
  await openApp(page);
  await createRoomInUi(page, "연구 도구");
  expect(await daemon.exists("연구-도구")).toBe(true);
  await expect(page.getByText("아직 아티팩트가 없어요")).toBeVisible();
  await expect(page.getByText("에이전트에게 이 폴더에 HTML로 저장해 달라고 하세요")).toBeVisible();
});

test("AC-1: an HTML file written to the folder shows up as a new card within 2s", async ({ page, daemon }) => {
  await openApp(page);
  await createRoomInUi(page, "연구 도구");
  await daemon.write("연구-도구/a.html", "<title>첫 문서</title>");
  const c = card(page, "첫 문서");
  await expect(c).toBeVisible({ timeout: 2000 });
  await expect(c.getByRole("img", { name: "새 문서 표시" })).toBeVisible();
  await expect(page.getByText("문서 1")).toBeVisible();
});

test("AC-6: renaming the room from its title renames the folder, tab and sidebar", async ({ page, daemon }) => {
  await openApp(page);
  await createRoomInUi(page, "연구 도구");
  await page.getByRole("heading", { level: 1, name: "연구 도구" }).click();
  const input = page.getByRole("textbox", { name: "방 이름" });
  await expect(input).toBeFocused();
  await input.fill("연구");
  await input.press("Enter");
  await expect.poll(() => daemon.exists("연구"), { timeout: 2000 }).toBe(true);
  expect(await daemon.exists("연구-도구")).toBe(false);
  await expect(page.getByRole("tab", { name: "연구", exact: true, selected: true })).toBeVisible();
  await expect(page.getByRole("list", { name: "방" }).getByRole("button", { name: "연구", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "연구", exact: true })).toBeVisible();
});

test("AC-9: 새 탭에서 크게 보기 opens a doc tab with the files-origin iframe", async ({ page, daemon }) => {
  await openApp(page);
  await createRoomInUi(page, "연구 도구");
  await daemon.write("연구-도구/a.html", "<title>첫 문서</title>");
  const c = card(page, "첫 문서");
  await expect(c).toBeVisible({ timeout: 2000 });
  await c.hover();
  await c.getByRole("button", { name: "새 탭에서 크게 보기" }).click();
  await expect(page.getByRole("tab", { name: "첫 문서", selected: true })).toBeVisible();
  const frame = page.getByRole("tabpanel").locator("iframe");
  await expect(frame).toHaveAttribute("src", new RegExp(`^http://127\\.0\\.0\\.1:${FILES_PORT}/`));
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts allow-popups");
});

test("AC-14: ⌘B hides the sidebar and ⌘B brings it back", async ({ page, daemon: _daemon }) => {
  await openApp(page);
  await page.keyboard.press(`${MOD}+b`);
  await expect(page.getByRole("button", { name: "사이드바 펼치기 (⌘B)" })).toBeVisible();
  await expect(page.getByRole("button", { name: "새 방" })).toBeHidden();
  await page.keyboard.press(`${MOD}+b`);
  await expect(page.getByRole("button", { name: "새 방" })).toBeVisible();
  await expect(page.getByRole("button", { name: "사이드바 펼치기 (⌘B)" })).toHaveCount(0);
});

test("Review Focus 2: renaming the folder on disk updates the open tab in place", async ({ page, daemon }) => {
  await openApp(page);
  await createRoomInUi(page, "연구 도구");
  await daemon.write("연구-도구/a.html", "<title>첫 문서</title>");
  await expect(card(page, "첫 문서")).toBeVisible({ timeout: 2000 });

  await fs.rename(path.join(daemon.home, "연구-도구"), path.join(daemon.home, "연구 노트"));

  await expect(page.getByRole("tab", { name: "연구 노트", selected: true })).toBeVisible({ timeout: 2000 });
  await expect(page.getByRole("list", { name: "방" }).getByRole("button", { name: "연구 노트" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "연구 노트" })).toBeVisible();
  await expect(card(page, "첫 문서")).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(2); // 새 탭 + the same room tab, not a second one
});

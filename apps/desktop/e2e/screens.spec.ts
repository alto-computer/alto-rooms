/*
 * Full-window screenshots (1440×900) of each screen, for visual review.
 * Written to e2e/__screens__/ (gitignored).
 */
import path from "node:path";
import type { Page } from "@playwright/test";
import { artifactHtml, expect, MOD, test, today } from "./fixtures";

const SCREENS = path.join(import.meta.dirname, "__screens__");
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(SCREENS, `${name}.png`) });

/** Moves the pointer off the cards and lets previews paint and transitions finish. */
async function settle(page: Page) {
  await page.mouse.move(720, 880);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(500);
}

test("screens for visual review", async ({ page, daemon }) => {
  const date = today();
  await daemon.createRoom("벤치마크");
  await daemon.createRoom("디자인 시스템");
  await daemon.createRoom("연구 도구");
  const docs: [string, string, string][] = [
    ["지연 시간 비교", "p50/p95를 세 런타임에서 측정했어요.", "#3b6fd8"],
    ["메모리 사용량", "힙 스냅샷 기준으로 정리했어요.", "#2f9e6e"],
    ["주간 리포트", "이번 주 회귀 2건과 개선 3건.", "#c9781a"],
    ["콜드 스타트", "첫 요청까지 걸리는 시간.", "#8a4fd0"],
  ];
  for (const [i, [title, body, accent]] of docs.entries()) {
    await daemon.write(`벤치마크/doc-${i + 1}.html`, artifactHtml(title, body, accent));
    await new Promise((r) => setTimeout(r, 30)); // distinct createdAt, oldest first
  }
  await daemon.write("디자인-시스템/tokens.html", artifactHtml("색 토큰", "ink, surface, thread.", "#ff385c"));
  await daemon.write(`journal/${date}/dream.html`, artifactHtml("어젯밤 복습", "어제 세 방에서 있었던 일.", "#444"));
  await daemon.saveNote(date, "계획", "- 할 일\n- 벤치마크 리포트 읽기\n- 디자인 토큰 정리");
  await daemon.saveNote(date, "회고", "오늘은 리포트를 끝냈다.");

  await page.goto("/");
  const rooms = page.getByRole("list", { name: "방" });

  // Room strip with 3+ cards.
  await rooms.getByRole("button", { name: "벤치마크" }).click();
  await expect(page.getByTestId("artifact-card")).toHaveCount(4);
  await settle(page);
  await shot(page, "room-strip");

  // Empty room.
  await rooms.getByRole("button", { name: "연구 도구" }).click();
  await expect(page.getByText("아직 아티팩트가 없어요")).toBeVisible();
  await settle(page);
  await shot(page, "empty-room");

  // Journal: dream, a room artifact, two notes.
  await page.getByRole("button", { name: "Journal" }).click();
  await expect(page.getByRole("region", { name: "에이전트가 쓴 것" }).getByTestId("artifact-card")).toHaveCount(6);
  await expect(page.getByRole("region", { name: "내가 쓴 것" }).getByRole("button", { name: "회고" })).toBeVisible();
  await settle(page);
  await shot(page, "journal");

  // Note tab.
  await page.getByRole("region", { name: "내가 쓴 것" }).getByRole("button", { name: "계획" }).click();
  await expect(page.getByRole("textbox", { name: "노트" })).toHaveValue(/벤치마크 리포트/);
  await settle(page);
  await shot(page, "note-tab");

  // New tab.
  await page.getByRole("button", { name: "새 탭", exact: true }).click();
  await expect(page.getByRole("heading", { name: "지난 방문 이후" })).toBeVisible();
  await settle(page);
  await shot(page, "new-tab");

  // Collapsed sidebar (on a room, so the strip shows at full width).
  await rooms.getByRole("button", { name: "벤치마크" }).click();
  await page.keyboard.press(`${MOD}+b`);
  await expect(page.getByRole("button", { name: "사이드바 펼치기 (⌘B)" })).toBeVisible();
  await settle(page);
  await shot(page, "collapsed-sidebar");
  await page.keyboard.press(`${MOD}+b`);
  await expect(page.getByRole("button", { name: "사이드바 접기 (⌘B)" })).toBeVisible();
  await settle(page);

  // QuickFind open, with a query that hits a room and documents.
  await page.keyboard.press(`${MOD}+k`);
  const input = page.getByPlaceholder("방이나 문서 찾기");
  await expect(input).toBeVisible();
  await input.fill("리포트");
  await expect(page.getByRole("option", { name: /주간 리포트/ })).toBeVisible();
  await page.waitForTimeout(300); // dialog open animation
  await shot(page, "quickfind");
});

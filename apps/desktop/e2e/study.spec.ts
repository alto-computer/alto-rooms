/*
 * The Study (서재) end to end, under the app's CSP: TipTap and React Flow must render with no
 * injected <style>, and every write must land in the files under .rooms/study.
 */
import path from "node:path";
import type { Page } from "@playwright/test";
import { artifactHtml, expect, test, today, type Daemon } from "./fixtures";

/** Screenshots for review: e2e/__screens__/study (gitignored), or STUDY_SCREENS. */
const SCREENS = process.env.STUDY_SCREENS ?? path.join(import.meta.dirname, "__screens__", "study");

type Summary = { id: string; name: string; volumes: { number: number; status: string }[] };

async function api<T>(daemon: Daemon, method: string, route: string, body?: unknown): Promise<T> {
  const r = await fetch(`${daemon.baseUrl}${route}`, {
    method,
    headers: { authorization: `Bearer ${daemon.token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${method} ${route}: ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

const studyRooms = async (daemon: Daemon) => (await api<{ rooms: Summary[] }>(daemon, "GET", "/v1/study")).rooms;
const volumeFile = (roomId: string, n: number) => `.rooms/study/rooms/${roomId}/volumes/${n}.json`;

async function openStudy(page: Page) {
  await page.goto("/");
  await page.getByRole("navigation").first().getByRole("button", { name: "서재", exact: true }).click();
  await expect(page.getByRole("tab", { name: "서재", selected: true })).toBeVisible();
}

test("a room made on the wall gets a draft; a card typed in it saves as markdown, survives a reload, and publishing shelves v0.1", async ({ page, daemon }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { cspViolations: string[] };
    w.cspViolations = [];
    document.addEventListener("securitypolicyviolation", (e) => w.cspViolations.push(`${e.violatedDirective} ${e.sourceFile} ${e.blockedURI.slice(0, 40)}`));
  });
  await openStudy(page);

  await page.getByRole("button", { name: "새 방" }).click();
  const name = page.getByLabel("새 방 이름");
  await name.fill("어텐션");
  await name.press("Enter");
  const proof = page.getByRole("button", { name: "어텐션 v0.1" });
  await expect(proof).toBeVisible();
  const [room] = await studyRooms(daemon);
  expect(room.name).toBe("어텐션");

  await proof.click();
  await expect(page.getByRole("tab", { name: "어텐션 v0.1", selected: true })).toBeVisible();
  const pane = page.locator(".react-flow__pane");
  await expect(pane).toBeVisible();
  const box = (await pane.boundingBox())!;
  await page.mouse.dblclick(box.x + 220, box.y + 160);
  const card = page.getByTestId("ink-card");
  await expect(card).toHaveCount(1);
  const editor = card.getByRole("textbox", { name: "카드" });
  await expect(editor).toBeFocused();
  await page.keyboard.type("# 제목");
  await page.keyboard.press("Enter");
  await page.keyboard.type("병목이 사라지는 이유xyz");
  // Backspace and Delete while typing edit the text; they never delete the card.
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("ArrowLeft");
  // ProseMirror takes the moved caret from the next selectionchange; a hand is never this quick.
  await page.waitForTimeout(100);
  await page.keyboard.press("Delete");
  await expect(card).toHaveCount(1);
  await expect(card.getByRole("heading", { level: 1, name: "제목" })).toBeVisible();
  await expect(card).toContainText("병목이 사라지는 이");

  // The heading is styled by study.css, not by an injected stylesheet the CSP would drop.
  const h1Size = await card.locator("h1").evaluate((el) => getComputedStyle(el).fontSize);
  expect(h1Size).toBe("19px");

  await expect
    .poll(async () => JSON.parse(await daemon.read(volumeFile(room.id, 1))).cards?.[0]?.body ?? "", { timeout: 5000 })
    .toBe("# 제목\n\n병목이 사라지는 이");

  await page.reload();
  await expect(page.getByRole("tab", { name: "어텐션 v0.1", selected: true })).toBeVisible();
  await expect(page.getByTestId("ink-card").getByRole("heading", { level: 1, name: "제목" })).toBeVisible();

  await page.getByRole("button", { name: "발행", exact: true }).click();
  await page.getByRole("button", { name: "발행하기" }).click();
  await expect(page.getByRole("tab", { name: "어텐션 v0.2", selected: true })).toBeVisible();
  await expect(page.getByTestId("ink-card").getByRole("heading", { level: 1, name: "제목" })).toBeVisible();
  const v1 = JSON.parse(await daemon.read(volumeFile(room.id, 1)));
  expect(v1.status).toBe("published");

  await page.getByRole("navigation").first().getByRole("button", { name: "서재", exact: true }).click();
  await expect(page.getByRole("tab", { name: "서재", selected: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "어텐션 v0.1" })).toHaveClass(/st-bk(?! st-proof)/);
  await expect(page.getByRole("button", { name: "어텐션 v0.2" })).toHaveClass(/st-proof/);

  // A published volume reads only: no editing, no adding.
  await page.getByRole("button", { name: "어텐션 v0.1" }).click();
  await expect(page.getByRole("tab", { name: "어텐션 v0.1", selected: true })).toBeVisible();
  await expect(page.getByTestId("ink-card").getByRole("textbox", { name: "카드" })).toHaveAttribute("contenteditable", "false");
  await expect(page.getByRole("button", { name: "+ 카드" })).toHaveCount(0);
  // Nothing the CSP refuses: no inlined font, no <style> from TipTap or React Flow. (The app's toaster
  // injects one from the main bundle at startup, which the CSP drops; that one is not the Study's.)
  const violations = await page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations);
  expect(violations.filter((v) => !/^style-src-elem \S+\/assets\/index-[\w-]+\.js /.test(v))).toEqual([]);
  expect(await page.evaluate(() => document.fonts.check('20px "Gowun Batang"') && document.fonts.check('20px "Instrument Serif"'))).toBe(true);
});

test("a memo and a todo on the calendar's day are saved to the day's file and come back after a reload", async ({ page, daemon }) => {
  const date = today();
  await daemon.createRoom("벤치마크");
  await daemon.write("벤치마크/report.html", artifactHtml("주간 리포트"));
  await openStudy(page);
  await page.getByRole("button", { name: "달력", exact: true }).click();
  await expect(page.getByRole("tab", { name: /^달력 · /, selected: true })).toBeVisible();

  const memo = page.getByRole("textbox", { name: "Memo" });
  await memo.fill("라우터가 하나면 병목 아닌가");
  await memo.press("Enter");
  const todo = page.getByRole("textbox", { name: "TODO" });
  await todo.fill("리뷰 준비");
  await todo.press("Enter");
  await page.getByRole("checkbox", { name: "리뷰 준비" }).check();
  await expect(page.getByRole("region", { name: "Artifacts" }).getByRole("button", { name: "주간 리포트" })).toBeVisible({ timeout: 3000 });

  await expect
    .poll(async () => {
      const day = JSON.parse(await daemon.read(`.rooms/study/days/${date}.json`).catch(() => "{}"));
      return [day.memos?.map((m: { text: string }) => m.text), day.todos?.map((t: { text: string; done: boolean }) => [t.text, t.done])];
    })
    .toEqual([["라우터가 하나면 병목 아닌가"], [["리뷰 준비", true]]]);

  await page.reload();
  await expect(page.getByRole("region", { name: "Memo" }).getByText("라우터가 하나면 병목 아닌가")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "리뷰 준비" })).toBeChecked();
});

test("a study room links a Rooms room and opens it in a tab", async ({ page, daemon }) => {
  await daemon.createRoom("리서치");
  await api(daemon, "POST", "/v1/study/rooms", { name: "제1원리" });
  await openStudy(page);
  await page.getByRole("listitem").filter({ hasText: "제1원리" }).getByRole("button", { name: "제1원리", exact: true }).click();
  await expect(page.getByRole("tab", { name: "서재 · 제1원리", selected: true })).toBeVisible();
  await page.getByRole("button", { name: "연결" }).click();
  await page.getByRole("option", { name: "리서치" }).click();
  const links = page.getByRole("list", { name: "연결된 방과 아티팩트" });
  await expect(links.getByRole("button", { name: "리서치", exact: true })).toBeVisible();
  const [room] = await studyRooms(daemon);
  expect(JSON.parse(await daemon.read(`.rooms/study/rooms/${room.id}/room.json`)).links).toEqual([{ kind: "room", roomId: expect.any(String) }]);
  await links.getByRole("button", { name: "리서치", exact: true }).click();
  await expect(page.getByRole("tab", { name: "리서치", selected: true })).toBeVisible();
});

/** A Study with some history: rooms with published volumes and drafts, cards, a day with memos. */
async function seed(daemon: Daemon) {
  const rs = await daemon.createRoom("리서치");
  await daemon.write("리서치/router.html", artifactHtml("Router와 Worker는 왜 나뉠까"));
  await daemon.write("리서치/flow.html", artifactHtml("react-flow와 tldraw"));
  await daemon.write("inbox/seminar.html", artifactHtml("D-Shift 코드 세미나"));
  const rooms: [string, string[]][] = [
    ["어텐션", ["처음 만남", "점수로 섞는다", "병목이 사라지는 이유"]],
    ["Alto Rooms", ["방은 주제다"]],
    ["에이전트 설계", []],
    ["제1원리", ["쪼개 보기", "비용을 다시 세다", "가정 목록", "다시 조립하기", "틀린 곳에서 시작"]],
    ["읽기 노트", ["A New City"]],
  ];
  const ids: Record<string, string> = {};
  for (const [name, titles] of rooms) {
    const r = await api<Summary>(daemon, "POST", "/v1/study/rooms", { name });
    ids[name] = r.id;
    for (const [i, title] of titles.entries()) {
      const cards =
        i === titles.length - 1 && name === "어텐션"
          ? [
              { id: "a", kind: "ink", x: 40, y: 60, width: 280, body: "# Router와 Worker\n\nRouter는 대화와 배분만 한다. 일은 Worker가 하고, 세션은 시스템이 관리한다." },
              { id: "b", kind: "ink", x: 420, y: 20, width: 280, body: "세션은 구현 세부사항이어야지, 사람의 정신적 부담이어서는 안 된다." },
              { id: "c", kind: "question", x: 460, y: 260, width: 240, body: "Router가 하나면 병목 아닌가" },
              { id: "d", kind: "ink", x: 60, y: 330, width: 300, body: "- 사서 하나가 흔적을 본다\n- 공부거리는 연재별 에이전트가 쓴다" },
            ]
          : [];
      const edges = cards.length ? [{ id: "e1", source: "a", target: "b" }, { id: "e2", source: "a", target: "c" }, { id: "e3", source: "a", target: "d" }] : [];
      await api(daemon, "PUT", `/v1/study/rooms/${r.id}/volumes/${i + 1}`, { title, cards, edges });
      await api(daemon, "POST", `/v1/study/rooms/${r.id}/publish`);
    }
  }
  await api(daemon, "PUT", `/v1/study/rooms/${ids["어텐션"]}`, { name: "어텐션", links: [{ kind: "room", roomId: rs.id }] });
  await api(daemon, "PUT", `/v1/study/days/${today()}`, {
    memos: [
      { id: "m1", text: "Router가 하나면 병목 아닌가", at: new Date().toISOString() },
      { id: "m2", text: "사람이 따라갈 수 있는 세션은 왜 3~5개일까", at: new Date().toISOString() },
    ],
    todos: [
      { id: "t1", text: "책 안 캔버스 고르기", done: true, at: new Date().toISOString() },
      { id: "t2", text: "로드맵 리뷰 준비", done: false, at: new Date().toISOString() },
    ],
  });
  return ids;
}

test("screens of the Study in light and dark", async ({ page, daemon }, info) => {
  test.skip(info.project.name !== "chromium", "one set of screens is enough");
  test.setTimeout(90_000);
  const ids = await seed(daemon);
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await openStudy(page);
    await page.getByRole("button", { name: "어텐션 v0.1" }).waitFor();
    await page.mouse.move(5, 890);
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SCREENS, `library-${scheme}.png`) });
    await page.getByRole("listitem").filter({ hasText: "제1원리" }).hover();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SCREENS, `library-hover-${scheme}.png`) });

    await page.getByRole("listitem").filter({ hasText: "어텐션" }).getByRole("button", { name: "어텐션", exact: true }).click();
    await expect(page.getByRole("tab", { name: "서재 · 어텐션", selected: true })).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SCREENS, `room-${scheme}.png`) });

    await page.getByRole("button", { name: "펼쳐 읽기 →" }).click();
    await expect(page.getByRole("tab", { name: "어텐션 v0.3", selected: true })).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SCREENS, `volume-published-${scheme}.png`) });
    await page.goBack().catch(() => {});
    await page.evaluate(() => 0);

    await openStudy(page);
    await page.getByRole("button", { name: "어텐션 v0.4" }).click();
    await expect(page.getByTestId("ink-card")).toHaveCount(3);
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SCREENS, `volume-${scheme}.png`) });

    await openStudy(page);
    await page.getByRole("button", { name: "달력", exact: true }).click();
    await expect(page.getByRole("region", { name: "Artifacts" }).getByRole("button")).toHaveCount(3, { timeout: 3000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SCREENS, `day-${scheme}.png`) });
  }
  expect(Object.keys(ids)).toHaveLength(5);
});

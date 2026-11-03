/*
 * The Study (서재) end to end, under the app's CSP: TipTap and React Flow must render with no
 * injected <style>, and every write must land in the files under .rooms/study.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
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
  await page.getByRole("navigation").first().getByRole("button", { name: "Study", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Study", selected: true })).toBeVisible();
}

test("a room made on the wall gets a draft; a card typed in it saves as markdown, survives a reload, and publishing shelves v0.1", async ({ page, daemon }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { cspViolations: string[] };
    w.cspViolations = [];
    document.addEventListener("securitypolicyviolation", (e) => w.cspViolations.push(`${e.violatedDirective} ${e.sourceFile} ${e.blockedURI.slice(0, 40)}`));
  });
  await openStudy(page);

  await page.getByRole("list", { name: "Study rooms" }).getByRole("button", { name: "New room" }).click();
  const name = page.getByLabel("New room name");
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
  const editor = card.getByRole("textbox", { name: "Card" });
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

  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByRole("tab", { name: "어텐션 v0.2", selected: true })).toBeVisible();
  await expect(page.getByTestId("ink-card").getByRole("heading", { level: 1, name: "제목" })).toBeVisible();
  const v1 = JSON.parse(await daemon.read(volumeFile(room.id, 1)));
  expect(v1.status).toBe("published");

  await page.getByRole("navigation").first().getByRole("button", { name: "Study", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Study", selected: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "어텐션 v0.1" })).toHaveClass(/st-bk(?! st-proof)/);
  await expect(page.getByRole("button", { name: "어텐션 v0.2" })).toHaveClass(/st-proof/);

  // A published volume reads only: no editing, no adding.
  await page.getByRole("button", { name: "어텐션 v0.1" }).click();
  await expect(page.getByRole("tab", { name: "어텐션 v0.1", selected: true })).toBeVisible();
  await expect(page.getByTestId("ink-card").getByRole("textbox", { name: "Card" })).toHaveAttribute("contenteditable", "false");
  await expect(page.getByRole("button", { name: "+ Card" })).toHaveCount(0);
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
  await page.getByRole("button", { name: "Calendar", exact: true }).click();
  await expect(page.getByRole("tab", { name: /^Calendar · /, selected: true })).toBeVisible();

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
  await expect(page.getByRole("tab", { name: "Study · 제1원리", selected: true })).toBeVisible();
  await page.getByRole("button", { name: "Link" }).click();
  await page.getByRole("option", { name: "리서치" }).click();
  const links = page.getByRole("list", { name: "Linked rooms and artifacts" });
  await expect(links.getByRole("button", { name: "리서치", exact: true })).toBeVisible();
  const [room] = await studyRooms(daemon);
  expect(JSON.parse(await daemon.read(`.rooms/study/rooms/${room.id}/room.json`)).links).toEqual([{ kind: "room", roomId: expect.any(String) }]);
  await links.getByRole("button", { name: "리서치", exact: true }).click();
  await expect(page.getByRole("tab", { name: "리서치", selected: true })).toBeVisible();
});

/** The default agent for asks: it answers with the prompt's Study lines, so the test reads what roomsd sent. */
function installEchoAgent(daemon: Daemon) {
  const bin = path.join(daemon.home, "echo-study.sh");
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$1" | grep -E '^(Study room: |Volume: |Study day: |Book: |Memo [0-9]+:|> |- [[]|Card [0-9]+ |- card |- v0[.]|Documents [(])' | sed 's/^> /quote: /'\n`);
  chmodSync(bin, 0o755);
  mkdirSync(path.join(daemon.home, ".rooms"), { recursive: true });
  writeFileSync(path.join(daemon.home, ".rooms/agents.toml"), `default = "echo"\n[agents.echo]\nnew = ["${bin}", "{prompt}", "--settings", "{scope_settings}"]\n`);
}

test("the one ask bar asks about a volume with its cards and lines, and about its room with its volumes", async ({ page, daemon }, info) => {
  installEchoAgent(daemon);
  const r = await api<Summary>(daemon, "POST", "/v1/study/rooms", { name: "어텐션" });
  await api(daemon, "PUT", `/v1/study/rooms/${r.id}/volumes/1`, {
    title: "병목",
    cards: [
      { id: "a", kind: "ink", x: 40, y: 60, width: 280, body: "# Router와 Worker\n\nRouter는 배분만 한다." },
      { id: "b", kind: "question", x: 420, y: 60, width: 240, body: "Router가 하나면 병목 아닌가" },
    ],
    edges: [{ id: "e1", source: "a", target: "b" }],
  });
  await openStudy(page);
  await page.getByRole("button", { name: "어텐션 v0.1" }).click();
  await expect(page.getByTestId("ink-card")).toHaveCount(1);

  const input = page.getByPlaceholder("Ask about this volume…");
  await expect(input).toBeVisible();
  await expect(page.getByPlaceholder(/^Ask about/)).toHaveCount(1);
  // The canvas tools sit in the bar on top, where the ask bar never covers them.
  for (const name of ["+ Card", "+ ?", "Publish"]) await page.getByRole("button", { name, exact: true }).click({ trial: true });
  await input.fill("이 판을 요약해줘");
  // The Study's button reset stops at the bar: Send keeps the app's filled circle.
  const send = page.getByRole("button", { name: "Send", exact: true });
  expect(await send.evaluate((b) => [getComputedStyle(b).backgroundColor, getComputedStyle(b).borderRadius])).not.toContain("rgba(0, 0, 0, 0)");
  await input.press("Enter");
  const answer = page.getByText(/Volume: v0\.1 "병목" \(draft\)/);
  await expect(answer).toBeVisible({ timeout: 10_000 });
  await expect(answer).toContainText("Card 1 (ink):");
  await expect(answer).toContainText("Card 2 (question):");
  await expect(page.getByRole("listitem").filter({ hasText: "card 1 → card 2" })).toBeVisible();
  if (info.project.name === "chromium") await page.screenshot({ path: path.join(SCREENS, "volume-ask.png") });
  expect(await daemon.read(`.rooms/asks/study-volume-${r.id}-1.jsonl`)).toContain("이 판을 요약해줘");
  await expect(page.getByTestId("ink-card")).toHaveCount(1);

  await page.getByRole("button", { name: "← 어텐션" }).click();
  const roomInput = page.getByPlaceholder("Ask about this Study room…");
  await expect(roomInput).toBeVisible();
  await roomInput.fill("판이 몇 개야?");
  await roomInput.press("Enter");
  await expect(page.getByText(/Study room: "어텐션"/)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/v0\.1 "병목" \(draft\)/)).toBeVisible();
  await expect(page.getByText("이 판을 요약해줘")).toHaveCount(0);
});

test("today's book opens from the day page, keeps a heading card across a reload, shelves as today's proof, and asks with the day", async ({ page, daemon }) => {
  installEchoAgent(daemon);
  const date = today();
  const short = date.slice(5).replace("-", ".");
  const at = new Date().toISOString();
  await api(daemon, "PUT", `/v1/study/days/${date}`, {
    memos: [{ id: "m1", text: "라우터가 하나면 병목 아닌가", at }],
    todos: [{ id: "t1", text: "리뷰 준비", done: true, at }],
  });
  await openStudy(page);
  await page.getByRole("button", { name: "Calendar", exact: true }).click();
  await page.getByRole("button", { name: `Book · ${short}` }).click();
  const tab = page.getByRole("tab", { name: `Book · ${short}`, selected: true });
  await expect(tab).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish" })).toHaveCount(0);

  const pane = page.locator(".react-flow__pane");
  await expect(pane).toBeVisible();
  const box = (await pane.boundingBox())!;
  await page.mouse.dblclick(box.x + 220, box.y + 160);
  await expect(page.getByTestId("ink-card").getByRole("textbox", { name: "Card" })).toBeFocused();
  await page.keyboard.type("# 오늘 정리");
  await page.getByRole("textbox", { name: "Title" }).fill("하루 정리");
  const bookFile = `.rooms/study/books/${date}.json`;
  await expect
    .poll(async () => {
      const book = JSON.parse(await daemon.read(bookFile).catch(() => "{}"));
      return [book.date, book.title, book.cards?.map((c: { body: string }) => c.body)];
    }, { timeout: 5000 })
    .toEqual([date, "하루 정리", ["# 오늘 정리"]]);

  await page.reload();
  await expect(tab).toBeVisible();
  await expect(page.getByTestId("ink-card").getByRole("heading", { level: 1, name: "오늘 정리" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue("하루 정리");

  await page.getByRole("button", { name: `← ${short}` }).click();
  await expect(page.getByRole("tab", { name: `Calendar · ${short}`, selected: true })).toBeVisible();
  await expect(page.getByRole("button", { name: `Book · ${short}` })).toContainText("하루 정리");
  await expect(page.getByRole("button", { name: date, exact: true })).toHaveClass(/st-has/);
  await page.getByRole("button", { name: date.slice(0, 7).replace("-", "."), exact: true }).click();
  await expect(page.getByRole("tab", { name: "Shelf", selected: true })).toBeVisible();
  const spine = page.getByRole("list", { name: "Shelf" }).getByRole("button", { name: `Book · ${date.replaceAll("-", ".")}` });
  await expect(spine).toHaveClass(/st-proof/);
  await expect(spine).toContainText("하루 정리");

  await spine.click();
  await expect(tab).toBeVisible();
  await expect(page.getByTestId("ink-card").getByRole("heading", { level: 1, name: "오늘 정리" })).toBeVisible();
  const input = page.getByPlaceholder("Ask about this book…");
  await input.fill("오늘을 정리해줘");
  await input.press("Enter");
  const answer = page.getByText(new RegExp(`Study day: ${date}`));
  await expect(answer).toBeVisible({ timeout: 10_000 });
  await expect(answer).toContainText('Book: "하루 정리"');
  const turn = JSON.parse((await daemon.read(`.rooms/asks/study-book-${date}.jsonl`)).trim().split("\n").at(-1)!);
  expect(turn.question).toBe("오늘을 정리해줘");
  for (const line of ["Memo 1:\nquote: 라우터가 하나면 병목 아닌가", '- [x] "리뷰 준비"', "Card 1 (ink):\nquote: # 오늘 정리"]) expect(turn.answer).toContain(line);
});

/** Drags with the mouse from one point to another, in steps, the way a hand does. */
async function dragBy(page: Page, from: { x: number; y: number }, dx: number, dy: number) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(from.x + (dx * i) / 8, from.y + (dy * i) / 8);
  await page.mouse.up();
}

test("a section carries the card inside it, a card and a section resize, and a card opened beside edits as a page; all of it survives a reload", async ({ page, daemon }, info) => {
  const r = await api<Summary>(daemon, "POST", "/v1/study/rooms", { name: "캔버스" });
  await openStudy(page);
  await page.getByRole("button", { name: "캔버스 v0.1" }).click();
  await expect(page.getByRole("tab", { name: "캔버스 v0.1", selected: true })).toBeVisible();
  const file = async () => JSON.parse(await daemon.read(volumeFile(r.id, 1))) as { cards: { id: string; kind: string; x: number; y: number; width: number; height?: number; body: string }[] };
  const byKind = async (kind: string) => (await file()).cards.find((c) => c.kind === kind);

  await page.getByRole("button", { name: "+ Section", exact: true }).click();
  const sectionTitle = page.getByRole("textbox", { name: "Section title" });
  await expect(sectionTitle).toBeFocused();
  await page.keyboard.type("읽은 것");
  const section = page.getByTestId("section");
  const frame = (await section.boundingBox())!;

  // The frame lets a double-click through to the sheet: the card is made inside it.
  await page.mouse.dblclick(frame.x + 60, frame.y + 90);
  const card = page.getByTestId("ink-card");
  const cardEditor = card.getByRole("textbox", { name: "Card" });
  await expect(cardEditor).toBeFocused();
  await expect(card.locator("h1.is-editor-empty")).toHaveAttribute("data-placeholder", "Heading 1");
  if (info.project.name === "chromium") await page.screenshot({ path: path.join(SCREENS, "canvas-new-card.png") });
  await page.keyboard.type("카드 제목");
  await expect(card.getByRole("heading", { level: 1, name: "카드 제목" })).toBeVisible();

  await page.getByRole("button", { name: "+ Text", exact: true }).click();
  const text = page.getByTestId("text-node");
  await expect(text.getByRole("textbox", { name: "Text" })).toBeFocused();
  await page.keyboard.type("## 메모");
  await expect(text.getByRole("heading", { level: 2, name: "메모" })).toBeVisible();
  // No paper under a text: no background, no border, no shadow.
  expect(await text.evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).borderTopWidth, getComputedStyle(el).boxShadow])).toEqual(["rgba(0, 0, 0, 0)", "0px", "none"]);

  await expect.poll(async () => (await byKind("ink"))?.body, { timeout: 5000 }).toBe("# 카드 제목");
  const before = (await card.boundingBox())!;
  const savedBefore = (await byKind("ink"))!;
  const sectionBefore = (await byKind("section"))!;
  await dragBy(page, { x: frame.x + frame.width - 40, y: frame.y + 20 }, 140, 70);
  const moved = (await section.boundingBox())!;
  const [dx, dy] = [moved.x - frame.x, moved.y - frame.y];
  expect(dx).toBeGreaterThan(100);
  expect(dy).toBeGreaterThan(50);
  const after = (await card.boundingBox())!;
  expect([after.x - before.x, after.y - before.y]).toEqual([dx, dy]);
  await expect
    .poll(async () => {
      const [s, c] = [(await byKind("section"))!, (await byKind("ink"))!];
      return [c.x - savedBefore.x, c.y - savedBefore.y, s.x - sectionBefore.x, s.y - sectionBefore.y];
    }, { timeout: 5000 })
    .toEqual([Math.round(dx), Math.round(dy), Math.round(dx), Math.round(dy)]);

  // The card's right edge widens it; the section's corner grows its frame.
  await card.hover();
  const edge = (await card.locator(".st-rz").boundingBox())!;
  // Above the middle, where the line handle sits.
  await dragBy(page, { x: edge.x + edge.width / 2, y: edge.y + 10 }, 90, 0);
  const corner = (await section.locator(".st-secrz").boundingBox())!;
  await dragBy(page, { x: corner.x + corner.width / 2, y: corner.y + corner.height / 2 }, 100, 60);
  await expect.poll(async () => (await byKind("section"))?.height ?? 0, { timeout: 5000 }).toBeGreaterThan(400);
  const grown = await file();
  const [sec0, ink0] = grown.cards;
  expect(ink0.width).toBeGreaterThan(350);
  expect(sec0.width).toBeGreaterThan(640);
  expect((await byKind("ink"))!.height).toBeUndefined();

  // Opened beside, the card is a page: typed there, it shows in the card at once.
  await card.hover();
  await card.getByRole("button", { name: "Open" }).click();
  const panel = page.getByRole("complementary", { name: "Opened card" });
  await expect(panel.getByRole("heading", { level: 2, name: "카드 제목" })).toBeVisible();
  const pageEditor = panel.getByRole("textbox", { name: "Card" });
  await expect(pageEditor).toBeFocused();
  expect(await pageEditor.locator("h1").evaluate((el) => getComputedStyle(el).fontSize)).toBe("30px");
  // The caret waits on the empty line TipTap keeps under the last block.
  await page.keyboard.type("## 소제목");
  await page.keyboard.press("Enter");
  await page.keyboard.type("- 하나");
  await page.keyboard.press("Enter");
  await page.keyboard.type("둘");
  await expect(pageEditor.getByRole("heading", { level: 2, name: "소제목" })).toBeVisible();
  await expect(card.getByRole("heading", { level: 2, name: "소제목" })).toBeVisible();
  await expect(card.getByRole("listitem")).toHaveText(["하나", "둘"]);
  // The ask bar stays over the sheet, clear of the panel.
  const ask = (await page.getByPlaceholder("Ask about this volume…").boundingBox())!;
  expect(ask.x + ask.width).toBeLessThanOrEqual((await panel.boundingBox())!.x);
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect.poll(async () => (await byKind("ink"))?.body, { timeout: 5000 }).toBe("# 카드 제목\n\n## 소제목\n\n- 하나\n- 둘");

  await page.reload();
  await expect(page.getByRole("tab", { name: "캔버스 v0.1", selected: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Section title" })).toHaveValue("읽은 것");
  await expect(page.getByTestId("ink-card").getByRole("heading", { level: 2, name: "소제목" })).toBeVisible();
  await expect(page.getByTestId("text-node").getByRole("heading", { level: 2, name: "메모" })).toBeVisible();
  const saved = await file();
  expect(saved.cards.map((c) => [c.kind, c.body])).toEqual([["section", "읽은 것"], ["ink", "# 카드 제목\n\n## 소제목\n\n- 하나\n- 둘"], ["text", "## 메모"]]);
  const [sec, ink] = saved.cards;
  expect([sec.width, sec.height, ink.width]).toEqual([sec0.width, sec0.height, ink0.width]);
  // The canvas shows the saved sizes: the frame and the card come back as wide (and tall) as they were left.
  const zoom = await page.locator(".react-flow__viewport").evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).a);
  const shown = (await page.getByTestId("section").boundingBox())!;
  expect([Math.round(shown.width / zoom), Math.round(shown.height / zoom)]).toEqual([sec.width, sec.height]);
  expect(Math.round((await page.getByTestId("ink-card").boundingBox())!.width / zoom)).toBe(ink.width);
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
  const ago = (n: number) => today(new Date(Date.now() - n * 86_400_000));
  const books: [number, string][] = [[0, "하루 정리"], [1, ""], [2, "라우터 다시 보기"], [4, "Weekly review"], [5, "세션은 몇 개까지"], [8, "react-flow 고르기"], [11, "읽기 노트"], [16, "첫 판 발행"], [23, "회고"], [24, "도구 정리"], [37, "A New City"]];
  for (const [n, title] of books) {
    const cards = n === 0
      ? [
          { id: "s", kind: "section", x: 0, y: 0, width: 700, height: 420, body: "Router와 Worker" },
          { id: "a", kind: "ink", x: 40, y: 64, width: 300, body: "# 오늘\n\nRouter와 Worker를 나눈 이유를 다시 적었다." },
          { id: "c", kind: "ink", x: 380, y: 64, width: 280, body: "- 책 안 캔버스 고르기\n- 로드맵 리뷰 준비" },
          { id: "b", kind: "question", x: 780, y: 120, width: 240, body: "세션은 몇 개까지 따라갈 수 있나" },
          { id: "t", kind: "text", x: 20, y: 470, width: 420, body: "## 내일\n\n리뷰 전에 따라갈 수 있는 세션 수를 다시 센다." },
        ]
      : [{ id: "a", kind: "ink", x: 40, y: 60, width: 280, body: title || "메모" }];
    const edges = n === 0 ? [{ id: "e1", source: "a", target: "b" }, { id: "e2", source: "a", target: "c" }] : [];
    await api(daemon, "PUT", `/v1/study/books/${ago(n)}`, { title, cards, edges });
  }
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
    await expect(page.getByRole("tab", { name: "Study · 어텐션", selected: true })).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SCREENS, `room-${scheme}.png`) });

    await page.getByRole("button", { name: "Read →" }).click();
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
    await page.getByRole("button", { name: "Calendar", exact: true }).click();
    await expect(page.getByRole("region", { name: "Artifacts" }).getByRole("button")).toHaveCount(3, { timeout: 3000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SCREENS, `day-${scheme}.png`) });
    await page.setViewportSize({ width: 1024, height: 800 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SCREENS, `day-narrow-${scheme}.png`) });
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.getByRole("button", { name: today().slice(0, 7).replace("-", "."), exact: true }).click();
    await expect(page.getByRole("tab", { name: "Shelf", selected: true })).toBeVisible();
    await expect(page.getByRole("list", { name: "Shelf" }).getByRole("button")).toHaveCount(11);
    await page.mouse.move(5, 890);
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SCREENS, `shelf-${scheme}.png`) });
    await page.getByRole("list", { name: "Shelf" }).getByRole("button").nth(1).hover();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SCREENS, `shelf-hover-${scheme}.png`) });

    await page.getByRole("list", { name: "Shelf" }).getByRole("button", { name: `Book · ${today().replaceAll("-", ".")}` }).click();
    await expect(page.getByTestId("ink-card")).toHaveCount(2);
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SCREENS, `book-${scheme}.png`) });
    // The canvas: a section holding two cards, a text under it, and a card opened beside.
    await expect(page.getByTestId("section")).toBeVisible();
    await expect(page.getByTestId("text-node")).toBeVisible();
    await page.screenshot({ path: path.join(SCREENS, `canvas-${scheme}.png`) });
    const first = page.getByTestId("ink-card").filter({ hasText: "오늘" });
    await first.hover();
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(SCREENS, `canvas-hover-${scheme}.png`) });
    await first.getByRole("button", { name: "Open" }).click();
    await expect(page.getByRole("complementary", { name: "Opened card" })).toBeVisible();
    await page.mouse.move(5, 890);
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SCREENS, `canvas-panel-${scheme}.png`) });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("complementary")).toHaveCount(0);

    const [y, m] = today().split("-").map(Number);
    const nextMonth = today(new Date(y, m, 1));
    await page.getByRole("button", { name: `← ${today().slice(5).replace("-", ".")}` }).click();
    await page.getByRole("button", { name: "Next month" }).click();
    await page.getByRole("button", { name: nextMonth, exact: true }).click();
    await expect(page.getByRole("button", { name: `Book · ${nextMonth.slice(5).replace("-", ".")}` })).toHaveClass(/st-blank/);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SCREENS, `day-blank-${scheme}.png`) });
  }
  expect(Object.keys(ids)).toHaveLength(5);
});

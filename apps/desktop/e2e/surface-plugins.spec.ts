/*
 * Host text surfaces: a plugin with `surfaces.text` runs a hidden background page that hears the
 * text of every chat answer on screen, adds buttons to the selection bar after Ask, and paints the
 * ranges it stores with the CSS Custom Highlight API. Core never mutates the answer's DOM, and the
 * tagger fixture is the plugin.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Frame, Locator, Page } from "@playwright/test";
import { expect, FILES_PORT, test, today, type Daemon } from "./fixtures";
import { installStreamingAgent } from "./streamingAgent";

/** The highlight the tagger's first style paints into: `rooms-<plugin>-<style>`. */
const AMBER = "rooms-tagger-important";
/** The tagger's color for it, as the engine serializes it. */
const AMBER_COLOR = "rgba(199, 154, 62, 0.28)";

async function api(daemon: Daemon, method: string, p: string, body?: unknown) {
  const r = await fetch(`${daemon.baseUrl}${p}`, {
    method,
    headers: { authorization: `Bearer ${daemon.token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

async function turnOn(page: Page, name: string) {
  const card = page.getByRole("dialog", { name: `New plugin: ${name}` });
  await expect(card).toBeVisible({ timeout: 5000 });
  await expect(card.getByRole("listitem")).toHaveText(["Can read and mark chat answers and notes"]);
  await card.getByRole("button", { name: "Turn on" }).click();
  await expect(card).toBeHidden();
}
const turnOnTagger = (page: Page) => turnOn(page, "Tagger");

/**
 * The background the `::highlight(name)` rule gives `el`'s text: transparent until the plugin's
 * style rule is live. The registry alone cannot tell, since a rule the CSP dropped leaves it full.
 */
const paintColor = (el: Locator, name: string) => el.evaluate((p, n) => getComputedStyle(p, `::highlight(${n})`).backgroundColor, name);

/** The background frame once its script is up. */
async function backgroundFrame(page: Page): Promise<Frame> {
  await expect.poll(() => page.frame({ url: /\/_plugins\/tagger\/background\.html/ }) !== null).toBe(true);
  const frame = page.frame({ url: /\/_plugins\/tagger\/background\.html/ })!;
  await expect.poll(() => frame.evaluate(() => typeof window.tagger)).toBe("object");
  return frame;
}

async function openRoom(page: Page, room: string) {
  await page.getByRole("list", { name: "Rooms" }).getByRole("button", { name: room, exact: true }).click();
  await expect(page.getByRole("tab", { name: room, exact: true, selected: true })).toBeVisible();
}

async function openDocTab(page: Page, title: string) {
  const card = page.getByTestId("artifact-card").filter({ hasText: title });
  await card.hover();
  await card.getByRole("button", { name: "Open in new tab" }).click();
  await expect(page.getByRole("tab", { name: title, selected: true })).toBeVisible();
}

async function ask(page: Page, placeholder: string, question: string) {
  const input = page.getByPlaceholder(placeholder);
  await input.fill(question);
  await input.press("Enter");
  const answer = page.locator("[data-surface] p").filter({ hasText: `answer to ${question}` });
  await expect(answer).toBeVisible({ timeout: 10_000 });
  return answer;
}

/** The text of every range painted under `name`, in document order. */
const painted = (page: Page, name = AMBER) =>
  page.evaluate((n) => {
    const h = CSS.highlights.get(n);
    return h ? Array.from(h as unknown as Iterable<Range>, (r) => r.toString().trim()) : [];
  }, name);

const bar = (page: Page) => page.getByRole("toolbar", { name: "Selection actions" });

/** Triple-click selects the paragraph, the way a user would. */
async function tag(page: Page, answer: ReturnType<Page["locator"]>) {
  await answer.click({ clickCount: 3 });
  await expect(bar(page).getByRole("button")).toHaveText(["Ask", "Tag"]);
  await bar(page).getByRole("button", { name: "Tag" }).click();
  await expect(bar(page)).toBeHidden();
}

/** Clicks the middle of the first painted range. */
async function clickPainted(page: Page) {
  const at = await page.evaluate((n) => {
    const [r] = Array.from(CSS.highlights.get(n) as unknown as Iterable<Range>);
    const rects = r.getClientRects();
    const box = rects[rects.length - 1];
    return { x: box.left + Math.min(20, box.width / 2), y: box.top + box.height / 2 };
  }, AMBER);
  await page.mouse.click(at.x, at.y);
}

async function tagFiles(daemon: Daemon): Promise<string[]> {
  const dir = path.join(daemon.home, ".rooms", "plugins", "tagger", "data");
  if (!(await fs.stat(dir).catch(() => null))) return [];
  return (await fs.readdir(dir, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).map((e) => path.relative(dir, path.join(e.parentPath, e.name))).sort();
}

test("tagging words in a room answer and a doc answer paints them in their own threads, survives a reload, and leaves the DOM alone", async ({ page, daemon }) => {
  installStreamingAgent(daemon, "Room");
  const room = await daemon.createRoom("harness");
  await daemon.write("harness/alpha.html", "<html><head><title>Alpha</title></head><body>a</body></html>");
  await daemon.installPlugin("tagger");
  await page.goto("/");
  await turnOnTagger(page);
  await backgroundFrame(page);

  await openRoom(page, "harness");
  const roomAnswer = await ask(page, "Ask about this room…", "Which doc is first?");
  const roomText = (await roomAnswer.textContent())!;
  const before = await roomAnswer.locator("xpath=ancestor::*[@data-surface]").innerHTML();
  await tag(page, roomAnswer);
  await expect.poll(() => painted(page)).toEqual([roomText]);
  expect(await paintColor(roomAnswer, AMBER), "the rule is live under the app's CSP, not only the registry").toBe(AMBER_COLOR);
  expect(await roomAnswer.locator("xpath=ancestor::*[@data-surface]").innerHTML(), "paint changes no DOM").toBe(before);
  const [turn] = (await api(daemon, "GET", `/v1/asks?scope=room:${room.id}`)) as { id: string }[];
  expect(await tagFiles(daemon)).toEqual([`answer/room/${room.id}/${turn.id}.json`]);

  await openDocTab(page, "Alpha");
  await expect.poll(() => painted(page), "the room thread left the screen with its paint").toEqual([]);
  const docAnswer = await ask(page, "Ask about this artifact…", "What is this?");
  const docText = (await docAnswer.textContent())!;
  await tag(page, docAnswer);
  await expect.poll(() => painted(page)).toEqual([docText]);
  await expect(page.getByText(roomText)).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("tab", { name: "Alpha", selected: true })).toBeVisible();
  await expect(page.getByText(docText)).toBeVisible();
  await expect.poll(() => painted(page), "the plugin repaints from its storage").toEqual([docText]);
  await page.getByRole("tab", { name: "harness", exact: true }).click();
  await expect(page.getByText(roomText)).toBeVisible();
  await expect.poll(() => painted(page)).toEqual([roomText]);
});

test("a click on a painted range shows the plugin's menu; Untag removes the paint; Open flashes the range", async ({ page, daemon }) => {
  installStreamingAgent(daemon, "Room");
  await daemon.createRoom("harness");
  await daemon.write("harness/alpha.html", "<html><head><title>Alpha</title></head><body>a</body></html>");
  await daemon.installPlugin("tagger");
  await page.goto("/");
  await turnOnTagger(page);
  await backgroundFrame(page);
  await openRoom(page, "harness");
  const answer = await ask(page, "Ask about this room…", "Which doc is first?");
  const text = (await answer.textContent())!;
  await tag(page, answer);
  await expect.poll(() => painted(page)).toEqual([text]);

  await clickPainted(page);
  await expect(bar(page).getByRole("button")).toHaveText(["Untag", "Open"]);
  await page.keyboard.press("Escape");
  await expect(bar(page)).toBeHidden();

  await clickPainted(page);
  await bar(page).getByRole("button", { name: "Open" }).click();
  await expect.poll(() => painted(page, "rooms-flash"), { timeout: 1000, intervals: [25] }).toEqual([text]);
  await expect.poll(() => painted(page, "rooms-flash"), { timeout: 3000 }).toEqual([]);

  await clickPainted(page);
  await bar(page).getByRole("button", { name: "Untag" }).click();
  await expect.poll(() => painted(page)).toEqual([]);
  await expect(bar(page)).toBeHidden();
  const [file] = await tagFiles(daemon);
  expect(JSON.parse(await daemon.read(path.join(".rooms", "plugins", "tagger", "data", file)))).toEqual({ version: 1, tags: [] });
});

test("open({ surface, rangeId }) from the background is refused unless the user just clicked the plugin's button or menu item, not a range; then it opens the thread's tab, unfolds it, and flashes the range", async ({ page, daemon }) => {
  installStreamingAgent(daemon, "Room");
  await daemon.createRoom("harness");
  await daemon.write("harness/alpha.html", "<html><head><title>Alpha</title></head><body>a</body></html>");
  await daemon.installPlugin("tagger");
  await page.goto("/");
  await turnOnTagger(page);
  const frame = await backgroundFrame(page);
  await openRoom(page, "harness");
  const answer = await ask(page, "Ask about this room…", "Which doc is first?");
  const text = (await answer.textContent())!;
  await tag(page, answer);
  await expect.poll(() => painted(page)).toEqual([text]);
  const [surface] = await frame.evaluate(() => window.tagger.surfaces());
  const [file] = await tagFiles(daemon);
  const { tags } = JSON.parse(await daemon.read(path.join(".rooms", "plugins", "tagger", "data", file))) as { tags: { id: string }[] };
  const open = () =>
    frame.evaluate(
      ({ surface, rangeId }) => window.tagger.open(surface, rangeId).then(() => "ok", (e: { code?: string }) => e.code ?? "error"),
      { surface, rangeId: tags[0].id },
    );

  await openDocTab(page, "Alpha");
  await expect.poll(() => painted(page)).toEqual([]);
  await page.waitForTimeout(2100);
  expect(await open(), "no click on the plugin in the last 2 s").toBe("permission_denied");
  await expect(page.getByRole("tab", { name: "Alpha", selected: true })).toBeVisible();

  await page.getByRole("tab", { name: "harness", exact: true }).click();
  await expect.poll(() => painted(page)).toEqual([text]);
  await clickPainted(page);
  await expect(bar(page).getByRole("button")).toHaveText(["Untag", "Open"]);
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: "Alpha", exact: true }).click();
  await expect.poll(() => painted(page)).toEqual([]);
  expect(await open(), "a click on its range alone: a plugin could paint transparent ranges over a whole answer").toBe("permission_denied");
  await expect(page.getByRole("tab", { name: "Alpha", selected: true })).toBeVisible();

  // A menu item is the other gesture: the previous test's Open item is a background open on its heels.
  await page.getByRole("tab", { name: "harness", exact: true }).click();
  await expect.poll(() => painted(page)).toEqual([text]);
  await tag(page, answer);
  await page.getByRole("tab", { name: "Alpha", exact: true }).click();
  await expect.poll(() => painted(page)).toEqual([]);
  expect(await open(), "right after the click on its button").toBe("ok");
  await expect(page.getByRole("tab", { name: "harness", exact: true, selected: true })).toBeVisible();
  await expect.poll(() => painted(page, "rooms-flash"), { timeout: 5000, intervals: [25] }).toEqual([text]);
  await expect.poll(() => painted(page)).toEqual([text]);
});

test("the background frame is sandboxed without network; hostile paint is dropped; turning the plugin off removes paint, button and frame", async ({ page, daemon }) => {
  installStreamingAgent(daemon, "Room");
  await daemon.createRoom("harness");
  await daemon.write("harness/alpha.html", "<html><head><title>Alpha</title></head><body>a</body></html>");
  await daemon.installPlugin("tagger");
  await daemon.installPlugin("stamper");
  await page.goto("/");
  await turnOn(page, "Stamper");
  await turnOnTagger(page);
  const frame = await backgroundFrame(page);
  const el = page.locator('iframe[title="Tagger"]');
  await expect(el).toHaveAttribute("sandbox", "allow-scripts");
  await expect(el.locator("xpath=ancestor::*[@data-background-frames]")).toHaveAttribute("hidden", "");
  expect(await frame.evaluate((url) => window.tagger.fetchBlocked(url), `${daemon.baseUrl}/v1/info`)).toBe(true);
  const csp = (await fetch(`http://127.0.0.1:${FILES_PORT}/_plugins/tagger/background.html`)).headers.get("content-security-policy") ?? "";
  expect(csp).toContain("connect-src 'none'");
  expect(csp).toContain("sandbox allow-scripts");

  await openRoom(page, "harness");
  const answer = await ask(page, "Ask about this room…", "Which doc is first?");
  const text = (await answer.textContent())!;
  await tag(page, answer);
  await expect.poll(() => painted(page)).toEqual([text]);

  await frame.evaluate(() => window.tagger.hostile());
  await expect.poll(() => painted(page, "rooms-tagger-agree"), "the one good range of a hostile paint is kept").toEqual([text.slice(0, 4)]);
  expect(await painted(page, "rooms-tagger-disagree"), "a range past the text is dropped").toEqual([]);
  expect(await painted(page), "a paint replaces the plugin's ranges on that surface").toEqual([]);
  expect(await page.evaluate(() => [...CSS.highlights.keys()].filter((k) => k.startsWith("rooms-tagger-")).sort()), "no highlight for a refused style").toEqual([
    "rooms-tagger-agree",
    "rooms-tagger-disagree",
    "rooms-tagger-idk",
    "rooms-tagger-important",
  ]);
  expect(await page.evaluate(() => CSS.supports("color", "var(--x, {")), "the engine's parser admits the value the app must refuse").toBe(true);
  const rules = await page.evaluate(() => document.adoptedStyleSheets.flatMap((s) => [...s.cssRules].map((r) => r.cssText)));
  expect(rules.join("\n")).not.toContain("display:none");
  expect(rules.join("\n")).not.toContain("url(");
  expect(rules.join("\n")).not.toContain("var(--x");
  expect(rules).toContain(`::highlight(${AMBER}) { background-color: ${AMBER_COLOR}; }`);
  expect(await paintColor(answer, AMBER), "the tagger's own good rule still paints").toBe(AMBER_COLOR);
  expect(await paintColor(answer, "rooms-stamper-mark"), "another plugin's rule survives the tagger's hostile values").toBe("rgb(0, 0, 255)");
  expect(await painted(page, "rooms-stamper-mark")).toEqual([text.slice(0, 3)]);
  await expect(page.locator("body")).toBeVisible();

  await api(daemon, "PATCH", "/v1/plugins/tagger", { enabled: false });
  await expect(el).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => CSS.highlights.has("rooms-tagger-agree"))).toBe(false);
  await answer.click({ clickCount: 3 });
  await expect(page.getByRole("button", { name: "Ask" })).toBeVisible();
  await expect(bar(page), "Ask alone, as with no surface plugin").toHaveCount(0);
  await page.keyboard.press("Escape");
});

/*
 * A note for the backdrop checks: short lines up to the tagged word on line 40, long lines that
 * wrap right after it, short lines from 50 on, and two trailing newlines, which a mirror gets wrong
 * first. The textarea is the oracle for where the long lines wrap, through its scrollHeight.
 */
const NOTE_LINES = Array.from({ length: 60 }, (_, i) => {
  if (i === 39) return "forty marker words here";
  if (i >= 40 && i < 49) return `Line ${i + 1}. ${"A long sentence that wraps when the window is narrow. ".repeat(6)}`;
  return `Line ${i + 1}`;
});
const NOTE = `${NOTE_LINES.join("\n")}\n\n`;
/** Visual rows from line 50 to the end: eleven short lines, then the two empty ones the trailing newlines make. */
const ROWS_FROM_LINE_50 = 11 + 2;

const noteEditor = (page: Page) => page.getByRole("textbox", { name: "Note" });

/** The textarea and its backdrop: the type both set, their widths, their scroll heights, and the textarea's box. */
const mirror = (page: Page) =>
  page.evaluate(() => {
    const ta = document.querySelector("textarea[data-note-editor]") as HTMLTextAreaElement;
    const bd = document.querySelector("[data-note-backdrop]") as HTMLElement;
    const type = (el: Element) => {
      const s = getComputedStyle(el);
      return {
        fontFamily: s.fontFamily,
        fontSize: s.fontSize,
        fontWeight: s.fontWeight,
        lineHeight: s.lineHeight,
        letterSpacing: s.letterSpacing,
        padding: s.padding,
        border: s.borderWidth,
        whiteSpace: s.whiteSpace,
        overflowWrap: s.overflowWrap,
        wordBreak: s.wordBreak,
        tabSize: s.tabSize,
        textIndent: s.textIndent,
        width: el.clientWidth,
      };
    };
    return { textarea: type(ta), backdrop: type(bd), scrollHeight: { textarea: ta.scrollHeight, backdrop: bd.scrollHeight }, box: ta.getBoundingClientRect().toJSON() as DOMRect };
  });

/** The tagger gives its first tag the first style and its second the second. */
const GREEN = "rooms-tagger-agree";

/** Where the tagger's first two tags sit, in the textarea's own content coordinates (scroll taken out), with its line height. */
const paintedAt = (page: Page) =>
  page.evaluate(({ first, second }) => {
    const ta = document.querySelector("textarea[data-note-editor]") as HTMLTextAreaElement;
    const box = ta.getBoundingClientRect();
    const lineHeight = parseFloat(getComputedStyle(ta).lineHeight);
    const of = (name: string) => Array.from((CSS.highlights.get(name) ?? []) as unknown as Iterable<Range>);
    const ranges = [...of(first), ...of(second)].map((r) => {
      const rect = r.getBoundingClientRect();
      // Chromium reports a textarea's caret as the element with an offset into its value: the painted word is where the textarea's own text is.
      const caret = typeof document.caretPositionFromPoint === "function" ? document.caretPositionFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) : null;
      // A range's rect is the glyph box, centred in its line box: the centre names the row, the top does not.
      return { text: r.toString(), centre: rect.top + rect.height / 2 - box.top + ta.scrollTop, left: rect.left - box.left, caretOffset: caret?.offsetNode === ta ? caret.offset : null };
    });
    return { ranges, lineHeight, scrollHeight: ta.scrollHeight, scrollTop: ta.scrollTop };
  }, { first: AMBER, second: GREEN });

/** The textarea's scroll offset once the backdrop has followed it (its scroll handler runs a task after the scroll). */
async function scrolled(page: Page): Promise<number> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const ta = document.querySelector("textarea[data-note-editor]") as HTMLTextAreaElement;
        return ta.scrollTop - (document.querySelector("[data-note-backdrop]") as HTMLElement).scrollTop;
      }),
    )
    .toBe(0);
  return noteEditor(page).evaluate((el: HTMLTextAreaElement) => el.scrollTop);
}

/** Scrolls the textarea so the tagged "marker" is mid-view, and waits for the backdrop to follow. */
async function showMarker(page: Page) {
  const { ranges } = await paintedAt(page);
  await noteEditor(page).evaluate((el: HTMLTextAreaElement, centre) => el.scrollTo({ top: Math.max(0, centre - el.clientHeight / 2) }), ranges[0].centre);
  await scrolled(page);
}

/** Selects `word` in the note the way a keyboard does: the caret before it, then Shift+Right over it, so the bar reads the selection on key up. */
async function selectInNote(page: Page, word: string) {
  const start = (await noteEditor(page).inputValue()).indexOf(word);
  await noteEditor(page).evaluate((el: HTMLTextAreaElement, s) => el.setSelectionRange(s, s), start);
  for (let i = 0; i < word.length; i++) await page.keyboard.press("Shift+ArrowRight");
  await expect(noteEditor(page)).toHaveJSProperty("selectionEnd", start + word.length);
}

test("a note's bar button runs from the keyboard and from a click no pointer preceded, and is seen without an animation frame", async ({ page, daemon }) => {
  const date = today();
  await daemon.installPlugin("tagger");
  await daemon.saveNote(date, "Plan.md", NOTE);
  await page.goto("/");
  await turnOnTagger(page);
  await backgroundFrame(page);
  await page.getByRole("button", { name: "Journal", exact: true }).click();
  await page.getByRole("region", { name: "Your day" }).getByRole("button", { name: "Plan" }).click();
  const ta = noteEditor(page);
  await expect(ta).toHaveValue(NOTE);
  await ta.click();
  // WebKit holds animations at their first frame while the window is occluded, as the verify app's is: a bar that fades in never shows there.
  await page.evaluate(() => {
    const held = new CSSStyleSheet();
    held.replaceSync("* { animation-play-state: paused !important; }");
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, held];
  });
  await selectInNote(page, "Line 2");
  const tag = page.getByRole("button", { name: "Tag" });
  await expect(tag).toBeVisible();
  expect(await tag.evaluate((el) => getComputedStyle(el).opacity), "seen with every animation held at its first frame").toBe("1");
  // Tab from the text onto the button, then Enter: the action runs on the selection the bar was shown for.
  // WebKit's plain Tab skips buttons unless macOS keyboard navigation is on; Option+Tab reaches them regardless.
  await page.keyboard.press(test.info().project.name === "webkit" ? "Alt+Tab" : "Tab");
  await expect(tag).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(() => painted(page)).toEqual(["Line 2"]);
  await expect(ta, "focus goes back to the text").toBeFocused();
  // An accessibility press (and WebKit's AXPress on a button): focus, then a click with no pointer events before it.
  await selectInNote(page, "Line 3");
  await expect(page.getByRole("button", { name: "Tag" })).toBeVisible();
  await page.getByRole("button", { name: "Tag" }).evaluate((el: HTMLElement) => {
    el.focus();
    el.click();
  });
  await expect.poll(() => painted(page, GREEN)).toEqual(["Line 3"]);
  await expect(ta).toBeFocused();
  expect(await daemon.read(`journal/${date}/Plan.md`), "a paint never writes the note").toBe(NOTE);
});

test("tagging words in a note paints them behind the textarea, aligned through scroll, wrapping, resize and typing, and leaves the file and the textarea as they were", async ({ page, daemon }) => {
  const date = today();
  await daemon.installPlugin("tagger");
  await daemon.saveNote(date, "Plan.md", NOTE);
  await page.goto("/");
  await turnOnTagger(page);
  await backgroundFrame(page);
  await page.getByRole("button", { name: "Journal", exact: true }).click();
  await page.getByRole("region", { name: "Your day" }).getByRole("button", { name: "Plan" }).click();
  await expect(page.getByRole("tab", { name: "Plan", selected: true })).toBeVisible();
  const ta = noteEditor(page);
  await expect(ta).toHaveValue(NOTE);
  await ta.click();

  let m = await mirror(page);
  expect(m.backdrop, "the mirror wraps as the textarea does: same type, same content width").toEqual(m.textarea);
  expect(m.scrollHeight.backdrop, "same rows, trailing newlines included").toBe(m.scrollHeight.textarea);
  expect(m.scrollHeight.textarea, "the long lines wrapped").toBeGreaterThan(62 * parseFloat(m.textarea.lineHeight) + 1);

  await selectInNote(page, "marker");
  const tagButton = page.getByRole("button", { name: "Tag" });
  await expect(tagButton).toBeVisible();
  await expect(page.getByRole("button", { name: "Ask" }), "notes have no Ask").toHaveCount(0);
  await tagButton.click();
  await expect(tagButton).toBeHidden();
  await expect.poll(() => painted(page)).toEqual(["marker"]);
  await selectInNote(page, "Line 50");
  await page.getByRole("button", { name: "Tag" }).click();
  await expect.poll(() => painted(page, GREEN)).toEqual(["Line 50"]);
  expect(await painted(page)).toEqual(["marker"]);
  expect(await daemon.read(`journal/${date}/Plan.md`), "a paint never writes the note").toBe(NOTE);
  expect(await tagFiles(daemon)).toEqual([expect.stringMatching(new RegExp(`^note/${date}/plan\\.md-[0-9a-f]{8}\\.json$`))]);

  const aligned = async (line40Row: number) => {
    const p = await paintedAt(page);
    const [marker, line50] = p.ranges;
    expect(marker.text).toBe("marker");
    const row = (centre: number) => centre / p.lineHeight - 0.5;
    expect(row(marker.centre), "line 40 of the note, scroll taken out").toBeCloseTo(line40Row, 1);
    expect(row(line50.centre), "line 50 sits where the textarea's own wrapping of the long lines puts it").toBeCloseTo(p.scrollHeight / p.lineHeight - ROWS_FROM_LINE_50, 1);
    expect(line50.left, "a word at the start of a line starts where the textarea's text does").toBeCloseTo(0, 0);
    if (marker.caretOffset !== null) {
      const start = (await ta.inputValue()).indexOf("marker");
      expect(marker.caretOffset, "the textarea's own caret under the paint is inside the word").toBeGreaterThanOrEqual(start);
      expect(marker.caretOffset).toBeLessThanOrEqual(start + 6);
    }
    return p;
  };
  await aligned(39);

  await ta.evaluate((el: HTMLTextAreaElement) => el.scrollTo({ top: 0 }));
  expect(await scrolled(page)).toBe(0);
  await aligned(39);
  await ta.evaluate((el: HTMLTextAreaElement) => el.scrollTo({ top: el.scrollHeight }));
  expect(await scrolled(page), "the note is longer than its box").toBeGreaterThan(0);
  await aligned(39);

  await page.setViewportSize({ width: 900, height: 900 });
  const wide = m.textarea.width;
  await expect.poll(async () => {
    m = await mirror(page);
    return m.textarea.width < wide && m.backdrop.width === m.textarea.width;
  }, "the textarea narrowed and the mirror's ResizeObserver followed").toBe(true);
  expect(m.backdrop, "narrower window: the mirror follows the textarea's new content width").toEqual(m.textarea);
  expect(m.scrollHeight.backdrop).toBe(m.scrollHeight.textarea);
  await aligned(39);

  // Typing a line above the tags: the paint moves with its words at once, and stays after the plugin re-anchors.
  await ta.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(0, 0));
  await page.keyboard.type("Intro");
  await page.keyboard.press("Enter");
  expect([await painted(page), await painted(page, GREEN)], "right after the keystrokes, before the plugin heard of them").toEqual([["marker"], ["Line 50"]]);
  await expect(ta).toHaveValue(`Intro\n${NOTE}`);
  await page.waitForTimeout(400);
  await expect.poll(async () => [await painted(page), await painted(page, GREEN)]).toEqual([["marker"], ["Line 50"]]);
  await aligned(40);
  await expect.poll(() => daemon.read(`journal/${date}/Plan.md`), { timeout: 5000 }).toBe(`Intro\n${NOTE}`);
  expect(await ta.getAttribute("data-note-editor")).toBe("");

  // A click on a painted word, through the textarea, reaches the plugin: its menu shows; Open flashes; Untag clears.
  await showMarker(page);
  await clickPainted(page);
  await expect(bar(page).getByRole("button")).toHaveText(["Untag", "Open"]);
  await bar(page).getByRole("button", { name: "Open" }).click();
  await expect.poll(() => painted(page, "rooms-flash"), { timeout: 1000, intervals: [25] }).toEqual(["marker"]);
  await expect(page.getByRole("tab", { name: "Plan", selected: true })).toBeVisible();
  await showMarker(page);
  await clickPainted(page);
  await bar(page).getByRole("button", { name: "Untag" }).click();
  await expect.poll(() => painted(page), "the one tag left takes the first style").toEqual(["Line 50"]);
  expect(await painted(page, GREEN)).toEqual([]);

  const boxOn = (await mirror(page)).box;
  await api(daemon, "PATCH", "/v1/plugins/tagger", { enabled: false });
  await expect(page.locator("[data-note-backdrop]")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => CSS.highlights.has("rooms-tagger-important"))).toBe(false);
  const boxOff = await ta.evaluate((el) => el.getBoundingClientRect().toJSON() as DOMRect);
  expect(boxOff, "the textarea sits where it did with the backdrop behind it").toEqual(boxOn);
  await expect(ta).toHaveValue(`Intro\n${NOTE}`);
  await selectInNote(page, "marker");
  await expect(page.getByRole("button", { name: "Tag" })).toHaveCount(0);
});

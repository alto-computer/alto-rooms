import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { surfaceKey as sdkSurfaceKey } from "@alto-rooms/plugin-sdk";
import { isPaintColor, parseSurfaceId, SurfaceHub, surfaceKey, type SurfaceId } from "./surfaceHub";

/** A stand-in for the CSS Custom Highlight API: what the hub registered under which name. */
class FakeHighlight {
  ranges: Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}
const highlights = new Map<string, FakeHighlight>();

beforeEach(() => {
  highlights.clear();
  vi.stubGlobal("Highlight", FakeHighlight);
  vi.stubGlobal("CSS", { highlights, supports: (_: string, v: string) => /^#[0-9a-f]{6}$/i.test(v) });
  document.body.innerHTML = "";
  document.adoptedStyleSheets = [];
});
afterEach(() => vi.unstubAllGlobals());

const answer = (turnId: string): SurfaceId => ({ kind: "answer", scope: { kind: "room", roomId: "r1" }, turnId });
const painted = (name: string) => (highlights.get(name)?.ranges ?? []).map((r) => r.toString());

/** Every `::highlight` rule the document adopted: highlight name to its background color, as the CSSOM serializes it. */
function rules(): Map<string, string> {
  const out = new Map<string, string>();
  for (const sheet of document.adoptedStyleSheets) {
    for (const r of sheet.cssRules) {
      const m = /^::highlight\(([^)]+)\)$/.exec((r as CSSStyleRule).selectorText);
      if (m) out.set(m[1], (r as CSSStyleRule).style.getPropertyValue("background-color"));
    }
  }
  return out;
}

/** `v` as the CSSOM serializes a color (jsdom turns `#c79a3e` into `rgb(199, 154, 62)`), to compare with `rules()`. */
function cssColor(v: string): string {
  const d = document.createElement("div");
  d.style.backgroundColor = v;
  return d.style.backgroundColor;
}

/** The styles the test plugin paints with; a paint that names none declares these. */
const STYLES = { amber: "#c79a3e", blue: "#608cc8", green: "#7a9971" };

function seat(hub: SurfaceHub, plugin = "tagger") {
  const sent: Record<string, unknown>[] = [];
  const s = hub.register(plugin, (m) => void sent.push(m));
  const say = (m: Record<string, unknown>) => s.receive({ rooms: "surface", v: 1, ...(m.type === "paint" ? { styles: STYLES } : {}), ...m });
  return { sent, say, dispose: s.dispose, types: () => sent.map((m) => m.type) };
}

function surface(hub: SurfaceHub, id: SurfaceId, html: string) {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.appendChild(root);
  hub.open(id, root);
  return root;
}

describe("SurfaceHub", () => {
  it("tells a ready frame about open surfaces, and later surfaces as they open and close", () => {
    const hub = new SurfaceHub();
    surface(hub, answer("t1"), "<p>first answer</p>");
    const tagger = seat(hub);
    expect(tagger.sent).toEqual([]);
    tagger.say({ type: "ready" });
    expect(tagger.sent).toEqual([{ rooms: "surface", v: 1, type: "surface.open", surface: answer("t1"), text: "first answer" }]);
    surface(hub, answer("t2"), "<p>second</p>");
    hub.close(surfaceKey(answer("t1")));
    expect(tagger.types()).toEqual(["surface.open", "surface.open", "surface.close"]);
    expect(tagger.sent[2]).toMatchObject({ surface: answer("t1") });
  });

  it("paints the ranges a frame sends with the styles it declares, per plugin and style, and clears them with the surface", () => {
    const hub = new SurfaceHub();
    surface(hub, answer("t1"), "<p>the <b>quick</b> brown fox</p>");
    const tagger = seat(hub);
    tagger.say({ type: "paint", surface: answer("t1"), ranges: [{ id: "a", start: 4, end: 9, style: "amber" }, { id: "b", start: 10, end: 15, style: "blue" }] });
    expect(painted("rooms-tagger-amber")).toEqual(["quick"]);
    expect(painted("rooms-tagger-blue")).toEqual(["brown"]);
    expect(rules().get("rooms-tagger-amber")).toBe(cssColor(STYLES.amber));
    expect(document.body.innerHTML, "no DOM mutation").toBe("<div><p>the <b>quick</b> brown fox</p></div>");
    hub.close(surfaceKey(answer("t1")));
    expect(painted("rooms-tagger-amber")).toEqual([]);
    expect(hub.dropped).toBe(0);
  });

  it("drops an undeclared style, a range past the end, a bad id, and a paint for a closed surface, and counts each", () => {
    const hub = new SurfaceHub();
    surface(hub, answer("t1"), "<p>0123456789</p>");
    const tagger = seat(hub);
    tagger.say({
      type: "paint",
      surface: answer("t1"),
      ranges: [
        { id: "ok", start: 0, end: 2, style: "green" },
        { id: "undeclared", start: 2, end: 4, style: "pink" },
        { id: "past", start: 8, end: 11, style: "green" },
        { id: "neg", start: -1, end: 2, style: "green" },
        { id: "float", start: 0.5, end: 2, style: "green" },
        { id: "x".repeat(65), start: 4, end: 6, style: "green" },
        { id: "ok", start: 4, end: 6, style: "green" },
      ],
    });
    expect(painted("rooms-tagger-green")).toEqual(["01"]);
    expect(hub.dropped).toBe(6);
    tagger.say({ type: "paint", surface: answer("gone"), ranges: [{ id: "a", start: 0, end: 1, style: "green" }] });
    expect(hub.dropped).toBe(7);
    tagger.say({ type: "paint", surface: answer("t1"), ranges: "no" });
    tagger.say({ type: "paint", surface: answer("t1"), ranges: Array.from({ length: 1001 }, (_, i) => ({ id: `r${i}`, start: 0, end: 1, style: "green" })) });
    expect(hub.dropped).toBe(9);
    expect(painted("rooms-tagger-green"), "a refused paint keeps the last good one").toEqual(["01"]);
  });

  it("refuses a whole paint whose styles carry a bad name or a color the browser rejects, so neither reaches the stylesheet", () => {
    const hub = new SurfaceHub();
    surface(hub, answer("t1"), "<p>0123456789</p>");
    const tagger = seat(hub);
    tagger.say({ type: "paint", surface: answer("t1"), ranges: [{ id: "ok", start: 0, end: 2, style: "green" }] });
    const before = hub.dropped;
    for (const styles of [
      { "x;}body{display:none": "#000000" },
      { "Green": "#000000" },
      { "1st": "#000000" },
      { ["x".repeat(33)]: "#000000" },
      { css: "url(x)" },
      { css: "red;}body{display:none" },
      { css: "#" + "f".repeat(70) },
      { css: 7 },
      "green",
      [],
    ]) {
      tagger.say({ type: "paint", surface: answer("t1"), styles, ranges: [{ id: "a", start: 0, end: 1, style: "green" }] });
    }
    expect(hub.dropped).toBe(before + 10);
    expect(painted("rooms-tagger-green"), "a refused paint keeps the last good one").toEqual(["01"]);
    expect([...rules().keys()].sort(), "the declared rules are the only ones in any sheet").toEqual(["rooms-tagger-amber", "rooms-tagger-blue", "rooms-tagger-green"]);
    tagger.say({ type: "paint", surface: answer("t1"), styles: Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`s${i}`, "#111111"])), ranges: [] });
    expect(hub.dropped, "17 styles in all is one too many").toBe(before + 11);
    tagger.say({ type: "paint", surface: answer("t1"), styles: Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`s${i}`, "#111111"])), ranges: [] });
    expect(hub.dropped, "16 is the cap").toBe(before + 11);
  });

  it("paints with any color the browser's CSS.supports accepts, the rule a plugin's action colors already follow", () => {
    const hub = new SurfaceHub();
    surface(hub, answer("t1"), "<p>0123456789</p>");
    const tagger = seat(hub);
    tagger.say({ type: "paint", surface: answer("t1"), styles: { mustard: "rgba(199,154,62,0.28)" }, ranges: [{ id: "a", start: 0, end: 2, style: "mustard" }] });
    expect(hub.dropped, "this test's CSS.supports stub takes hex only, as the hub asked it").toBe(1);
    vi.stubGlobal("CSS", { highlights, supports: (_: string, v: string) => v.startsWith("rgba(") });
    tagger.say({ type: "paint", surface: answer("t1"), styles: { mustard: "rgba(199,154,62,0.28)" }, ranges: [{ id: "a", start: 0, end: 2, style: "mustard" }] });
    expect(hub.dropped).toBe(1);
    expect(painted("rooms-tagger-mustard")).toEqual(["01"]);
    expect(rules().get("rooms-tagger-mustard")).toBe(cssColor("rgba(199,154,62,0.28)"));
    tagger.say({ type: "paint", surface: answer("t1"), styles: { mustard: "rgba(1,2,3,0.5)" }, ranges: [{ id: "a", start: 2, end: 4, style: "mustard" }] });
    expect(rules().get("rooms-tagger-mustard"), "a declared name replaces its color").toBe(cssColor("rgba(1,2,3,0.5)"));
    expect(painted("rooms-tagger-mustard")).toEqual(["23"]);
  });

  it("refuses a color the browser's parser admits but that could substitute or carry a brace into a rule, and keeps every plugin's rules in a sheet of its own", () => {
    // Chromium and WebKit answer true to CSS.supports("color", v) for every value below: substitution is checked later.
    vi.stubGlobal("CSS", { highlights, supports: () => true });
    const hub = new SurfaceHub();
    surface(hub, answer("t1"), "<p>0123456789</p>");
    const stamper = seat(hub, "stamper");
    const tagger = seat(hub);
    stamper.say({ type: "paint", surface: answer("t1"), styles: { mark: "#0000ff" }, ranges: [{ id: "s", start: 0, end: 3, style: "mark" }] });
    expect(document.adoptedStyleSheets, "one sheet per plugin").toHaveLength(2);
    const before = hub.dropped;
    const hostile = ["var(--x, {", "var(--x, (", "var(--thread-soft)", "env(--x, {", "v\\61 r(--x)", "attr(data-x)", "if(style(--x): red; else: blue)", "red/*", "rgb(1,2,3", "rgb(1,2,3))", "red;}", "red }", "'red'", "red !important"];
    for (const css of hostile) tagger.say({ type: "paint", surface: answer("t1"), styles: { css }, ranges: [{ id: "a", start: 0, end: 1, style: "css" }] });
    expect(hub.dropped).toBe(before + hostile.length);
    expect([...rules()], "the other plugin's rule is intact and nothing hostile was written").toEqual([["rooms-stamper-mark", cssColor("#0000ff")]]);
    expect(painted("rooms-stamper-mark")).toEqual(["012"]);
    const sheetOf = (i: number) => [...document.adoptedStyleSheets[i].cssRules].map((r) => (r as CSSStyleRule).selectorText);
    expect(sheetOf(0)).toEqual(["::highlight(rooms-stamper-mark)"]);
    expect(sheetOf(1), "the tagger's sheet, empty").toEqual([]);
    tagger.say({ type: "paint", surface: answer("t1"), styles: { ok: "rgb(1 2 3 / 50%)" }, ranges: [{ id: "a", start: 0, end: 1, style: "ok" }] });
    expect(sheetOf(1)).toEqual(["::highlight(rooms-tagger-ok)"]);
    expect(sheetOf(0), "a paint touches only its plugin's sheet").toEqual(["::highlight(rooms-stamper-mark)"]);
  });

  it("takes hex, names and the color functions as paint colors, within 64 characters", () => {
    vi.stubGlobal("CSS", { highlights, supports: () => true });
    for (const ok of ["#c79a3e", "#FFF", "transparent", "CurrentColor", "rgba(199,154,62,0.28)", "rgb(1 2 3 / 50%)", "hsl(120deg 50% 50%)", "oklch(70% 0.1 200)", "color(display-p3 1 0 0)", "color-mix(in srgb, red 50%, blue)", "light-dark(#fff, #000)"]) {
      expect(isPaintColor(ok), ok).toBe(true);
    }
    expect(isPaintColor("#" + "f".repeat(64))).toBe(false);
    expect(isPaintColor("url(x)")).toBe(false);
    vi.stubGlobal("CSS", { highlights, supports: () => false });
    expect(isPaintColor("#c79a3e"), "the browser still has the last word").toBe(false);
  });

  it("lists plugin actions in id order and posts a click with the selection's offsets and text", () => {
    const hub = new SurfaceHub();
    const root = surface(hub, answer("t1"), "<p>the <b>quick</b> brown fox</p>");
    const z = seat(hub, "zed");
    const a = seat(hub, "abc");
    z.say({ type: "actions", items: [{ id: "tag", title: "Tag", color: "#ffd400" }] });
    a.say({ type: "actions", items: [{ id: "note", title: "Note" }] });
    expect(hub.getSnapshot().actions).toEqual([
      { plugin: "abc", id: "note", title: "Note" },
      { plugin: "zed", id: "tag", title: "Tag", color: "#ffd400" },
    ]);
    const range = document.createRange();
    range.setStart(root.querySelector("b")!.firstChild!, 0);
    range.setEnd(root.querySelector("p")!.lastChild!, 6);
    const span = hub.locate(range)!;
    expect(span).toEqual({ key: surfaceKey(answer("t1")), start: 4, end: 15, text: "quick brown" });
    hub.runAction("zed", "tag", span);
    expect(z.sent.at(-1)).toEqual({ rooms: "surface", v: 1, type: "selection.action", surface: answer("t1"), actionId: "tag", start: 4, end: 15, text: "quick brown" });
    hub.runAction("zed", "note", span);
    hub.runAction("abc", "tag", span);
    expect(z.types().filter((t) => t === "selection.action")).toHaveLength(1);
    expect(a.types()).not.toContain("selection.action");
    const outside = document.createRange();
    outside.selectNodeContents(document.body);
    expect(hub.locate(outside), "a range around the one surface is all of it").toEqual({ key: surfaceKey(answer("t1")), start: 0, end: 19, text: "the quick brown fox" });
    surface(hub, answer("t2"), "<p>another</p>");
    outside.selectNodeContents(document.body);
    expect(hub.locate(outside), "a range around two surfaces is nowhere").toBeNull();
  });

  it("routes a click on a painted range to its plugin, shows the menu it answers with, and runs the pick", () => {
    const hub = new SurfaceHub();
    const root = surface(hub, answer("t1"), "<p>the quick brown fox</p>");
    const tagger = seat(hub);
    tagger.say({ type: "paint", surface: answer("t1"), ranges: [{ id: "q", start: 4, end: 9, style: "amber" }] });
    const textNode = root.querySelector("p")!.firstChild!;
    const caret = vi.fn((x: number) => ({ offsetNode: textNode, offset: x }));
    (document as unknown as { caretPositionFromPoint: unknown }).caretPositionFromPoint = caret;
    expect(hub.click(surfaceKey(answer("t1")), 2, 0), "a click on plain text is not a range click").toBe(false);
    expect(hub.click(surfaceKey(answer("t1")), 6, 0)).toBe(true);
    expect(tagger.sent.at(-1)).toEqual({ rooms: "surface", v: 1, type: "range.click", surface: answer("t1"), rangeId: "q" });
    tagger.say({ type: "menu", surface: answer("t1"), rangeId: "nope", items: [{ id: "untag", title: "Untag" }] });
    expect(hub.getSnapshot().menu, "a menu for a range the plugin never painted").toBeNull();
    tagger.say({ type: "menu", surface: answer("t1"), rangeId: "q", items: [{ id: "untag", title: "Untag" }] });
    const menu = hub.getSnapshot().menu!;
    expect(menu).toMatchObject({ plugin: "tagger", rangeId: "q", items: [{ id: "untag", title: "Untag" }] });
    expect(menu.range.toString()).toBe("quick");
    hub.runMenu("untag");
    expect(hub.getSnapshot().menu).toBeNull();
    expect(tagger.sent.at(-1)).toEqual({ rooms: "surface", v: 1, type: "range.action", surface: answer("t1"), rangeId: "q", actionId: "untag" });
    delete (document as unknown as { caretPositionFromPoint?: unknown }).caretPositionFromPoint;
  });

  it("remembers when the user last clicked a plugin's button or menu item, and not a range click or a click it refused", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const hub = new SurfaceHub();
    const root = surface(hub, answer("t1"), "<p>the quick brown fox</p>");
    const tagger = seat(hub);
    const key = surfaceKey(answer("t1"));
    expect(hub.lastGesture("tagger")).toBeNull();
    expect(hub.lastGesture("nobody")).toBeNull();
    tagger.say({ type: "actions", items: [{ id: "tag", title: "Tag" }] });
    hub.runAction("tagger", "nope", { key, start: 0, end: 3, text: "the" });
    expect(hub.lastGesture("tagger"), "a button the plugin never declared").toBeNull();
    hub.runAction("tagger", "tag", { key, start: 0, end: 3, text: "the" });
    expect(hub.lastGesture("tagger")).toBe(1_000);
    vi.setSystemTime(2_000);
    tagger.say({ type: "paint", surface: answer("t1"), ranges: [{ id: "q", start: 4, end: 9, style: "amber" }] });
    const textNode = root.querySelector("p")!.firstChild!;
    (document as unknown as { caretPositionFromPoint: unknown }).caretPositionFromPoint = (x: number) => ({ offsetNode: textNode, offset: x });
    hub.click(key, 1, 0);
    expect(hub.lastGesture("tagger"), "a click beside any range").toBe(1_000);
    expect(hub.click(key, 6, 0)).toBe(true);
    expect(tagger.sent.at(-1)).toMatchObject({ type: "range.click", rangeId: "q" });
    expect(hub.lastGesture("tagger"), "a range click is delivered but grants nothing: a plugin could paint transparent ranges over the whole answer").toBe(1_000);
    vi.setSystemTime(3_000);
    tagger.say({ type: "menu", surface: answer("t1"), rangeId: "q", items: [{ id: "untag", title: "Untag" }] });
    hub.runMenu("other");
    expect(hub.lastGesture("tagger"), "an item the menu never had").toBe(1_000);
    tagger.say({ type: "menu", surface: answer("t1"), rangeId: "q", items: [{ id: "untag", title: "Untag" }] });
    hub.runMenu("untag");
    expect(hub.lastGesture("tagger")).toBe(3_000);
    delete (document as unknown as { caretPositionFromPoint?: unknown }).caretPositionFromPoint;
    vi.useRealTimers();
  });

  it("forgets a plugin's paint, buttons and menu when its frame goes, and ignores other envelopes", () => {
    const hub = new SurfaceHub();
    surface(hub, answer("t1"), "<p>the quick brown fox</p>");
    const tagger = seat(hub);
    tagger.say({ type: "actions", items: [{ id: "tag", title: "Tag" }] });
    tagger.say({ type: "paint", surface: answer("t1"), ranges: [{ id: "q", start: 4, end: 9, style: "amber" }] });
    expect(painted("rooms-tagger-amber")).toEqual(["quick"]);
    tagger.dispose();
    expect(highlights.has("rooms-tagger-amber")).toBe(false);
    expect(hub.getSnapshot().actions).toEqual([]);
    expect(rules().has("rooms-tagger-amber")).toBe(false);
    expect(document.adoptedStyleSheets, "its sheet went with it").toHaveLength(0);
    const again = seat(hub);
    again.say({ type: "paint", surface: answer("t1"), ranges: [{ id: "q", start: 4, end: 9, style: "amber" }] });
    expect(painted("rooms-tagger-amber")).toEqual(["quick"]);
    const before = hub.dropped;
    again.say({ rooms: 1, type: "paint" });
    hub.register("other", () => {}).receive({ rooms: "content", v: 1, type: "actions", items: [] });
    expect(hub.dropped, "messages of other channels are not this hub's to count").toBe(before);
    again.say({ type: "paint" });
    expect(hub.dropped).toBe(before + 1);
  });

  it("flashes a revealed range once a paint carries it, now when it is painted, and forgets one nobody paints", () => {
    vi.useFakeTimers();
    const hub = new SurfaceHub();
    const tagger = seat(hub);
    hub.reveal(answer("t1"), "q");
    expect(hub.getSnapshot().reveal).toEqual({ id: answer("t1"), rangeId: "q" });
    const root = surface(hub, answer("t1"), "<p>the quick brown fox</p><p>and a second paragraph</p>");
    const scrolled: Element[] = [];
    const scrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    vi.advanceTimersByTime(500);
    expect(hub.getSnapshot().reveal, "the surface is open but the plugin has not painted yet").not.toBeNull();
    expect(highlights.has("rooms-flash")).toBe(false);
    tagger.say({ type: "paint", surface: answer("t1"), ranges: [{ id: "other", start: 0, end: 3, style: "amber" }] });
    expect(hub.getSnapshot().reveal, "a paint without the range is not it").not.toBeNull();
    tagger.say({ type: "paint", surface: answer("t1"), ranges: [{ id: "q", start: 25, end: 31, style: "amber" }] });
    expect(hub.getSnapshot().reveal).toBeNull();
    expect(painted("rooms-flash")).toEqual(["second"]);
    expect(scrolled, "the paragraph that holds the range comes into view, not the answer's top").toEqual([root.querySelectorAll("p")[1]]);
    vi.advanceTimersByTime(1300);
    expect(highlights.has("rooms-flash")).toBe(false);
    hub.reveal(answer("t1"), "q");
    expect(hub.getSnapshot().reveal, "already painted: flashed at once").toBeNull();
    expect(painted("rooms-flash")).toEqual(["second"]);
    expect(scrolled).toHaveLength(2);
    hub.reveal(answer("t1"), "never");
    vi.advanceTimersByTime(10_001);
    expect(hub.getSnapshot().reveal).toBeNull();
    Element.prototype.scrollIntoView = scrollIntoView;
    vi.useRealTimers();
  });

  it("re-reads a surface that opens again with new text and asks plugins to paint it afresh", () => {
    const hub = new SurfaceHub();
    const root = surface(hub, answer("t1"), "<p>the quick brown fox</p>");
    const tagger = seat(hub);
    tagger.say({ type: "paint", surface: answer("t1"), ranges: [{ id: "q", start: 4, end: 9, style: "amber" }] });
    root.innerHTML = "<p>a longer answer, the quick brown fox</p>";
    hub.open(answer("t1"), root);
    expect(painted("rooms-tagger-amber"), "old offsets are not re-applied to new text").toEqual([]);
    expect(tagger.sent.at(-1)).toMatchObject({ type: "surface.open", text: "a longer answer, the quick brown fox" });
  });

  it("re-anchors the paint to new nodes that hold the same text, and tells no plugin", () => {
    const hub = new SurfaceHub();
    const root = surface(hub, answer("t1"), "<p>the quick brown fox</p>");
    const tagger = seat(hub);
    tagger.say({ type: "paint", surface: answer("t1"), ranges: [{ id: "q", start: 4, end: 9, style: "amber" }] });
    const posted = tagger.sent.length;
    root.innerHTML = "<p>the <em>quick</em> brown fox</p>";
    expect(painted("rooms-tagger-amber"), "the old range died with its node").toEqual([""]);
    hub.open(answer("t1"), root);
    expect(painted("rooms-tagger-amber")).toEqual(["quick"]);
    expect(tagger.sent.length, "same text: nothing to tell the plugin").toBe(posted);
  });

  it("closes a menu over a surface whose nodes were replaced, with the same text or new text", () => {
    const hub = new SurfaceHub();
    const root = surface(hub, answer("t1"), "<p>the quick brown fox</p>");
    const tagger = seat(hub);
    const showMenu = () => {
      tagger.say({ type: "paint", surface: answer("t1"), ranges: [{ id: "q", start: 4, end: 9, style: "amber" }] });
      tagger.say({ type: "menu", surface: answer("t1"), rangeId: "q", items: [{ id: "untag", title: "Untag" }] });
      expect(hub.getSnapshot().menu).not.toBeNull();
    };
    showMenu();
    root.innerHTML = "<p>the quick brown fox</p>";
    hub.open(answer("t1"), root);
    expect(hub.getSnapshot().menu, "same text, new nodes").toBeNull();
    showMenu();
    root.innerHTML = "<p>the quick brown fox, edited</p>";
    hub.open(answer("t1"), root);
    expect(hub.getSnapshot().menu, "new text").toBeNull();
    const other = surface(hub, answer("t2"), "<p>other</p>");
    showMenu();
    hub.open(answer("t2"), other);
    expect(hub.getSnapshot().menu, "another surface's re-open leaves it").not.toBeNull();
  });
});

describe("surfaceKey", () => {
  it("is the name the SDK gives the same surface", () => {
    for (const id of [
      answer("t1"),
      { kind: "answer", scope: { kind: "doc", fileKey: "0123456789abcdef" }, turnId: "t1" } as SurfaceId,
      { kind: "answer", scope: { kind: "day", date: "2026-10-10" }, turnId: "t1" } as SurfaceId,
      { kind: "answer", scope: { kind: "conversation", agent: "claude-code", session: "abc-123" }, turnId: "t1" } as SurfaceId,
    ]) {
      expect(surfaceKey(id)).toBe(sdkSurfaceKey(id));
    }
  });
});

describe("parseSurfaceId", () => {
  it("accepts an answer in a doc, room, day or conversation thread and nothing else", () => {
    expect(parseSurfaceId({ kind: "answer", scope: { kind: "doc", fileKey: "0123456789abcdef" }, turnId: "t_1-2" })).toEqual({ kind: "answer", scope: { kind: "doc", fileKey: "0123456789abcdef" }, turnId: "t_1-2" });
    expect(parseSurfaceId({ kind: "answer", scope: { kind: "day", date: "2026-10-10" }, turnId: "t1" })!.scope).toEqual({ kind: "day", date: "2026-10-10" });
    expect(parseSurfaceId({ kind: "answer", scope: { kind: "conversation", agent: "codex", session: "s_1-2" }, turnId: "t1" })!.scope).toEqual({ kind: "conversation", agent: "codex", session: "s_1-2" });
    for (const bad of [
      { kind: "answer", scope: { kind: "conversation", agent: "cursor", session: "s1" }, turnId: "t1" },
      { kind: "answer", scope: { kind: "conversation", agent: "codex", session: "s 1" }, turnId: "t1" },
      { kind: "answer", scope: { kind: "conversation", agent: "codex", session: "x".repeat(129) }, turnId: "t1" },
      null,
      "answer:room:r1/t1",
      { kind: "note", scope: { kind: "room", roomId: "r1" }, turnId: "t1" },
      { kind: "answer", scope: { kind: "room", roomId: "" }, turnId: "t1" },
      { kind: "answer", scope: { kind: "day", date: "today" }, turnId: "t1" },
      { kind: "answer", scope: { kind: "room", roomId: "r1" }, turnId: "t 1" },
      { kind: "answer", scope: { kind: "room", roomId: "r1" }, turnId: "x".repeat(65) },
      { kind: "answer", scope: { kind: "room", roomId: "r1", extra: 1 }, turnId: "t1", more: true },
    ]) {
      const parsed = parseSurfaceId(bad);
      if (parsed) expect(parsed, "extra fields are not kept").toEqual({ kind: "answer", scope: { kind: "room", roomId: "r1" }, turnId: "t1" });
      else expect(parsed).toBeNull();
    }
  });
});

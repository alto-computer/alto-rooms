import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSurfaceId, SurfaceHub, surfaceKey, type SurfaceId } from "./surfaceHub";

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
  document.head.innerHTML = "";
});
afterEach(() => vi.unstubAllGlobals());

const answer = (turnId: string): SurfaceId => ({ kind: "answer", scope: { kind: "room", roomId: "r1" }, turnId });
const painted = (name: string) => (highlights.get(name)?.ranges ?? []).map((r) => r.toString());

function seat(hub: SurfaceHub, plugin = "tagger") {
  const sent: Record<string, unknown>[] = [];
  const s = hub.register(plugin, (m) => void sent.push(m));
  const say = (m: Record<string, unknown>) => s.receive({ rooms: "surface", v: 1, ...m });
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

  it("paints the ranges a frame sends with the core palette, per plugin and color, and clears them with the surface", () => {
    const hub = new SurfaceHub();
    surface(hub, answer("t1"), "<p>the <b>quick</b> brown fox</p>");
    const tagger = seat(hub);
    tagger.say({ type: "paint", surface: answer("t1"), ranges: [{ id: "a", start: 4, end: 9, color: "amber" }, { id: "b", start: 10, end: 15, color: "blue" }] });
    expect(painted("rooms-tagger-amber")).toEqual(["quick"]);
    expect(painted("rooms-tagger-blue")).toEqual(["brown"]);
    expect(document.querySelector("style[data-surface-highlights]")!.textContent).toContain("::highlight(rooms-tagger-amber) { background-color: rgba(199, 154, 62, 0.28); }");
    expect(document.body.innerHTML, "no DOM mutation").toBe("<div><p>the <b>quick</b> brown fox</p></div>");
    hub.close(surfaceKey(answer("t1")));
    expect(painted("rooms-tagger-amber")).toEqual([]);
    expect(hub.dropped).toBe(0);
  });

  it("drops a bad color, a range past the end, a bad id, and a paint for a closed surface, and counts each", () => {
    const hub = new SurfaceHub();
    surface(hub, answer("t1"), "<p>0123456789</p>");
    const tagger = seat(hub);
    tagger.say({
      type: "paint",
      surface: answer("t1"),
      ranges: [
        { id: "ok", start: 0, end: 2, color: "green" },
        { id: "css", start: 2, end: 4, color: "url(x)" },
        { id: "style", start: 2, end: 4, color: "x;}body{display:none" },
        { id: "past", start: 8, end: 11, color: "green" },
        { id: "neg", start: -1, end: 2, color: "green" },
        { id: "float", start: 0.5, end: 2, color: "green" },
        { id: "x".repeat(65), start: 4, end: 6, color: "green" },
        { id: "ok", start: 4, end: 6, color: "green" },
      ],
    });
    expect(painted("rooms-tagger-green")).toEqual(["01"]);
    expect(hub.dropped).toBe(7);
    tagger.say({ type: "paint", surface: answer("gone"), ranges: [{ id: "a", start: 0, end: 1, color: "green" }] });
    expect(hub.dropped).toBe(8);
    tagger.say({ type: "paint", surface: answer("t1"), ranges: "no" });
    tagger.say({ type: "paint", surface: answer("t1"), ranges: Array.from({ length: 1001 }, (_, i) => ({ id: `r${i}`, start: 0, end: 1, color: "green" })) });
    expect(hub.dropped).toBe(10);
    expect(painted("rooms-tagger-green"), "a refused paint keeps the last good one").toEqual(["01"]);
    expect(document.querySelector("style[data-surface-highlights]")!.textContent).not.toContain("display:none");
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
    expect(span).toEqual({ key: surfaceKey(answer("t1")), start: 4, end: 15 });
    hub.runAction("zed", "tag", span);
    expect(z.sent.at(-1)).toEqual({ rooms: "surface", v: 1, type: "selection.action", surface: answer("t1"), actionId: "tag", start: 4, end: 15, text: "quick brown" });
    hub.runAction("zed", "note", span);
    hub.runAction("abc", "tag", span);
    expect(z.types().filter((t) => t === "selection.action")).toHaveLength(1);
    expect(a.types()).not.toContain("selection.action");
    const outside = document.createRange();
    outside.selectNodeContents(document.body);
    expect(hub.locate(outside), "a range that leaves the surface is nowhere").toBeNull();
  });

  it("routes a click on a painted range to its plugin, shows the menu it answers with, and runs the pick", () => {
    const hub = new SurfaceHub();
    const root = surface(hub, answer("t1"), "<p>the quick brown fox</p>");
    const tagger = seat(hub);
    tagger.say({ type: "paint", surface: answer("t1"), ranges: [{ id: "q", start: 4, end: 9, color: "amber" }] });
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

  it("forgets a plugin's paint, buttons and menu when its frame goes, and ignores other envelopes", () => {
    const hub = new SurfaceHub();
    surface(hub, answer("t1"), "<p>the quick brown fox</p>");
    const tagger = seat(hub);
    tagger.say({ type: "actions", items: [{ id: "tag", title: "Tag" }] });
    tagger.say({ type: "paint", surface: answer("t1"), ranges: [{ id: "q", start: 4, end: 9, color: "amber" }] });
    expect(painted("rooms-tagger-amber")).toEqual(["quick"]);
    tagger.dispose();
    expect(highlights.has("rooms-tagger-amber")).toBe(false);
    expect(hub.getSnapshot().actions).toEqual([]);
    expect(document.querySelector("style[data-surface-highlights]")!.textContent).not.toContain("tagger");
    const again = seat(hub);
    again.say({ type: "paint", surface: answer("t1"), ranges: [{ id: "q", start: 4, end: 9, color: "amber" }] });
    expect(painted("rooms-tagger-amber")).toEqual(["quick"]);
    const before = hub.dropped;
    again.say({ rooms: 1, type: "paint" });
    hub.register("other", () => {}).receive({ rooms: "content", v: 1, type: "actions", items: [] });
    expect(hub.dropped, "messages of other channels are not this hub's to count").toBe(before);
    again.say({ type: "paint" });
    expect(hub.dropped).toBe(before + 1);
  });

  it("flashes a revealed range once its surface opens, and now when it is open", () => {
    vi.useFakeTimers();
    const hub = new SurfaceHub();
    const tagger = seat(hub);
    hub.reveal(answer("t1"), "q");
    expect(hub.getSnapshot().reveal).toEqual({ id: answer("t1"), rangeId: "q" });
    const root = surface(hub, answer("t1"), "<p>the quick brown fox</p>");
    root.scrollIntoView = vi.fn();
    tagger.say({ type: "paint", surface: answer("t1"), ranges: [{ id: "q", start: 4, end: 9, color: "amber" }] });
    vi.runOnlyPendingTimers();
    expect(hub.getSnapshot().reveal).toBeNull();
    expect(painted("rooms-flash")).toEqual(["quick"]);
    expect(root.scrollIntoView).toHaveBeenCalledWith({ block: "center" });
    vi.advanceTimersByTime(1300);
    expect(highlights.has("rooms-flash")).toBe(false);
    hub.reveal(answer("t1"), "q");
    expect(hub.getSnapshot().reveal).toBeNull();
    expect(painted("rooms-flash")).toEqual(["quick"]);
    vi.useRealTimers();
  });

  it("re-reads a surface that opens again with new text and asks plugins to paint it afresh", () => {
    const hub = new SurfaceHub();
    const root = surface(hub, answer("t1"), "<p>the quick brown fox</p>");
    const tagger = seat(hub);
    tagger.say({ type: "paint", surface: answer("t1"), ranges: [{ id: "q", start: 4, end: 9, color: "amber" }] });
    root.innerHTML = "<p>a longer answer, the quick brown fox</p>";
    hub.open(answer("t1"), root);
    expect(painted("rooms-tagger-amber"), "old offsets are not re-applied to new text").toEqual([]);
    expect(tagger.sent.at(-1)).toMatchObject({ type: "surface.open", text: "a longer answer, the quick brown fox" });
  });
});

describe("parseSurfaceId", () => {
  it("accepts an answer in a doc, room or day thread and nothing else", () => {
    expect(parseSurfaceId({ kind: "answer", scope: { kind: "doc", fileKey: "0123456789abcdef" }, turnId: "t_1-2" })).toEqual({ kind: "answer", scope: { kind: "doc", fileKey: "0123456789abcdef" }, turnId: "t_1-2" });
    expect(parseSurfaceId({ kind: "answer", scope: { kind: "day", date: "2026-10-10" }, turnId: "t1" })!.scope).toEqual({ kind: "day", date: "2026-10-10" });
    for (const bad of [
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

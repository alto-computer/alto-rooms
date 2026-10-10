import { beforeEach, describe, expect, it } from "vitest";
import { connectSurfaces, surfaceKey, surfacePath, type SurfaceId } from "./surfaces";

function fakeParent() {
  const sent: Record<string, unknown>[] = [];
  const parent = { postMessage: (m: Record<string, unknown>) => void sent.push(m) } as unknown as Window;
  Object.defineProperty(window, "parent", { value: parent, configurable: true });
  const deliver = (data: unknown, source: unknown = parent) =>
    window.dispatchEvent(new MessageEvent("message", { data, source: source as MessageEventSource }));
  return { sent, deliver };
}

let host: ReturnType<typeof fakeParent>;
beforeEach(() => {
  host = fakeParent();
});

const answer: SurfaceId = { kind: "answer", scope: { kind: "room", roomId: "r1" }, turnId: "t1" };
const fromApp = (m: Record<string, unknown>) => ({ rooms: "surface", v: 1, ...m });

describe("connectSurfaces", () => {
  it("posts ready, actions, paint and menu with the surface envelope, and passes styles through for the app to judge", () => {
    const s = connectSurfaces();
    s.ready();
    s.setActions([{ id: "tag", title: "Tag", color: "#ffd400" }]);
    s.paint(answer, [{ id: "a", start: 0, end: 3, style: "mustard" }], { mustard: "rgba(199,154,62,0.28)" });
    s.paint(answer, [{ id: "a", start: 0, end: 3, style: "mustard" }]);
    s.menu(answer, "a", [{ id: "untag", title: "Untag" }]);
    expect(host.sent).toEqual([
      fromApp({ type: "ready" }),
      fromApp({ type: "actions", items: [{ id: "tag", title: "Tag", color: "#ffd400" }] }),
      fromApp({ type: "paint", surface: answer, ranges: [{ id: "a", start: 0, end: 3, style: "mustard" }], styles: { mustard: "rgba(199,154,62,0.28)" } }),
      fromApp({ type: "paint", surface: answer, ranges: [{ id: "a", start: 0, end: 3, style: "mustard" }] }),
      fromApp({ type: "menu", surface: answer, rangeId: "a", items: [{ id: "untag", title: "Untag" }] }),
    ]);
  });

  it("hands each app message to its listeners, until they unsubscribe", () => {
    const s = connectSurfaces();
    const got: unknown[] = [];
    const offOpen = s.onOpen((surface, text) => got.push(["open", surface, text]));
    s.onClose((surface) => got.push(["close", surface]));
    s.onAction((id, sel) => got.push(["action", id, sel]));
    s.onRangeClick((surface, rangeId) => got.push(["click", surface, rangeId]));
    s.onRangeAction((surface, rangeId, actionId) => got.push(["rangeAction", surface, rangeId, actionId]));
    host.deliver(fromApp({ type: "surface.open", surface: answer, text: "the quick fox" }));
    host.deliver(fromApp({ type: "selection.action", surface: answer, actionId: "tag", start: 4, end: 9, text: "quick" }));
    host.deliver(fromApp({ type: "range.click", surface: answer, rangeId: "a" }));
    host.deliver(fromApp({ type: "range.action", surface: answer, rangeId: "a", actionId: "untag" }));
    host.deliver(fromApp({ type: "surface.close", surface: answer }));
    offOpen();
    host.deliver(fromApp({ type: "surface.open", surface: answer, text: "again" }));
    expect(got).toEqual([
      ["open", answer, "the quick fox"],
      ["action", "tag", { surface: answer, start: 4, end: 9, text: "quick" }],
      ["click", answer, "a"],
      ["rangeAction", answer, "a", "untag"],
      ["close", answer],
    ]);
  });

  it("ignores messages from another window, another channel, or another version", () => {
    const s = connectSurfaces();
    const got: unknown[] = [];
    s.onOpen((_, text) => got.push(text));
    host.deliver(fromApp({ type: "surface.open", surface: answer, text: "forged" }), window);
    host.deliver({ rooms: "content", v: 1, type: "surface.open", surface: answer, text: "content channel" });
    host.deliver({ rooms: "surface", v: 2, type: "surface.open", surface: answer, text: "v2" });
    host.deliver(fromApp({ type: "surface.open", surface: answer, text: "real" }));
    expect(got).toEqual(["real"]);
  });
});

describe("surface names", () => {
  it("names a surface the way the app does, and as a storage path", () => {
    expect(surfaceKey(answer)).toBe("answer:room:r1/t1");
    expect(surfaceKey({ kind: "answer", scope: { kind: "doc", fileKey: "0123456789abcdef" }, turnId: "t1" })).toBe("answer:doc:0123456789abcdef/t1");
    expect(surfaceKey({ kind: "answer", scope: { kind: "day", date: "2026-10-10" }, turnId: "t1" })).toBe("answer:day:2026-10-10/t1");
    expect(surfacePath(answer)).toBe("answer/room/r1/t1");
    expect(surfacePath({ kind: "answer", scope: { kind: "day", date: "2026-10-10" }, turnId: "V1StGXR8_Z5jdHi6" })).toBe("answer/day/2026-10-10/V1StGXR8_Z5jdHi6");
  });
});

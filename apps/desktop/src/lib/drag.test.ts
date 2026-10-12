import { describe, expect, it } from "vitest";
import { artifactDragSource, SESSION_DRAG_TYPE, sessionDragSource, draggingFromRoom, readSessionPayload } from "./drag";

describe("drag state", () => {
  it("dragstart records the source room and dragend clears it", () => {
    const src = artifactDragSource({ roomId: "inbox", artifactId: "x1" });
    const dt = { setData: () => {}, effectAllowed: "all" };
    src.onDragStart({ dataTransfer: dt } as never);
    expect(draggingFromRoom()).toBe("inbox");
    src.onDragEnd();
    expect(draggingFromRoom()).toBeNull();
  });
});

describe("session drag payload", () => {
  const transfer = () => {
    const data = new Map<string, string>();
    return { data, setData: (t: string, v: string) => void data.set(t, v), getData: (t: string) => data.get(t) ?? "", effectAllowed: "all" };
  };

  it("round-trips through the drag data and records the room it is in", () => {
    const payload = { sessionRef: { agent: "aside" as const, id: "abc-1" }, roomId: "r1" };
    const dt = transfer();
    const src = sessionDragSource(payload);
    src.onDragStart({ dataTransfer: dt } as never);
    expect(draggingFromRoom()).toBe("r1");
    expect(readSessionPayload(dt as never)).toEqual(payload);
    src.onDragEnd();
    expect(draggingFromRoom()).toBeNull();
  });

  it("refuses an unknown agent, a missing session or a bad room", () => {
    for (const bad of [{ sessionRef: { agent: "gpt", id: "s" }, roomId: null }, { sessionRef: { agent: "codex", id: "" }, roomId: null }, { sessionRef: { agent: "codex", id: "-x" }, roomId: null }, { sessionRef: { agent: "codex", id: "s" }, roomId: 3 }]) {
      const dt = transfer();
      dt.setData(SESSION_DRAG_TYPE, JSON.stringify(bad));
      expect(readSessionPayload(dt as never)).toBeNull();
    }
  });
});

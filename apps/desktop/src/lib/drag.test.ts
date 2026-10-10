import { describe, expect, it } from "vitest";
import { artifactDragSource, CONVERSATION_DRAG_TYPE, conversationDragSource, draggingFromRoom, readConversationPayload } from "./drag";

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

describe("conversation drag payload", () => {
  const transfer = () => {
    const data = new Map<string, string>();
    return { data, setData: (t: string, v: string) => void data.set(t, v), getData: (t: string) => data.get(t) ?? "", effectAllowed: "all" };
  };

  it("round-trips through the drag data and records the room it is in", () => {
    const payload = { id: { agent: "aside" as const, session: "abc-1" }, roomId: "r1" };
    const dt = transfer();
    const src = conversationDragSource(payload);
    src.onDragStart({ dataTransfer: dt } as never);
    expect(draggingFromRoom()).toBe("r1");
    expect(readConversationPayload(dt as never)).toEqual(payload);
    src.onDragEnd();
    expect(draggingFromRoom()).toBeNull();
  });

  it("refuses an unknown agent, a missing session or a bad room", () => {
    for (const bad of [{ id: { agent: "gpt", session: "s" }, roomId: null }, { id: { agent: "codex", session: "" }, roomId: null }, { id: { agent: "codex", session: "s" }, roomId: 3 }]) {
      const dt = transfer();
      dt.setData(CONVERSATION_DRAG_TYPE, JSON.stringify(bad));
      expect(readConversationPayload(dt as never)).toBeNull();
    }
  });
});

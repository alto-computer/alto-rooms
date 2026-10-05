import { describe, expect, it } from "vitest";
import { artifactDragSource, draggingFromRoom } from "./drag";

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

import type { Artifact } from "@alto-rooms/protocol-ts";
import { act, cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderWithStores, room } from "@/test/fakes";
import { DocView } from "./DocView";

afterEach(cleanup);

const artifact = (id: string, title: string): Artifact => ({
  id,
  roomId: "r1",
  relPath: `sub/${id}.html`,
  title,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  author: "agent",
  source: { agent: null, session: null, cwd: null, machine: null },
});

describe("DocView", () => {
  it("renders the artifact full size in a sandboxed iframe from fileUrl", async () => {
    const { container } = await renderWithStores(<DocView roomId="r1" artifactId="a1" />, {
      rooms: [room("r1", "방")],
      artifacts: { r1: [artifact("a1", "보고서")] },
    });
    const frame = container.querySelector("iframe")!;
    expect(frame).toBeInTheDocument();
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-popups");
    expect(frame.getAttribute("src")).toBe("http://files.test/r1/sub/a1.html");
    expect(frame.hasAttribute("srcdoc")).toBe(false);
    expect(frame).toHaveAttribute("title", "보고서");
  });

  it("says the document is gone once the room's artifacts no longer include it", async () => {
    const fake = await renderWithStores(<DocView roomId="r1" artifactId="a1" />, {
      rooms: [room("r1", "방")],
      artifacts: { r1: [artifact("a1", "보고서")] },
    });
    await act(async () => {
      fake.emit({ type: "artifact.removed", roomId: "r1", artifactId: "a1" });
    });
    expect(screen.getByText("이 문서는 더 이상 없어요")).toBeInTheDocument();
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("shows the generic error when the room can't be loaded", async () => {
    await renderWithStores(<DocView roomId="r1" artifactId="a1" />, {
      rooms: [room("r1", "방")],
      artifactErrors: { r1: new Error("boom") },
    });
    expect(screen.getByText("문제가 생겼어요")).toBeInTheDocument();
  });
});

describe("DocView: removed room", () => {
  it("says the document is gone when its room is removed", async () => {
    const fake = await renderWithStores(<DocView roomId="r1" artifactId="a1" />, {
      rooms: [room("r1", "방")],
      artifacts: { r1: [artifact("a1", "보고서")] },
    });
    await act(async () => {
      fake.emit({ type: "room.removed", roomId: "r1" });
    });
    expect(screen.getByText("이 문서는 더 이상 없어요")).toBeInTheDocument();
  });
});

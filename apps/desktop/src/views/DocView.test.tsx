import type { Artifact } from "@alto-rooms/protocol-ts";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderWithStores, room } from "@/test/fakes";
import { plugin } from "@/test/plugins";
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
  source: { agent: null, session: null, cwd: null, machine: null }, fileKey: "0000000000000000",
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
    expect(frame.getAttribute("src")).toMatch(/^http:\/\/files\.test\/r1\/sub\/a1\.html\?doc=1&cs=[0-9a-f]{8}$/);
    expect(frame.hasAttribute("srcdoc")).toBe(false);
    expect(frame).toHaveAttribute("title", "보고서");
  });

  it("keys the doc URL by the content plugins that are on, so turning one off reloads the frame", async () => {
    const marker = plugin({ id: "marker", permissions: ["artifact.content"], granted: ["artifact.content"], slots: { artifactSidePanel: null, tab: null } });
    const { container, client, emit } = await renderWithStores(<DocView roomId="r1" artifactId="a1" />, {
      rooms: [room("r1", "방")],
      artifacts: { r1: [artifact("a1", "보고서")] },
      plugins: [marker],
    });
    const frame = container.querySelector("iframe")!;
    const withMarker = frame.getAttribute("src")!;
    const toggle = async (enabled: boolean) => {
      await client.setPluginEnabled("marker", enabled, ["artifact.content"]);
      await act(async () => void emit({ type: "plugins.changed" }));
    };
    await toggle(false);
    await waitFor(() => expect(frame.getAttribute("src")).not.toBe(withMarker));
    await toggle(true);
    await waitFor(() => expect(frame.getAttribute("src")).toBe(withMarker));
  });

  it("shows a skeleton until the document loads", async () => {
    const { container } = await renderWithStores(<DocView roomId="r1" artifactId="a1" />, {
      rooms: [room("r1", "방")],
      artifacts: { r1: [artifact("a1", "보고서")] },
    });
    expect(screen.getByTestId("doc-skeleton")).toBeInTheDocument();
    fireEvent.load(container.querySelector("iframe")!);
    expect(screen.queryByTestId("doc-skeleton")).toBeNull();
  });

  it("fades the document in, without the fade under reduced motion", async () => {
    const { container } = await renderWithStores(<DocView roomId="r1" artifactId="a1" />, {
      rooms: [room("r1", "방")],
      artifacts: { r1: [artifact("a1", "보고서")] },
    });
    const frame = container.querySelector("iframe")!;
    expect(frame).toHaveClass("opacity-0", "transition-opacity", "motion-reduce:transition-none");
    fireEvent.load(frame);
    expect(frame).toHaveClass("opacity-100");
  });

  it("takes the dark-mode dim unless its own page reports a dark background", async () => {
    const { container } = await renderWithStores(<DocView roomId="r1" artifactId="a1" />, {
      rooms: [room("r1", "방")],
      artifacts: { r1: [artifact("a1", "보고서")] },
    });
    const frame = container.querySelector("iframe")!;
    const dimmed = () => frame.classList.contains("[filter:var(--artifact-filter)]");
    const tone = (t: string, source: MessageEventSource | null = frame.contentWindow) =>
      act(() => void window.dispatchEvent(new MessageEvent("message", { data: { roomsTone: 1, tone: t }, source })));
    expect(dimmed()).toBe(true);
    tone("dark", window);
    expect(dimmed()).toBe(true);
    tone("dark");
    expect(dimmed()).toBe(false);
    tone("light");
    expect(dimmed()).toBe(true);
  });

  it("names where the artifact lives in a breadcrumb, and the room opens from it", async () => {
    const { viewer } = await renderWithStores(<DocView roomId="r1" artifactId="a1" />, {
      rooms: [room("r1", "방")],
      artifacts: { r1: [artifact("a1", "보고서")] },
    });
    const crumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(crumb).toHaveTextContent("방보고서");
    fireEvent.click(within(crumb).getByRole("button", { name: "방" }));
    expect(viewer.getState().tabs.find((t) => t.id === viewer.getState().activeId)).toMatchObject({ kind: "room", roomId: "r1" });
  });

  it("says the document is gone once the room's artifacts no longer include it", async () => {
    const fake = await renderWithStores(<DocView roomId="r1" artifactId="a1" />, {
      rooms: [room("r1", "방")],
      artifacts: { r1: [artifact("a1", "보고서")] },
    });
    await act(async () => {
      fake.emit({ type: "artifact.removed", roomId: "r1", artifactId: "a1" });
    });
    expect(screen.getByText("This artifact is gone")).toBeInTheDocument();
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("shows the generic error when the room can't be loaded", async () => {
    await renderWithStores(<DocView roomId="r1" artifactId="a1" />, {
      rooms: [room("r1", "방")],
      artifactErrors: { r1: new Error("boom") },
    });
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
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
    expect(screen.getByText("This artifact is gone")).toBeInTheDocument();
  });

  it("offers Ask over text selected in its own frame and quotes it in the ask bar", async () => {
    const { container, client } = await renderWithStores(<DocView roomId="r1" artifactId="a1" />, {
      rooms: [room("r1", "방")],
      artifacts: { r1: [artifact("a1", "보고서")] },
    });
    const frame = container.querySelector("iframe")!;
    const post = (data: unknown, source: MessageEventSource | null = frame.contentWindow) =>
      act(() => void window.dispatchEvent(new MessageEvent("message", { data, source })));
    // Another frame's message, or a malformed one, does nothing.
    post({ roomsSelection: 1, text: "elsewhere", rect: { x: 1, y: 100, w: 10, h: 10 } }, window);
    post({ roomsSelection: 1, text: 42 });
    expect(screen.queryByRole("button", { name: "Ask" })).toBeNull();
    post({ roomsSelection: 1, text: "한도 초과 판정은 공통", rect: { x: 100, y: 200, w: 80, h: 16 } });
    const ask = await screen.findByRole("button", { name: "Ask" });
    expect(ask.style.left).toBe("140px");
    fireEvent.click(ask);
    expect(screen.queryByRole("button", { name: "Ask" })).toBeNull();
    const quotes = await screen.findByRole("list", { name: "Quoted text" });
    expect(quotes.textContent).toContain("한도 초과 판정은 공통");
    const input = screen.getByPlaceholderText("Ask about this artifact…");
    await waitFor(() => expect(input).toHaveFocus());
    fireEvent.change(input, { target: { value: "왜 공통이야?" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(client.startAsk).toHaveBeenCalledWith(expect.objectContaining({ question: "> 한도 초과 판정은 공통\n\n왜 공통이야?" })));
    await waitFor(() => expect(screen.queryByRole("list", { name: "Quoted text" })).toBeNull());
    // An empty selection hides the button.
    post({ roomsSelection: 1, text: "x", rect: { x: 1, y: 100, w: 1, h: 1 } });
    await screen.findByRole("button", { name: "Ask" });
    post({ roomsSelection: 1, text: "", rect: null });
    expect(screen.queryByRole("button", { name: "Ask" })).toBeNull();
  });
});

import type { Artifact } from "@alto-rooms/protocol-ts";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localDate } from "@/lib/dates";
import { continueConversation } from "@/lib/native";
import { conversation, renderWithStores, room } from "@/test/fakes";
import { DocView } from "./DocView";

vi.mock("@/lib/native", () => ({
  pickFolder: vi.fn(async () => null),
  openInEditor: vi.fn(async () => {}),
  viewerInitial: vi.fn(async () => "J"),
  continueConversation: vi.fn(async () => true),
}));

beforeEach(() => {
  vi.mocked(continueConversation).mockClear();
});

afterEach(() => {
  cleanup();
});

const today = localDate();

const artifact = (id: string, extra: Partial<Artifact> = {}): Artifact => ({
  id,
  roomId: "p",
  relPath: `${id}.html`,
  title: `Artifact ${id}`,
  createdAt: `${today}T03:00:00Z`,
  updatedAt: `${today}T03:00:00Z`,
  author: "agent",
  source: { agent: null, session: null, cwd: null, machine: null },
  fileKey: "0000000000000000",
  ...extra,
});

describe("Doc: written in", () => {
  it("names the session that wrote the artifact and opens its tab on a click, ⌘-click in a new one, with no Continue", async () => {
    const c = conversation("s7", { title: "Why is cold start slow?", roomId: "p" });
    const h = await renderWithStores(<DocView roomId="p" artifactId="a1" />, {
      rooms: [room("p", "벤치마크", { artifactCount: 1 })],
      artifacts: { p: [artifact("a1", { source: { agent: "claude-code", session: "s7", cwd: null, machine: null } })] },
      days: { [today]: { conversations: [{ at: `${today}T01:00:00Z`, conversation: c }] } },
    });
    const sessions = () => h.viewer.getState().tabs.filter((t) => t.kind === "conversation");
    const tabsBefore = h.viewer.getState().tabs.length;
    const writtenIn = await screen.findByRole("button", { name: "Written in Why is cold start slow?, a Claude Code session" });
    fireEvent.click(writtenIn, { metaKey: true });
    expect(h.viewer.getState().tabs).toHaveLength(tabsBefore + 1);
    expect(sessions()).toEqual([expect.objectContaining({ agent: "claude-code", session: "s7" })]);
    fireEvent.click(writtenIn);
    expect(h.viewer.getState().tabs.find((t) => t.id === h.viewer.getState().activeId)).toMatchObject({ kind: "conversation", agent: "claude-code", session: "s7" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Continue in/ })).toBeNull();
    expect(continueConversation).not.toHaveBeenCalled();
  });

  it("stays out of the toolbar when the artifact names no session", async () => {
    const h = await renderWithStores(<DocView roomId="p" artifactId="a1" />, { rooms: [room("p", "벤치마크", { artifactCount: 1 })], artifacts: { p: [artifact("a1")] } });
    await screen.findByRole("navigation", { name: "Breadcrumb" });
    expect(screen.queryByRole("button", { name: /^Written in/ })).toBeNull();
    expect(h.client.journalDay).not.toHaveBeenCalledWith(today);
  });
});

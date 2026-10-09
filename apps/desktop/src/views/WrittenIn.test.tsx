import type { Artifact } from "@alto-rooms/protocol-ts";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
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
  it("names the conversation that wrote the artifact and continues it from its card", async () => {
    const c = conversation("s7", { title: "Why is cold start slow?", roomId: "p" });
    await renderWithStores(<DocView roomId="p" artifactId="a1" />, {
      rooms: [room("p", "벤치마크", { artifactCount: 1 })],
      artifacts: { p: [artifact("a1", { source: { agent: "claude-code", session: "s7", cwd: null, machine: null } })] },
      days: { [today]: { conversations: [{ at: `${today}T01:00:00Z`, conversation: c }] } },
    });
    fireEvent.click(await screen.findByRole("button", { name: /^Written in/ }));
    const card = within(await screen.findByRole("dialog", { name: "Written in" }));
    fireEvent.click(card.getByRole("button", { name: "Continue in Claude Code" }));
    expect(continueConversation).toHaveBeenCalledWith(c);
  });

  it("opens the session's tab from the card's title", async () => {
    const c = conversation("s7", { title: "Why is cold start slow?" });
    const h = await renderWithStores(<DocView roomId="p" artifactId="a1" />, {
      rooms: [room("p", "벤치마크", { artifactCount: 1 })],
      artifacts: { p: [artifact("a1", { source: { agent: "claude-code", session: "s7", cwd: null, machine: null } })] },
      days: { [today]: { conversations: [{ at: `${today}T01:00:00Z`, conversation: c }] } },
    });
    fireEvent.click(await screen.findByRole("button", { name: /^Written in/ }));
    const card = within(await screen.findByRole("dialog", { name: "Written in" }));
    fireEvent.click(card.getByRole("button", { name: "Why is cold start slow?" }));
    expect(h.viewer.getState().tabs.find((t) => t.id === h.viewer.getState().activeId)).toMatchObject({ kind: "conversation", agent: "claude-code", session: "s7" });
  });

  it("stays out of the toolbar when the artifact names no session", async () => {
    const h = await renderWithStores(<DocView roomId="p" artifactId="a1" />, { rooms: [room("p", "벤치마크", { artifactCount: 1 })], artifacts: { p: [artifact("a1")] } });
    await screen.findByRole("navigation", { name: "Breadcrumb" });
    expect(screen.queryByRole("button", { name: /^Written in/ })).toBeNull();
    expect(h.client.journalDay).not.toHaveBeenCalledWith(today);
  });
});

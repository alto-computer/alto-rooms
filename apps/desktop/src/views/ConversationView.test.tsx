import type { Artifact } from "@alto-rooms/protocol-ts";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ViewerStore } from "@/data/viewerStore";
import { localDate, monthDay } from "@/lib/dates";
import { continueConversation } from "@/lib/native";
import { TabLabel } from "@/shell/TabLabel";
import { conversation, memoryStorage, renderWithStores, room } from "@/test/fakes";
import { ConversationView } from "./ConversationView";

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
const ROOMS = [room("inbox", "Inbox"), room("p", "벤치마크", { color: "clay" }), room("r", "리서치")];
const ID = { agent: "claude-code", session: "s7" } as const;

const artifact = (id: string, session: string | null): Artifact => ({
  id,
  roomId: "p",
  relPath: `${id}.html`,
  title: `Artifact ${id}`,
  createdAt: `${today}T03:00:00Z`,
  updatedAt: `${today}T03:00:00Z`,
  author: "agent",
  source: { agent: session ? "claude-code" : null, session, cwd: null, machine: null },
  fileKey: `${id}000000000000`.slice(0, 16),
});

function setup(extra: Partial<Parameters<typeof conversation>[1]> = {}, artifacts: Artifact[] = []) {
  const c = conversation("s7", {
    title: "Why is cold start 1.4 s on the M1 Air?",
    cwd: "/Users/me/code/alto-rooms",
    startedAt: `${today}T01:00:00Z`,
    endedAt: `${today}T02:00:00Z`,
    messages: 42,
    lastReply: "Spawning roomsd after first paint gets cold start to 0.6 s.",
    ...extra,
  });
  const viewer = new ViewerStore(memoryStorage());
  viewer.open({ kind: "conversation", ...ID });
  return {
    c,
    render: () =>
      renderWithStores(<ConversationView id={ID} />, {
        viewer,
        home: "/Users/me/rooms",
        rooms: ROOMS,
        conversations: [c],
        days: { [today]: { artifacts } },
      }),
  };
}

const activeTab = (v: ViewerStore) => v.getState().tabs.find((t) => t.id === v.getState().activeId);

describe("Session view", () => {
  it("shows the Journal day, the title, what the logs say of it and its last reply", async () => {
    await setup().render();
    const crumb = within(await screen.findByRole("navigation", { name: "Breadcrumb" }));
    expect(crumb.getByText("Journal")).toBeInTheDocument();
    expect(crumb.getByRole("button", { name: monthDay(today) })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Why is cold start 1.4 s on the M1 Air?");
    const article = screen.getByRole("article");
    expect(article).toHaveTextContent("Claude Code");
    expect(article).toHaveTextContent("~/code/alto-rooms");
    expect(article).toHaveTextContent("42 messages");
    expect(within(screen.getByRole("region", { name: "Last reply" })).getByText(/Spawning roomsd after first paint/)).toBeInTheDocument();
  });

  it("the breadcrumb starts at its room when it is in one, and opens it", async () => {
    const h = await setup({ roomId: "p" }).render();
    const crumb = within(await screen.findByRole("navigation", { name: "Breadcrumb" }));
    expect(crumb.queryByText("Journal")).toBeNull();
    fireEvent.click(crumb.getByRole("button", { name: "벤치마크" }));
    expect(activeTab(h.viewer)).toMatchObject({ kind: "room", roomId: "p" });
  });

  it("continues the session in Terminal from the ink button", async () => {
    const s = setup();
    await s.render();
    fireEvent.click(await screen.findByRole("button", { name: "Continue in Claude Code" }));
    expect(continueConversation).toHaveBeenCalledWith(s.c);
  });

  it("the room chip adds it to a room, then offers open, move and remove", async () => {
    const h = await setup().render();
    fireEvent.pointerDown(await screen.findByRole("button", { name: "Add to Room" }), { button: 0, ctrlKey: false });
    const menu = within(await screen.findByRole("menu"));
    expect(menu.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Add to Room"]);
    fireEvent.click(menu.getByRole("menuitem", { name: "Add to Room" }));
    // The chip names the first menu too; the room list is the submenu, opened last.
    const list = within((await screen.findAllByRole("menu", { name: "Add to Room" })).at(-1)!);
    expect(list.getAllByRole("menuitemradio").map((i) => i.textContent)).toEqual(["벤치마크", "리서치"]);
    await act(async () => void fireEvent.click(list.getByRole("menuitemradio", { name: "리서치" })));
    expect(h.client.setConversationRoom).toHaveBeenCalledWith(ID, "r");

    await act(async () => h.emit({ type: "conversation.moved", conversation: h.state.conversations[0], fromRoomId: null }));
    fireEvent.pointerDown(await screen.findByRole("button", { name: "Room: 리서치" }), { button: 0, ctrlKey: false });
    const inRoom = within(await screen.findByRole("menu"));
    expect(inRoom.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Open 리서치", "Move to Room", "Remove from Room"]);
    await act(async () => void fireEvent.click(inRoom.getByRole("menuitem", { name: "Remove from Room" })));
    expect(h.client.setConversationRoom).toHaveBeenLastCalledWith(ID, null);
  });

  it("asks about the session in its own scope", async () => {
    const h = await setup().render();
    const input = await screen.findByPlaceholderText("Ask about this session…");
    fireEvent.change(input, { target: { value: "세 줄로 요약해줘" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(h.client.startAsk).toHaveBeenCalledWith({ scope: { kind: "conversation", ...ID }, question: "세 줄로 요약해줘", model: null }),
    );
    await act(async () => h.emit({ type: "ask.started", turn: { ...(await h.client.startAsk.mock.results[0].value), mode: "resume" } }));
    expect(await screen.findByText("claude-code · continuing this session")).toBeInTheDocument();
  });

  it("lists the artifacts it wrote, and only those, and opens one", async () => {
    const h = await setup({}, [artifact("a1", "s7"), artifact("a2", "other"), artifact("a3", null)]).render();
    const written = within(await screen.findByRole("region", { name: "Artifacts it wrote" }));
    expect(written.getAllByTestId("card-title").map((t) => t.textContent)).toEqual(["Artifact a1"]);
    fireEvent.click(written.getByRole("button", { name: "Artifact a1" }));
    expect(activeTab(h.viewer)).toMatchObject({ kind: "doc", roomId: "p", artifactId: "a1" });
  });

  it("says when roomsd no longer knows the session", async () => {
    await renderWithStores(<ConversationView id={{ agent: "codex", session: "gone" }} />, { rooms: ROOMS });
    expect(await screen.findByText("This session is gone")).toBeInTheDocument();
  });

  it("its tab is labelled with the title", async () => {
    await renderWithStores(<TabLabel tab={{ id: "t", kind: "conversation", ...ID }} />, { rooms: ROOMS, conversations: [conversation("s7", { title: "Weekly report W41" })] });
    expect(await screen.findByText("Weekly report W41")).toBeInTheDocument();
  });
});

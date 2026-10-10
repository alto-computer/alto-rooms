import type { Artifact } from "@alto-rooms/protocol-ts";
import { RoomsApiError } from "@alto-rooms/protocol-ts";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ViewerStore } from "@/data/viewerStore";
import { addDays, localDate, monthDay } from "@/lib/dates";
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

  it("the room chip opens the room list in one click, pinned first and never the inbox, and adds it to the pick", async () => {
    const h = await setup().render();
    fireEvent.pointerDown(await screen.findByRole("button", { name: "Add to Room" }), { button: 0, ctrlKey: false });
    const menu = within(await screen.findByRole("menu", { name: "Add to Room" }));
    expect(menu.queryAllByRole("menuitem")).toEqual([]);
    expect(menu.getAllByRole("menuitemradio").map((i) => [i.textContent, i.getAttribute("aria-checked")])).toEqual([
      ["벤치마크", "false"],
      ["리서치", "false"],
    ]);
    await act(async () => void fireEvent.click(menu.getByRole("menuitemradio", { name: "리서치" })));
    expect(h.client.setConversationRoom).toHaveBeenCalledWith(ID, "r");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("in a room, the chip names it, checks it in the same list, moves, opens and removes", async () => {
    const h = await setup({ roomId: "r" }).render();
    const openChip = async () => {
      fireEvent.pointerDown(await screen.findByRole("button", { name: "Room: 리서치" }), { button: 0, ctrlKey: false });
      return within(await screen.findByRole("menu"));
    };
    let menu = await openChip();
    expect(menu.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Open 리서치", "Remove from Room"]);
    expect(menu.getAllByRole("menuitemradio").map((i) => [i.textContent, i.getAttribute("aria-checked")])).toEqual([
      ["벤치마크", "false"],
      ["리서치", "true"],
    ]);
    await act(async () => void fireEvent.click(menu.getByRole("menuitemradio", { name: "벤치마크" })));
    expect(h.client.setConversationRoom).toHaveBeenLastCalledWith(ID, "p");

    menu = await openChip();
    await act(async () => void fireEvent.click(menu.getByRole("menuitem", { name: "Remove from Room" })));
    expect(h.client.setConversationRoom).toHaveBeenLastCalledWith(ID, null);

    menu = await openChip();
    fireEvent.click(menu.getByRole("menuitem", { name: "Open 리서치" }));
    expect(activeTab(h.viewer)).toMatchObject({ kind: "room", roomId: "r" });
  });

  it("read-only, the chip in a room only opens it", async () => {
    const c = conversation("s7", { roomId: "r" });
    await renderWithStores(<ConversationView id={ID} />, { rooms: ROOMS, conversations: [c], readOnly: true });
    fireEvent.pointerDown(await screen.findByRole("button", { name: "Room: 리서치" }), { button: 0, ctrlKey: false });
    const menu = within(await screen.findByRole("menu"));
    expect(menu.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Open 리서치"]);
    expect(menu.queryAllByRole("menuitemradio")).toEqual([]);
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

  it("lists what it wrote on a day between the one it started and the one it ended", async () => {
    const twoDaysAgo = addDays(today, -2);
    const yesterday = addDays(today, -1);
    const { c } = setup({ startedAt: `${twoDaysAgo}T12:00:00`, endedAt: `${today}T12:00:00` });
    const mid = { ...artifact("m1", "s7"), createdAt: `${yesterday}T12:00:00`, updatedAt: `${yesterday}T12:00:00` };
    await renderWithStores(<ConversationView id={ID} />, { rooms: ROOMS, conversations: [c], days: { [yesterday]: { artifacts: [mid] } } });
    const written = within(await screen.findByRole("region", { name: "Artifacts it wrote" }));
    expect(written.getAllByTestId("card-title").map((t) => t.textContent)).toEqual(["Artifact m1"]);
  });

  it("says when roomsd no longer knows the session", async () => {
    await renderWithStores(<ConversationView id={{ agent: "codex", session: "gone" }} />, { rooms: ROOMS });
    expect(await screen.findByText("This session is gone")).toBeInTheDocument();
  });

  it("its tab label and its view load the session once per focus between them", async () => {
    const c = conversation("s7", { title: "Weekly report W41" });
    const h = await renderWithStores(<><TabLabel tab={{ id: "t", kind: "conversation", ...ID }} /><ConversationView id={ID} /></>, { rooms: ROOMS, conversations: [c] });
    expect(await screen.findAllByText("Weekly report W41")).not.toHaveLength(0);
    const before = h.client.getConversation.mock.calls.length;
    await act(async () => void window.dispatchEvent(new Event("focus")));
    expect(h.client.getConversation.mock.calls.length - before).toBe(1);
  });

  it("keeps showing the session when a refetch fails or answers 404", async () => {
    const h = await renderWithStores(<ConversationView id={ID} />, { rooms: ROOMS, conversations: [conversation("s7", { title: "Weekly report W41" })] });
    await screen.findByRole("heading", { name: "Weekly report W41" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const e of [new RoomsApiError(404, "not found", "not_found"), new RoomsApiError(500, "collect.db: busy", "internal")]) {
      h.client.getConversation.mockRejectedValueOnce(e);
      await act(async () => void window.dispatchEvent(new Event("focus")));
      expect(screen.getByRole("heading", { name: "Weekly report W41" })).toBeInTheDocument();
      expect(screen.queryByText("This session is gone")).toBeNull();
    }
  });

  it("its tab is labelled with the title", async () => {
    await renderWithStores(<TabLabel tab={{ id: "t", kind: "conversation", ...ID }} />, { rooms: ROOMS, conversations: [conversation("s7", { title: "Weekly report W41" })] });
    expect(await screen.findByText("Weekly report W41")).toBeInTheDocument();
  });
});

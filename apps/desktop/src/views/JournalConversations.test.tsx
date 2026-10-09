import type { Conversation } from "@alto-rooms/protocol-ts";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useViewer } from "@/data/hooks";
import { ViewerStore } from "@/data/viewerStore";
import { clockTime, localDate } from "@/lib/dates";
import { continueConversation } from "@/lib/native";
import { conversation, memoryStorage, renderWithStores, room } from "@/test/fakes";
import { JournalView } from "./JournalView";

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

function Journal() {
  const { tabs } = useViewer();
  const tab = tabs.find((t) => t.kind === "journal");
  return tab?.kind === "journal" ? <JournalView key={tab.id} tabId={tab.id} date={tab.date} /> : null;
}

function journalViewer() {
  const viewer = new ViewerStore(memoryStorage());
  viewer.open({ kind: "journal", date: today });
  return viewer;
}

/** A day with two conversations, one of them in the pinned room. */
function day(conversations: Conversation[]) {
  return {
    viewer: journalViewer(),
    rooms: ROOMS,
    conversations,
    days: { [today]: { conversations: conversations.map((c, i) => ({ at: `${today}T0${i + 1}:00:00Z`, conversation: c })) } },
  };
}

const rows = () => screen.getAllByTestId("day-conversation");
const menu = async () => screen.findByRole("menu", { name: /menu$/ });

describe("Journal: conversations", () => {
  it("shows each conversation as one line at its time, with a room chip only when it is in a room", async () => {
    await renderWithStores(
      <Journal />,
      day([conversation("s1", { title: "Why is cold start slow?" }), conversation("s2", { title: null, lastReply: "Spawning roomsd after first paint gets cold start to 0.6 s on the Air", roomId: "p" })]),
    );
    const [first, second] = rows();
    expect(first).toHaveAccessibleName("Why is cold start slow?");
    expect(first).not.toHaveTextContent("벤치마크");
    expect(second).toHaveAccessibleName("Spawning roomsd after first paint gets cold start…");
    expect(second).toHaveTextContent("벤치마크");
    expect(screen.getByText(clockTime(`${today}T01:00:00Z`))).toBeInTheDocument();
    expect(screen.getByText(/2 conversations$/)).toBeInTheDocument();
  });

  it("a click selects the row and never continues it", async () => {
    await renderWithStores(<Journal />, day([conversation("s1")]));
    fireEvent.click(rows()[0]);
    expect(rows()[0]).toHaveAttribute("data-selected");
    expect(continueConversation).not.toHaveBeenCalled();
  });

  it("the ink pill continues the conversation through the native bridge", async () => {
    const c = conversation("s1", { id: { agent: "codex", session: "s1" } });
    await renderWithStores(<Journal />, day([c]));
    fireEvent.click(within(rows()[0]).getByRole("button", { name: "Continue in Codex" }));
    expect(continueConversation).toHaveBeenCalledWith(c);
  });

  it("offers Add to Room for a conversation in no room, pinned rooms first and never the inbox", async () => {
    const h = await renderWithStores(<Journal />, day([conversation("s1")]));
    fireEvent.contextMenu(rows()[0]);
    const m = within(await menu());
    expect(m.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Continue in Claude Code", "Add to Room"]);
    fireEvent.click(m.getByRole("menuitem", { name: "Add to Room" }));
    const list = within(await screen.findByRole("menu", { name: "Add to Room" }));
    expect(list.getAllByRole("menuitemradio").map((i) => i.textContent)).toEqual(["벤치마크", "리서치"]);
    await act(async () => void fireEvent.click(list.getByRole("menuitemradio", { name: "리서치" })));
    expect(h.client.setConversationRoom).toHaveBeenCalledWith({ agent: "claude-code", session: "s1" }, "r");
  });

  it("offers Move to Room and Remove from Room once it is in a room, and the chip follows conversation.moved", async () => {
    const c = conversation("s1", { roomId: "p" });
    const h = await renderWithStores(<Journal />, day([c]));
    fireEvent.click(within(rows()[0]).getByRole("button", { name: /^More for/ }));
    const m = within(await menu());
    expect(m.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Continue in Claude Code", "Move to Room", "Remove from Room"]);
    await act(async () => void fireEvent.click(m.getByRole("menuitem", { name: "Remove from Room" })));
    expect(h.client.setConversationRoom).toHaveBeenCalledWith(c.id, null);

    h.state.days[today] = { conversations: [{ at: `${today}T01:00:00Z`, conversation: { ...c, roomId: null } }] };
    await act(async () => h.emit({ type: "conversation.moved", conversation: { ...c, roomId: null }, fromRoomId: "p" }));
    await waitFor(() => expect(rows()[0]).not.toHaveTextContent("벤치마크"));
  });

  it("the tally lists the day's conversations newest first, and one selects its row", async () => {
    await renderWithStores(<Journal />, day([conversation("s1", { title: "아침" }), conversation("s2", { title: "점심", roomId: "p" })]));
    const cell = within(screen.getByRole("region", { name: "Today" })).getByRole("button", { name: "2 conversations" });
    fireEvent.pointerEnter(cell, { pointerType: "mouse" });
    const list = within(await screen.findByRole("dialog", { name: "2 conversations" }));
    const items = list.getAllByRole("button");
    expect(items.map((b) => b.textContent)).toEqual([`${clockTime(`${today}T02:00:00Z`)}점심Claude Code · 벤치마크`, `${clockTime(`${today}T01:00:00Z`)}아침Claude Code`]);
    await act(async () => {
      fireEvent.click(items[1]);
      await new Promise((r) => requestAnimationFrame(r));
    });
    expect(screen.getByRole("group", { name: "아침" })).toHaveAttribute("data-selected");
    expect(screen.getByRole("group", { name: "아침" })).toHaveFocus();
  });
});

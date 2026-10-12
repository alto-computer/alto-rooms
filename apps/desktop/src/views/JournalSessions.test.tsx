import type { Session } from "@alto-rooms/protocol-ts";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useViewer } from "@/data/hooks";
import { ViewerStore } from "@/data/viewerStore";
import { clockTime, localDate } from "@/lib/dates";
import { continueSession } from "@/lib/native";
import { session, memoryStorage, renderWithStores, room } from "@/test/fakes";
import { JournalView } from "./JournalView";

vi.mock("@/lib/native", () => ({
  pickFolder: vi.fn(async () => null),
  openInEditor: vi.fn(async () => {}),
  viewerInitial: vi.fn(async () => "J"),
  continueSession: vi.fn(async () => true),
}));

beforeEach(() => {
  vi.mocked(continueSession).mockClear();
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

/** A day with two sessions, one of them in the pinned room. */
function day(sessions: Session[]) {
  return {
    viewer: journalViewer(),
    rooms: ROOMS,
    sessions,
    days: { [today]: { sessions: sessions.map((c, i) => ({ at: `${today}T0${i + 1}:00:00Z`, session: c })) } },
  };
}

const rows = () => screen.getAllByTestId("day-session");
/** Row `i`'s open button, named by its agent and title. */
const open = (i: number) => within(rows()[i]).getAllByRole("button")[0];
const menu = async () => screen.findByRole("menu", { name: /menu$/ });

describe("Journal: sessions", () => {
  it("shows each session as one line at its time, with a room chip only when it is in a room", async () => {
    await renderWithStores(
      <Journal />,
      day([session("s1", { title: "Why is cold start slow?" }), session("s2", { title: null, lastReply: "Spawning roomsd after first paint gets cold start to 0.6 s on the Air", roomId: "p" })]),
    );
    const [first, second] = rows();
    expect(first).toHaveAccessibleName("Why is cold start slow?");
    expect(first).not.toHaveTextContent("벤치마크");
    expect(second).toHaveAccessibleName("Spawning roomsd after first paint gets cold start…");
    expect(second).toHaveTextContent("벤치마크");
    expect(screen.getByText(clockTime(`${today}T01:00:00Z`))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "2 sessions" })).toBeInTheDocument();
  });

  it("a click opens the session in this tab, ⌘-click and Enter with ⌘ in a new one, and none continues it", async () => {
    const h = await renderWithStores(<Journal />, day([session("s1"), session("s2", { agent: "codex" })]));
    const sessions = () => h.viewer.getState().tabs.filter((t) => t.kind === "session");
    fireEvent.click(open(1), { metaKey: true });
    expect(sessions()).toEqual([expect.objectContaining({ agent: "codex", sessionId: "s2" })]);
    expect(h.viewer.getState().tabs.some((t) => t.kind === "journal")).toBe(true);
    fireEvent.keyDown(open(0), { key: "Enter", metaKey: true });
    expect(sessions()).toHaveLength(2);
    fireEvent.click(open(0));
    const active = h.viewer.getState().tabs.find((t) => t.id === h.viewer.getState().activeId);
    expect(active).toMatchObject({ kind: "session", agent: "claude-code", sessionId: "s1" });
    expect(continueSession).not.toHaveBeenCalled();
  });

  it("a row opens from a real button named by its agent and title, apart from its ⋯", async () => {
    await renderWithStores(<Journal />, day([session("s1", { title: "Why is cold start slow?", roomId: "p" })]));
    expect(within(rows()[0]).getByRole("button", { name: /^Claude Code\s*Why is cold start slow\?\s*벤치마크$/ })).toBeInTheDocument();
    expect(within(rows()[0]).getByRole("button", { name: /^More for/ })).toBeInTheDocument();
  });

  it("a row offers no Continue: only its ⋯, whose menu is about rooms", async () => {
    await renderWithStores(<Journal />, day([session("s1", { agent: "codex" })]));
    const row = within(rows()[0]);
    expect(row.getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([null, expect.stringMatching(/^More for/)]);
    fireEvent.click(row.getByRole("button", { name: /^More for/ }));
    expect(within(await menu()).queryByRole("menuitem", { name: /^Continue in/ })).toBeNull();
    expect(continueSession).not.toHaveBeenCalled();
  });

  it("read-only, a row has no ⋯ and right-click opens no menu", async () => {
    await renderWithStores(<Journal />, { ...day([session("s1")]), readOnly: true });
    expect(within(rows()[0]).queryByRole("button", { name: /^More for/ })).toBeNull();
    fireEvent.contextMenu(rows()[0]);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("offers Add to Room for a session in no room, pinned rooms first and never the inbox", async () => {
    const h = await renderWithStores(<Journal />, day([session("s1")]));
    fireEvent.contextMenu(rows()[0]);
    const m = within(await menu());
    expect(m.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Add to Room"]);
    fireEvent.click(m.getByRole("menuitem", { name: "Add to Room" }));
    const list = within(await screen.findByRole("menu", { name: "Add to Room" }));
    expect(list.getAllByRole("menuitemradio").map((i) => i.textContent)).toEqual(["벤치마크", "리서치"]);
    await act(async () => void fireEvent.click(list.getByRole("menuitemradio", { name: "리서치" })));
    expect(h.client.setSessionRoom).toHaveBeenCalledWith({ agent: "claude-code", id: "s1" }, "r");
  });

  it("offers Move to Room and Remove from Room once it is in a room, and the chip follows session.moved", async () => {
    const c = session("s1", { roomId: "p" });
    const h = await renderWithStores(<Journal />, day([c]));
    fireEvent.click(within(rows()[0]).getByRole("button", { name: /^More for/ }));
    const m = within(await menu());
    expect(m.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Move to Room", "Remove from Room"]);
    await act(async () => void fireEvent.click(m.getByRole("menuitem", { name: "Remove from Room" })));
    expect(h.client.setSessionRoom).toHaveBeenCalledWith({ agent: c.agent, id: c.id }, null);

    h.state.days[today] = { sessions: [{ at: `${today}T01:00:00Z`, session: { ...c, roomId: null } }] };
    await act(async () => h.emit({ type: "session.moved", session: { ...c, roomId: null }, fromRoomId: "p" }));
    await waitFor(() => expect(rows()[0]).not.toHaveTextContent("벤치마크"));
  });

  it("the tally lists the day's sessions newest first, and one opens its session", async () => {
    const h = await renderWithStores(<Journal />, day([session("s1", { title: "아침" }), session("s2", { title: "점심", roomId: "p" })]));
    const cell = within(screen.getByRole("region", { name: "Today" })).getByRole("button", { name: "2 sessions" });
    fireEvent.pointerEnter(cell, { pointerType: "mouse" });
    const list = within(await screen.findByRole("dialog", { name: "2 sessions" }));
    const items = list.getAllByRole("button");
    expect(items.map((b) => b.textContent)).toEqual([`${clockTime(`${today}T02:00:00Z`)}점심Claude Code · 벤치마크`, `${clockTime(`${today}T01:00:00Z`)}아침Claude Code`]);
    await act(async () => void fireEvent.click(items[1]));
    const active = h.viewer.getState().tabs.find((t) => t.id === h.viewer.getState().activeId);
    expect(active).toMatchObject({ kind: "session", agent: "claude-code", sessionId: "s1" });
  });
});

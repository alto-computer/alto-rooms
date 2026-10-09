import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useViewer } from "@/data/hooks";
import { ViewerStore } from "@/data/viewerStore";
import { memoryStorage, renderWithStores } from "@/test/fakes";
import { JournalView } from "./JournalView";

vi.mock("@/lib/native", () => ({ viewerInitial: vi.fn(async () => "J") }));

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function Host() {
  const { tabs } = useViewer();
  const tab = tabs.find((t) => t.kind === "journal");
  return tab?.kind === "journal" ? <JournalView key={tab.id} tabId={tab.id} date={tab.date} /> : null;
}

it("a question typed while the next day loads can never be asked about, or drafted for, the previous day", async () => {
  const viewer = new ViewerStore(memoryStorage());
  viewer.open({ kind: "journal", date: "2026-10-05" });
  const { client } = await renderWithStores(<Host />, { viewer });
  const input = () => screen.queryByPlaceholderText("Ask about this day…") as HTMLTextAreaElement | null;
  await waitFor(() => expect(input()).not.toBeNull());
  const load = client.journalDay;
  let arrive: () => void = () => {};
  vi.spyOn(client, "journalDay").mockImplementation((date: string) => new Promise((resolve) => (arrive = () => resolve(load(date)))));

  fireEvent.click(screen.getByRole("button", { name: "Oct 6" }));
  await act(() => new Promise((r) => setTimeout(r, 50)));
  expect(input()).toBeNull();

  await act(async () => arrive());
  await waitFor(() => expect(input()).not.toBeNull());
  fireEvent.change(input()!, { target: { value: "화요일에 뭐 했어?" } });
  expect(localStorage.getItem("alto-rooms.askDraft.day:2026-10-05")).toBeNull();
  fireEvent.keyDown(input()!, { key: "Enter" });
  await waitFor(() => expect(client.startAsk).toHaveBeenCalledTimes(1));
  expect(client.startAsk).toHaveBeenCalledWith({ scope: { kind: "day", date: "2026-10-06" }, question: "화요일에 뭐 했어?", model: null });
});

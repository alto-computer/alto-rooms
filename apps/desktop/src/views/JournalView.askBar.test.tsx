import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AskSubject } from "@/ask/askSubjects";
import { useViewer } from "@/data/hooks";
import { ViewerStore } from "@/data/viewerStore";
import { memoryStorage, renderWithStores } from "@/test/fakes";
import { JournalView } from "./JournalView";

const mounts = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/ask/AskBar", () => ({
  AskBar: ({ subject }: { subject: AskSubject }) => {
    mounts.count++;
    return <div data-testid="ask-bar" data-subject={JSON.stringify(subject)} />;
  },
}));
vi.mock("@/lib/native", () => ({ viewerInitial: vi.fn(async () => "J") }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  mounts.count = 0;
});

function Host() {
  const { tabs } = useViewer();
  const tab = tabs.find((t) => t.kind === "journal");
  return tab?.kind === "journal" ? <JournalView key={tab.id} tabId={tab.id} date={tab.date} /> : null;
}

function journalViewer(date: string) {
  const viewer = new ViewerStore(memoryStorage());
  viewer.open({ kind: "journal", date });
  return viewer;
}

/** A requestAnimationFrame that never calls back, like a window the user can't see. */
function holdFrames() {
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
}

const subject = () => JSON.parse(screen.getByTestId("ask-bar").dataset.subject!);

it("asks about the viewed day, and follows the week strip to another day", async () => {
  await renderWithStores(<Host />, { viewer: journalViewer("2026-10-05") });
  await screen.findByTestId("ask-bar");
  expect(subject()).toEqual({ kind: "day", date: "2026-10-05" });
  fireEvent.click(screen.getByRole("button", { name: "Oct 6" }));
  expect(subject()).toEqual({ kind: "day", date: "2026-10-06" });
});

it("never mounts the day's ask bar in read-only", async () => {
  await renderWithStores(<Host />, { viewer: journalViewer("2026-10-05"), readOnly: true });
  await screen.findByRole("region", { name: "From me" });
  await act(() => new Promise((r) => setTimeout(r, 150)));
  expect(mounts.count).toBe(0);
});

it("mounts the day's ask bar even when the window never paints a frame", async () => {
  holdFrames();
  await renderWithStores(<Host />, { viewer: journalViewer("2026-10-05") });
  expect(await screen.findByTestId("ask-bar")).toBeTruthy();
});

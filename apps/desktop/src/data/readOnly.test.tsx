import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetNoteSavers } from "@/lib/noteSaver";
import { fakeClient, memoryStorage, room } from "@/test/fakes";
import { JournalView } from "@/views/JournalView";
import { NoteView } from "@/views/NoteView";
import { StoresProvider } from "./hooks";
import { RoomsStore } from "./roomsStore";
import { ViewerStore } from "./viewerStore";

vi.mock("@/lib/native", () => ({
  pickFolder: vi.fn(async () => null),
  openInEditor: vi.fn(async () => {}),
  viewerInitial: vi.fn(async () => "J"),
}));

afterEach(() => {
  cleanup();
  resetNoteSavers();
});

const DATE = "2026-10-05";

/** Renders with stores whose first sync has not happened yet (`info === null`); `sync()` runs it. */
async function beforeSync(ui: ReactNode) {
  const fake = fakeClient({
    rooms: [room("r1", "벤치마크")],
    artifacts: { r1: [] },
    notes: { [`${DATE}/계획.md`]: "본문" },
  });
  const rooms = new RoomsStore(fake.client, { warn: () => {} });
  render(
    <StoresProvider rooms={rooms} viewer={new ViewerStore(memoryStorage())} client={fake.client}>
      {ui}
    </StoresProvider>,
  );
  await act(async () => {}); // per-scope loads (day, note body) settle; the sync has not run
  const sync = () =>
    act(async () => {
      rooms.start();
      fake.emit({ type: "resync", roomId: null });
    });
  return { rooms, sync };
}

describe("info === null is read-only", () => {
  it("Journal hides 새 노트 until the first sync", async () => {
    const { rooms, sync } = await beforeSync(<JournalView date={DATE} />);
    expect(rooms.getState().info).toBeNull();
    expect(rooms.getState().days[DATE]).toBeDefined();
    expect(screen.queryByRole("button", { name: "새 노트" })).toBeNull();
    await sync();
    expect(screen.getByRole("button", { name: "새 노트" })).toBeInTheDocument();
  });

  it("the note body is read-only until the first sync", async () => {
    const { sync } = await beforeSync(<NoteView date={DATE} name="계획.md" />);
    const body = screen.getByRole("textbox", { name: "노트" });
    expect(body).toHaveValue("본문");
    expect(body).toHaveAttribute("readonly");
    await sync();
    expect(body).not.toHaveAttribute("readonly");
  });
});

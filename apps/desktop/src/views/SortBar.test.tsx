import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SortState } from "@/lib/sort";
import { SortBar } from "./SortBar";

const api = vi.hoisted(() => ({
  sortState: vi.fn<() => Promise<SortState | null>>(),
  sortSetKey: vi.fn<(key: string) => Promise<void>>(),
  sortClearKey: vi.fn(async () => {}),
  sortUndoLast: vi.fn<() => Promise<string[]>>(),
  openKeyConsole: vi.fn(async () => {}),
}));
vi.mock("@/lib/sort", async (orig) => ({ ...(await orig<typeof import("@/lib/sort")>()), ...api }));

const status = { lastRunAt: new Date(Date.now() - 120_000).toISOString(), movedToday: 5, keptToday: 2, lastRun: { considered: 3, moved: 2, kept: 1, roomsCreated: 0 }, keyRejected: false, error: null };

async function show(state: SortState | null) {
  api.sortState.mockResolvedValue(state);
  await act(async () => {
    render(<SortBar />);
  });
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SortBar", () => {
  it("renders nothing outside the app", async () => {
    await show(null);
    expect(screen.queryByTestId("sort-bar")).toBeNull();
  });

  it("asks for a key, saves it, and shows TypeSafe's refusal", async () => {
    await show({ keySource: "none", keyRejected: false, status: null });
    expect(screen.getByRole("heading", { name: /Sort the inbox automatically/ })).toBeInTheDocument();
    expect(screen.getByText(/first 2,000 characters go to TypeSafe/)).toBeInTheDocument();
    api.sortSetKey.mockRejectedValueOnce(new Error("TypeSafe didn't accept this key. Copy it again from the console."));
    fireEvent.change(screen.getByLabelText("TypeSafe API key"), { target: { value: " bad " } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Turn on" })));
    expect(api.sortSetKey).toHaveBeenCalledWith(" bad ");
    expect(screen.getByRole("alert")).toHaveTextContent("didn't accept");
    api.sortSetKey.mockResolvedValueOnce();
    api.sortState.mockResolvedValue({ keySource: "keychain", keyRejected: false, status });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Turn on" })));
    expect(screen.getByText("Auto-sort is on")).toBeInTheDocument();
    expect(screen.getByText("5 moved today, 2 left here · 2 min ago")).toBeInTheDocument();
  });

  it("collapses to one button after Not now, and remembers it", async () => {
    await show({ keySource: "none", keyRejected: false, status: null });
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("heading")).toBeNull();
    cleanup();
    await show({ keySource: "none", keyRejected: false, status: null });
    fireEvent.click(screen.getByRole("button", { name: /Auto-sort the inbox/ }));
    expect(screen.getByRole("heading", { name: /Sort the inbox automatically/ })).toBeInTheDocument();
  });

  it("undoes the last sort and removes a Keychain key; an env key cannot be removed here", async () => {
    await show({ keySource: "keychain", keyRejected: false, status });
    api.sortUndoLast.mockResolvedValueOnce(["back to inbox: a.html", "back to inbox: b.html", "removed empty room \"x\""]);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Undo last sort" })));
    expect(screen.getByText("Moved 2 artifacts back. They stay here from now on.")).toBeInTheDocument();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Remove key" })));
    expect(api.sortClearKey).toHaveBeenCalled();
    cleanup();
    await show({ keySource: "env", keyRejected: false, status });
    expect(screen.getByText("Using TYPESAFE_API_KEY")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove key" })).toBeNull();
  });

  it("asks for a new key when the saved one is refused", async () => {
    await show({ keySource: "keychain", keyRejected: true, status });
    expect(screen.getByRole("heading", { name: /stopped accepting your key/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Not now" })).toBeNull();
  });
});

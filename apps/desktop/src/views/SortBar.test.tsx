import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SortState } from "@/lib/sort";
import { renderWithStores } from "@/test/fakes";
import { AutoSortSettings } from "./AutoSortSettings";
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

async function show(ui: React.ReactNode, state: SortState | null) {
  api.sortState.mockResolvedValue(state);
  const h = await renderWithStores(ui);
  await act(async () => {}); // the first sortState answer
  return h;
}
const settings = (state: SortState | null) => show(<AutoSortSettings />, state);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Settings › Auto-sort", () => {
  it("renders nothing outside the app", async () => {
    await settings(null);
    expect(screen.queryByRole("region", { name: "Auto-sort" })).toBeNull();
  });

  it("without a key: a field, Save and Get a key; a refused key shows why, a good one is saved", async () => {
    await settings({ keySource: "none", keyRejected: false, status: null });
    expect(screen.getByRole("region", { name: "Auto-sort" })).toHaveTextContent("first 2,000 characters");
    expect(screen.queryByText("Last sort")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Get a key" }));
    expect(api.openKeyConsole).toHaveBeenCalled();
    api.sortSetKey.mockRejectedValueOnce(new Error("TypeSafe didn't accept this key. Copy it again from the console."));
    fireEvent.change(screen.getByLabelText("TypeSafe API key"), { target: { value: " bad " } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
    expect(api.sortSetKey).toHaveBeenCalledWith(" bad ");
    expect(screen.getByRole("alert")).toHaveTextContent("didn't accept");
    api.sortSetKey.mockResolvedValueOnce();
    api.sortState.mockResolvedValue({ keySource: "keychain", keyRejected: false, status: null });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
    expect(screen.getByText("Key saved. Sorting the inbox now.")).toBeInTheDocument();
    expect(screen.getByText(/In your Keychain/)).toBeInTheDocument();
    expect(screen.getByText("The first sort runs within a minute.")).toBeInTheDocument();
  });

  it("a Keychain key is masked and can be changed, cancelled or removed; the last run can be undone", async () => {
    await settings({ keySource: "keychain", keyRejected: false, status });
    expect(screen.getByText(/In your Keychain/)).toHaveTextContent(/^•+ · In your Keychain$/);
    expect(screen.queryByLabelText("TypeSafe API key")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    expect(screen.getByLabelText("TypeSafe API key")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("TypeSafe API key")).toBeNull();

    expect(screen.getByText(/2 min ago · 5 moved today, 2 left in the inbox/)).toBeInTheDocument();
    api.sortUndoLast.mockResolvedValueOnce(["back to inbox: a.html", "back to inbox: b.html", 'removed empty room "x"']);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Undo last sort" })));
    expect(screen.getByText("Moved 2 artifacts back. They stay in the inbox from now on.")).toBeInTheDocument();

    api.sortState.mockResolvedValue({ keySource: "none", keyRejected: false, status });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Remove" })));
    expect(api.sortClearKey).toHaveBeenCalled();
    expect(screen.getByLabelText("TypeSafe API key")).toBeInTheDocument();
  });

  it("an environment key cannot be removed here, and says why", async () => {
    await settings({ keySource: "env", keyRejected: false, status });
    expect(screen.getByText(/From TYPESAFE_API_KEY/)).toBeInTheDocument();
    const remove = screen.getByRole("button", { name: "Remove" });
    expect(remove).toBeDisabled();
    expect(remove).toHaveAccessibleDescription(/app's environment/);
    expect(screen.queryByRole("button", { name: "Change" })).toBeNull();
  });

  it("a refused Keychain key opens straight to the field; a refused environment key only says so", async () => {
    await settings({ keySource: "keychain", keyRejected: true, status });
    expect(screen.getByText("TypeSafe stopped accepting this key.")).toBeInTheDocument();
    expect(screen.getByLabelText("TypeSafe API key")).toBeInTheDocument();
    cleanup();
    await settings({ keySource: "env", keyRejected: true, status });
    expect(screen.getByText(/TypeSafe refused TYPESAFE_API_KEY/)).toBeInTheDocument();
    expect(screen.queryByLabelText("TypeSafe API key")).toBeNull();
  });
});

describe("SortBar above the inbox", () => {
  it("renders nothing outside the app", async () => {
    await show(<SortBar />, null);
    expect(screen.queryByTestId("sort-bar")).toBeNull();
  });

  it("is one line linking to Settings, with no key field", async () => {
    await show(<SortBar />, { keySource: "keychain", keyRejected: false, status });
    expect(screen.getByTestId("sort-bar")).toHaveTextContent("Auto-sort is on · 5 moved today, 2 left here · 2 min ago");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByLabelText("TypeSafe API key")).toBeNull();
    cleanup();
    await show(<SortBar />, { keySource: "none", keyRejected: false, status: null });
    expect(screen.getByRole("button", { name: "Add a key in Settings" })).toBeInTheDocument();
    cleanup();
    await show(<SortBar />, { keySource: "keychain", keyRejected: true, status });
    expect(screen.getByText("TypeSafe refused the auto-sort key")).toHaveClass("text-error");
  });

  it("its link opens Settings at Auto-sort", async () => {
    const h = await show(<SortBar />, { keySource: "none", keyRejected: false, status: null });
    fireEvent.click(screen.getByRole("button", { name: "Add a key in Settings" }));
    const { tabs, activeId } = h.viewer.getState();
    expect(tabs.find((t) => t.id === activeId)?.kind).toBe("settings");
  });
});

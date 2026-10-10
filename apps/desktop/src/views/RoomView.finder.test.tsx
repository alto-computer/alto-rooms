import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Toaster } from "@/components/ui/sonner";
import { renderWithStores, room } from "@/test/fakes";
import { RoomView } from "./RoomView";

const native = vi.hoisted(() => ({ showInFinder: vi.fn<(path: string) => Promise<void>>() }));
vi.mock("@/lib/tauri", () => ({ isTauri: () => true }));
vi.mock("@/lib/native", async (orig) => ({ ...(await orig<typeof import("@/lib/native")>()), showInFinder: native.showInFinder }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Room: Show in Finder", () => {
  it("toasts when Finder can't show the folder", async () => {
    native.showInFinder.mockRejectedValue(new Error("No such file"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await renderWithStores(<><RoomView roomId="r1" /><Toaster /></>, { rooms: [room("r1", "R")], artifacts: { r1: [] } });
    fireEvent.click(await screen.findByRole("button", { name: "Show in Finder" }));
    expect(await screen.findByText("Couldn't show the folder in Finder")).toBeInTheDocument();
    expect(native.showInFinder).toHaveBeenCalled();
  });
});

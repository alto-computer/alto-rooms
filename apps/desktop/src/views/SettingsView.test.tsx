import { act, cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SortState } from "@/lib/sort";
import { openSettings } from "@/lib/settings";
import { ViewerStore } from "@/data/viewerStore";
import { renderWithStores } from "@/test/fakes";
import { SettingsView } from "./SettingsView";

const api = vi.hoisted(() => ({ sortState: vi.fn<() => Promise<SortState | null>>() }));
vi.mock("@/lib/sort", async (orig) => ({ ...(await orig<typeof import("@/lib/sort")>()), ...api }));

/** ResizeObservers the view made; `resize()` tells them all their target changed size. */
const observers: ResizeObserverCallback[] = [];
const resize = () => act(() => observers.forEach((cb) => cb([], {} as ResizeObserver)));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  observers.length = 0;
});

describe("SettingsView", () => {
  it("lands a section jump on a fresh tab once that section has loaded", async () => {
    vi.stubGlobal("ResizeObserver", class {
      constructor(cb: ResizeObserverCallback) { observers.push(cb); }
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    let answer!: (s: SortState) => void;
    api.sortState.mockReturnValue(new Promise((r) => (answer = r)));
    const scrolled: string[] = [];
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) { scrolled.push(this.id); });
    const viewer = new ViewerStore({ getItem: () => null, setItem: () => {} });
    openSettings(viewer, "auto-sort");
    await renderWithStores(<SettingsView />, { viewer });
    expect(screen.queryByRole("region", { name: "Auto-sort" })).toBeNull();
    await act(async () => answer({ keySource: "none", keyRejected: false, status: null }));
    resize();
    expect(screen.getByRole("region", { name: "Auto-sort" })).toBeTruthy();
    expect(scrolled.at(-1)).toBe("settings-auto-sort");
  });
});

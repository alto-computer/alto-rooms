import { afterEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ on: false, setTheme: vi.fn(async (_theme: string | null) => {}) }));
vi.mock("./tauri", () => ({ isTauri: () => tauri.on }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setTheme: tauri.setTheme }) }));

import { applyAppearance, DARK_QUERY } from "./appearance";

/** A `prefers-color-scheme: dark` query whose answer the test flips, like macOS switching. */
function fakeScheme(dark: boolean) {
  const listeners = new Set<() => void>();
  const media = {
    get matches() {
      return dark;
    },
    media: DARK_QUERY,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  vi.spyOn(window, "matchMedia").mockImplementation(() => media as unknown as MediaQueryList);
  return {
    listeners,
    set(next: boolean) {
      dark = next;
      for (const fn of [...listeners]) fn();
    },
  };
}

const isDark = () => document.documentElement.classList.contains("dark");

afterEach(() => {
  vi.restoreAllMocks();
  tauri.on = false;
  tauri.setTheme.mockClear();
  document.documentElement.classList.remove("dark");
});

describe("applyAppearance", () => {
  it("System follows macOS as it changes, and stops listening on cleanup", () => {
    const scheme = fakeScheme(false);
    const stop = applyAppearance("system");
    expect(isDark()).toBe(false);
    scheme.set(true);
    expect(isDark()).toBe(true);
    scheme.set(false);
    expect(isDark()).toBe(false);
    stop();
    expect(scheme.listeners.size).toBe(0);
    scheme.set(true);
    expect(isDark()).toBe(false);
  });

  it("Light and Dark hold whatever macOS does", () => {
    const scheme = fakeScheme(true);
    applyAppearance("light");
    expect(isDark()).toBe(false);
    scheme.set(false);
    applyAppearance("dark");
    expect(isDark()).toBe(true);
    scheme.set(false);
    expect(isDark()).toBe(true);
  });

  it("sets the Tauri window theme, and un-forces it for System", async () => {
    fakeScheme(false);
    tauri.on = true;
    applyAppearance("dark");
    applyAppearance("system");
    applyAppearance("light");
    await vi.waitFor(() => expect(tauri.setTheme.mock.calls).toEqual([["dark"], [null], ["light"]]));
  });

  it("leaves the window alone outside Tauri", async () => {
    fakeScheme(false);
    applyAppearance("dark");
    await Promise.resolve();
    expect(tauri.setTheme).not.toHaveBeenCalled();
  });
});

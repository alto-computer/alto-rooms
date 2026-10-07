import { StrictMode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_LOADING, resetLoadSlots, useLoadSlot } from "./loadSlots";

const loaders: Record<string, () => void> = {};
function Frame({ id, want = true }: { id: string; want?: boolean }) {
  const slot = useLoadSlot(want);
  loaders[id] = slot.loaded;
  return <span data-testid={id}>{slot.granted ? "loading" : "waiting"}</span>;
}

afterEach(() => {
  cleanup();
  resetLoadSlots();
  vi.useRealTimers();
});

const states = (n: number, get: (id: string) => HTMLElement) => Array.from({ length: n }, (_, i) => get(`f${i}`).textContent);

describe("useLoadSlot", () => {
  it("lets a few load at once; a load, a leaving frame or a timeout frees a slot for the next", () => {
    vi.useFakeTimers();
    const n = MAX_LOADING + 3;
    const ui = (gone = -1) => (
      <>
        {Array.from({ length: n }, (_, i) => (
          <Frame key={i} id={`f${i}`} want={i !== gone} />
        ))}
      </>
    );
    const r = render(ui());
    expect(states(n, r.getByTestId).filter((s) => s === "loading")).toHaveLength(MAX_LOADING);
    act(() => loaders.f0());
    expect(r.getByTestId(`f${MAX_LOADING}`).textContent).toBe("loading");
    expect(r.getByTestId("f0").textContent).toBe("loading"); // a loaded frame stays
    r.rerender(ui(1)); // f1 scrolls away while loading
    expect(r.getByTestId(`f${MAX_LOADING + 1}`).textContent).toBe("loading");
    act(() => vi.advanceTimersByTime(5000)); // the rest never report a load
    expect(r.getByTestId(`f${MAX_LOADING + 2}`).textContent).toBe("loading");
  });

  it("keeps the cap under StrictMode's mount, unmount, mount", () => {
    const n = MAX_LOADING + 4;
    const r = render(
      <StrictMode>
        {Array.from({ length: n }, (_, i) => (
          <Frame key={i} id={`f${i}`} />
        ))}
      </StrictMode>,
    );
    expect(states(n, r.getByTestId).filter((s) => s === "loading")).toHaveLength(MAX_LOADING);
  });
});

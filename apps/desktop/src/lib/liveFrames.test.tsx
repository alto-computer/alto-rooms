import { useRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_LIVE, resetLiveFrames, useLiveFrame } from "./liveFrames";

/** Ids whose box is inside the viewport. */
let shown = new Set<string>();

function Frame({ id, near = true }: { id: string; near?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const live = useLiveFrame(ref, near);
  return (
    <div ref={ref} data-testid={id} data-id={id}>
      {live ? "live" : "off"}
    </div>
  );
}

const rect = (top: number) => ({ top, bottom: top + 10, left: 0, right: 10, width: 10, height: 10, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;

afterEach(() => {
  cleanup();
  resetLiveFrames();
  shown = new Set();
  vi.restoreAllMocks();
});

function stubBoxes() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return rect(shown.has(this.dataset.id ?? "") ? 10 : -1000);
  });
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => `f${i}`);
const states = (n: number, get: (id: string) => HTMLElement) => ids(n).map((id) => get(id).textContent);

describe("useLiveFrame", () => {
  it("keeps at most MAX_LIVE off-screen previews, dropping the ones that came near first", () => {
    stubBoxes();
    const n = MAX_LIVE + 3;
    const r = render(
      <>
        {ids(n).map((id) => (
          <Frame key={id} id={id} />
        ))}
      </>,
    );
    expect(states(n, r.getByTestId)).toEqual([...Array(3).fill("off"), ...Array(MAX_LIVE).fill("live")]);
  });

  it("never drops a preview on screen, even past the budget", () => {
    const n = MAX_LIVE + 3;
    shown = new Set(ids(n));
    stubBoxes();
    const r = render(
      <>
        {ids(n).map((id) => (
          <Frame key={id} id={id} />
        ))}
      </>,
    );
    expect(states(n, r.getByTestId).every((s) => s === "live")).toBe(true);
  });

  it("brings a dropped preview back when it scrolls on screen, dropping an off-screen one instead", () => {
    stubBoxes();
    const n = MAX_LIVE + 1;
    const r = render(
      <>
        {ids(n).map((id) => (
          <Frame key={id} id={id} />
        ))}
      </>,
    );
    expect(r.getByTestId("f0").textContent).toBe("off");
    shown = new Set(["f0"]);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 1;
    });
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(r.getByTestId("f0").textContent).toBe("live");
    expect(r.getByTestId("f1").textContent).toBe("off");
  });

  it("frees its place when it leaves", () => {
    stubBoxes();
    const n = MAX_LIVE + 1;
    const ui = (gone: string) => (
      <>
        {ids(n).map((id) => (
          <Frame key={id} id={id} near={id !== gone} />
        ))}
      </>
    );
    const r = render(ui(""));
    r.rerender(ui("f5"));
    // f0 stays dropped (nothing brings it back until it is on screen), but the count is under budget.
    expect(states(n, r.getByTestId).filter((s) => s === "live")).toHaveLength(MAX_LIVE - 1);
  });
});

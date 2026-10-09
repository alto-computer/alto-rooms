import { useRef } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStickToBottom } from "./useStickToBottom";

/** A fake scroll box: jsdom has no layout, so heights come from `box`. */
const box = { scrollHeight: 1000, clientHeight: 200 };
const scrollTo = vi.fn();

function Sheet({ shown, items, anchor }: { shown: boolean; items: number; anchor?: () => Element | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const { away, toBottom } = useStickToBottom(ref, [shown, items], anchor);
  return shown ? (
    <>
      <div ref={ref} data-testid="sheet" />
      {away ? <button onClick={toBottom}>Latest</button> : null}
    </>
  ) : null;
}

/** The user scrolls the sheet to `top`. */
function scrollUserTo(top: number) {
  const el = screen.getByTestId("sheet");
  el.scrollTop = top;
  fireEvent.scroll(el);
}

describe("useStickToBottom", () => {
  beforeEach(() => {
    box.scrollHeight = 1000;
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => box.scrollHeight);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => box.clientHeight);
    vi.spyOn(Element.prototype, "scrollTo").mockImplementation(scrollTo);
  });
  afterEach(() => {
    cleanup();
    scrollTo.mockReset();
    vi.restoreAllMocks();
  });

  it("goes to the bottom smoothly when the sheet mounts", () => {
    render(<Sheet shown items={1} />);
    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: "smooth" });
  });

  it("follows a new turn when the user was near the bottom", () => {
    const { rerender } = render(<Sheet shown items={1} />);
    scrollUserTo(760); // 40px from the bottom
    scrollTo.mockClear();
    box.scrollHeight = 1400;
    rerender(<Sheet shown items={2} />);
    expect(scrollTo).toHaveBeenCalledWith({ top: 1400, behavior: "smooth" });
  });

  it("doesn't yank a user who scrolled up to read", () => {
    const { rerender } = render(<Sheet shown items={1} />);
    scrollUserTo(800);
    scrollUserTo(300);
    scrollTo.mockClear();
    box.scrollHeight = 1400;
    rerender(<Sheet shown items={2} />);
    expect(scrollTo).not.toHaveBeenCalled();

    scrollUserTo(1180); // back near the bottom: pinned again
    box.scrollHeight = 1800;
    rerender(<Sheet shown items={3} />);
    expect(scrollTo).toHaveBeenCalledWith({ top: 1800, behavior: "smooth" });
  });

  it("always goes to the bottom when the sheet unfolds, even after scrolling up", () => {
    const { rerender } = render(<Sheet shown items={1} />);
    scrollUserTo(800);
    scrollUserTo(0);
    rerender(<Sheet shown={false} items={1} />);
    scrollTo.mockClear();
    rerender(<Sheet shown items={1} />);
    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: "smooth" });
  });

  it("jumps without animation when the user prefers reduced motion", () => {
    vi.spyOn(window, "matchMedia").mockImplementation((q) => ({ matches: q.includes("reduce") }) as MediaQueryList);
    render(<Sheet shown items={1} />);
    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: "auto" });
  });

  it("scrolls the anchor to the top instead of going to the bottom, only while pinned", () => {
    const question = document.createElement("div");
    const scrollIntoView = vi.spyOn(question, "scrollIntoView").mockImplementation(() => {});
    const { rerender } = render(<Sheet shown items={1} />);
    scrollTo.mockClear();
    rerender(<Sheet shown items={2} anchor={() => question} />);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start", behavior: "smooth" });
    expect(scrollTo).not.toHaveBeenCalled();

    scrollUserTo(800);
    scrollUserTo(300);
    scrollIntoView.mockClear();
    rerender(<Sheet shown items={3} anchor={() => question} />);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("scrolls the anchor into view without animation when the user prefers reduced motion", () => {
    vi.spyOn(window, "matchMedia").mockImplementation((q) => ({ matches: q.includes("reduce") }) as MediaQueryList);
    const question = document.createElement("div");
    const scrollIntoView = vi.spyOn(question, "scrollIntoView").mockImplementation(() => {});
    const { rerender } = render(<Sheet shown items={1} />);
    rerender(<Sheet shown items={2} anchor={() => question} />);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start", behavior: "auto" });
  });

  it("goes to the bottom as usual when the anchor has nothing", () => {
    const { rerender } = render(<Sheet shown items={1} />);
    scrollTo.mockClear();
    rerender(<Sheet shown items={2} anchor={() => null} />);
    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: "smooth" });
  });

  it("says when the reader is away from the bottom; the way back pins again", () => {
    const { rerender } = render(<Sheet shown items={1} />);
    expect(screen.queryByText("Latest")).toBeNull();
    scrollUserTo(300);
    fireEvent.click(screen.getByText("Latest"));
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 1000, behavior: "smooth" });
    scrollTo.mockClear();
    box.scrollHeight = 1400;
    rerender(<Sheet shown items={2} />);
    expect(scrollTo).toHaveBeenCalledWith({ top: 1400, behavior: "smooth" });
    scrollUserTo(1200);
    expect(screen.queryByText("Latest")).toBeNull();
  });
});

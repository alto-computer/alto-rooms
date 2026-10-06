import { useRef } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStickToBottom } from "./useStickToBottom";

/** A fake scroll box: jsdom has no layout, so heights come from `box`. */
const box = { scrollHeight: 1000, clientHeight: 200 };
const scrollTo = vi.fn();

function Sheet({ shown, items }: { shown: boolean; items: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useStickToBottom(ref, [shown, items]);
  return shown ? <div ref={ref} data-testid="sheet" /> : null;
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
});

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThinkingLine } from "./ThinkingLine";

describe("ThinkingLine", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows Thinking with a live elapsed counter, no image", () => {
    vi.useFakeTimers();
    const { container } = render(<ThinkingLine startedAt={new Date().toISOString()} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("Thinking(0s · esc to interrupt)");
    act(() => vi.advanceTimersByTime(2000));
    expect(container.textContent).toBe("Thinking(2s · esc to interrupt)");
  });
});

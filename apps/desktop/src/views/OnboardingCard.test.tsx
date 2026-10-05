import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithStores, room } from "@/test/fakes";
import { OnboardingCard, onboardPrompt, onboardPromptPath } from "./OnboardingCard";

afterEach(cleanup);

describe("onboardPromptPath", () => {
  it("uses ~/rooms only for /Users/<name>/rooms or /home/<name>/rooms", () => {
    expect(onboardPromptPath("/Users/me/rooms")).toBe("~/rooms/ONBOARD.md");
    expect(onboardPromptPath("/home/me/rooms")).toBe("~/rooms/ONBOARD.md");
    expect(onboardPrompt("/Users/me/rooms")).toBe("~/rooms/ONBOARD.md 를 읽고 따라 해줘");
  });

  it("is absolute everywhere else", () => {
    expect(onboardPrompt("/Users/me/work/rooms")).toBe("/Users/me/work/rooms/ONBOARD.md 를 읽고 따라 해줘");
    expect(onboardPromptPath("/opt/rooms")).toBe("/opt/rooms/ONBOARD.md");
    expect(onboardPromptPath("/Users/me/agent-rooms")).toBe("/Users/me/agent-rooms/ONBOARD.md");
    expect(onboardPromptPath("/Users/rooms")).toBe("/Users/rooms/ONBOARD.md");
  });
});

describe("OnboardingCard compact", () => {
  const render = (home = "/Users/me/rooms") =>
    renderWithStores(<OnboardingCard compact />, { home, rooms: [room("inbox", "Inbox"), room("a", "가")] });

  it("offers the full ONBOARD prompt under 처음이거나 다른 에이전트라면, then rooms 정리해줘 under 스킬이 이미 있으면", async () => {
    await render();
    const first = screen.getByText("처음이거나 다른 에이전트라면");
    const second = screen.getByText("스킬이 이미 있으면");
    for (const label of [first, second]) expect(label).toHaveClass("text-[13px]", "text-[#929292]");
    const full = screen.getByRole("button", { name: "~/rooms/ONBOARD.md 를 읽고 따라 해줘" });
    const short = screen.getByRole("button", { name: "rooms 정리해줘" });
    const order = [first, full, second, short];
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("the first chip uses the absolute path for a non-standard home and copies it", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await render("/opt/rooms");
    const line = "/opt/rooms/ONBOARD.md 를 읽고 따라 해줘";
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: line }));
    });
    expect(writeText).toHaveBeenCalledWith(line);
  });

  it("the second chip copies rooms 정리해줘", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await render();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "rooms 정리해줘" }));
    });
    expect(writeText).toHaveBeenCalledWith("rooms 정리해줘");
  });
});

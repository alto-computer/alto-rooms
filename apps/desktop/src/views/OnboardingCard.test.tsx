import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithStores, room } from "@/test/fakes";
import { EXAMPLE_PROMPTS, OnboardingCard, onboardPrompt, onboardPromptPath } from "./OnboardingCard";

afterEach(cleanup);

describe("onboardPromptPath", () => {
  it("uses ~/rooms only for /Users/<name>/rooms or /home/<name>/rooms", () => {
    expect(onboardPromptPath("/Users/me/rooms")).toBe("~/rooms/ONBOARD.md");
    expect(onboardPromptPath("/home/me/rooms")).toBe("~/rooms/ONBOARD.md");
    expect(onboardPrompt("/Users/me/rooms")).toBe("Read ~/rooms/ONBOARD.md and follow it.");
  });

  it("is absolute everywhere else", () => {
    expect(onboardPrompt("/Users/me/work/rooms")).toBe("Read /Users/me/work/rooms/ONBOARD.md and follow it.");
    expect(onboardPromptPath("/opt/rooms")).toBe("/opt/rooms/ONBOARD.md");
    expect(onboardPromptPath("/Users/me/agent-rooms")).toBe("/Users/me/agent-rooms/ONBOARD.md");
    expect(onboardPromptPath("/Users/rooms")).toBe("/Users/rooms/ONBOARD.md");
  });
});

describe("OnboardingCard full (welcome page)", () => {
  const PROMPT = "Read ~/rooms/ONBOARD.md and follow it.";
  const EXAMPLES = [
    "Turn this result into an HTML report and put it in the right room",
    "Sort my rooms again, going back 30 days",
    "Turn today's conversation into an HTML review and put it in today's Journal",
  ];
  const render = (opts: { home?: string; readOnly?: boolean } = {}) =>
    renderWithStores(<OnboardingCard />, { home: opts.home ?? "/Users/me/rooms", readOnly: opts.readOnly, rooms: [room("inbox", "Inbox")] });
  const clipboard = (writeText: (t: string) => Promise<void> = async () => {}) => {
    const fn = vi.fn(writeText);
    Object.defineProperty(navigator, "clipboard", { value: { writeText: fn }, configurable: true });
    return fn;
  };
  const text = (s: string) => screen.getByText((_, el) => el?.textContent === s && !Array.from(el.children).some((c) => c.textContent === s));

  afterEach(() => vi.useRealTimers());

  it("shows the exact copy, in order", async () => {
    await render();
    expect(screen.getByRole("heading", { level: 1, name: "Welcome to Rooms" })).toHaveClass("text-display", "font-medium", "tracking-[-0.01em]");
    expect(screen.getByText("Rooms gathers the HTML your agents write into topic rooms.")).toHaveClass("text-heading", "text-ink-2");
    const h2s = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(h2s).toEqual(["Get started", "Good to know", "Try telling your agent"]);
    expect(screen.getByTestId("welcome-prompt")).toHaveTextContent(PROMPT);
    expect(screen.getByTestId("welcome-copy")).toHaveTextContent(/^Copy$/);
    expect(
      screen.getByText(
        "Paste this into Claude Code or Codex. Your agent finds the HTML it wrote in the last 14 days and sorts it into topic rooms. It only adds links; your files stay where they are.",
      ),
    ).toBeInTheDocument();
    for (const name of ["Rooms", "Journal", "inbox"]) expect(screen.getByText(name, { selector: "p" })).toHaveClass("text-lead", "font-medium");
    expect(text("One folder per topic. Any HTML in ~/rooms/<room>/ becomes a card right away.")).toBeInTheDocument();
    expect(screen.getByText("~/rooms/<room>/")).toHaveClass("font-mono");
    expect(screen.getByText("Each day's docs, next to your own plan and review notes.")).toBeInTheDocument();
    expect(screen.getByText("Docs without a room wait here. Drag one onto a room on the left to move it.")).toBeInTheDocument();
    expect(screen.getAllByTestId("example-card").map((c) => c.textContent)).toEqual(EXAMPLES);
    expect(EXAMPLE_PROMPTS.map((e) => e.text)).toEqual(EXAMPLES);
    expect(screen.getByText("Tip")).toBeInTheDocument();
    expect(
      screen.getByText("⌘K finds rooms and docs. ⌘B hides the sidebar. Hover a card and press ↗ to open it in a new tab."),
    ).toHaveClass("text-body", "text-ink");
  });

  it("복사 is the single thread-deep action; chip and button are labelled Copy prompt", async () => {
    await render();
    const targets = screen.getAllByRole("button", { name: "Copy prompt" });
    expect(targets).toEqual([screen.getByTestId("welcome-prompt"), screen.getByTestId("welcome-copy")]);
    expect(screen.getByTestId("welcome-copy")).toHaveClass("bg-thread-deep", "text-on-thread", "h-10");
    expect(document.querySelectorAll('[class*="thread-deep"]')).toHaveLength(1);
  });

  it("복사 copies the prompt and flips to Copied for 1.5s", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const writeText = clipboard();
    await render();
    const button = screen.getByTestId("welcome-copy");
    await act(async () => {
      fireEvent.click(button);
    });
    expect(writeText).toHaveBeenCalledWith(PROMPT);
    expect(button).toHaveTextContent(/^Copied$/);
    act(() => vi.advanceTimersByTime(1000));
    expect(button).toHaveTextContent(/^Copied$/);
    act(() => vi.advanceTimersByTime(500));
    expect(button).toHaveTextContent(/^Copy$/);
  });

  it("clicking the chip also copies the prompt (absolute path off ~/rooms)", async () => {
    const writeText = clipboard();
    await render({ home: "/opt/rooms" });
    await act(async () => {
      fireEvent.click(screen.getByTestId("welcome-prompt"));
    });
    expect(writeText).toHaveBeenCalledWith("Read /opt/rooms/ONBOARD.md and follow it.");
    expect(screen.getByTestId("welcome-copy")).toHaveTextContent("Copied");
  });

  it("a refused clipboard shows Something went wrong and keeps 복사", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    clipboard(async () => {
      throw new Error("denied");
    });
    await render();
    await act(async () => {
      fireEvent.click(screen.getByTestId("welcome-copy"));
    });
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByTestId("welcome-copy")).toHaveTextContent(/^Copy$/);
    vi.mocked(console.warn).mockRestore();
  });

  it.each(EXAMPLES)("the example card copies its own text: %s", async (example) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const writeText = clipboard();
    await render();
    const card = screen.getByRole("button", { name: `Copy example: ${example}` });
    await act(async () => {
      fireEvent.click(card);
    });
    expect(writeText).toHaveBeenCalledExactlyOnceWith(example);
    expect(within(card).getByRole("status")).toHaveTextContent("Copied");
    for (const other of screen.getAllByTestId("example-card").filter((c) => c !== card)) {
      expect(within(other).getByRole("status")).toBeEmptyDOMElement();
    }
    expect(screen.getByTestId("welcome-copy")).toHaveTextContent(/^Copy$/);
    act(() => vi.advanceTimersByTime(1500));
    expect(within(card).getByRole("status")).toBeEmptyDOMElement();
  });

  it("example cards tilt -2, +1.5, -1 deg only when wide, straighten on hover, and skip transitions under reduced motion", async () => {
    await render();
    const cards = screen.getAllByTestId("example-card");
    ["rotate-[-2deg]", "rotate-[1.5deg]", "rotate-[-1deg]"].forEach((r, i) => {
      expect(cards[i]).toHaveClass(`@min-[720px]:${r}`, "@min-[720px]:hover:rotate-0", "shadow-float", "motion-reduce:transition-none");
      expect(cards[i].className).not.toMatch(/(^|\s)rotate-/);
    });
  });

  it("read-only mode still shows the page, and copying works", async () => {
    const writeText = clipboard();
    await render({ readOnly: true });
    expect(screen.getByRole("heading", { level: 1, name: "Welcome to Rooms" })).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: `Copy example: ${EXAMPLES[1]}` }));
    });
    expect(writeText).toHaveBeenCalledWith(EXAMPLES[1]);
  });

});

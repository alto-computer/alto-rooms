import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithStores, room } from "@/test/fakes";
import { EXAMPLE_PROMPTS, OnboardingCard, onboardPrompt, onboardPromptPath } from "./OnboardingCard";

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

describe("OnboardingCard full (welcome page)", () => {
  const PROMPT = "~/rooms/ONBOARD.md 를 읽고 따라 해줘";
  const EXAMPLES = [
    "이번 결과를 HTML 리포트로 만들어서 알맞은 방에 넣어줘",
    "rooms 다시 정리해줘. 30일치로",
    "오늘 대화를 복습용 HTML로 만들어서 오늘 Journal에 넣어줘",
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
    expect(screen.getByRole("heading", { level: 1, name: "Rooms에 오신 걸 환영해요" })).toHaveClass("text-[32px]", "font-medium", "tracking-[-0.01em]");
    expect(screen.getByText("에이전트가 만든 HTML을 주제별 방에 모아 보는 곳이에요.")).toHaveClass("text-[17px]", "text-ink-2");
    const h2s = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(h2s).toEqual(["시작하기", "알아두면 좋은 것", "에이전트에게 이렇게 말해 보세요"]);
    expect(screen.getByTestId("welcome-prompt")).toHaveTextContent(PROMPT);
    expect(screen.getByTestId("welcome-copy")).toHaveTextContent(/^복사$/);
    expect(
      screen.getByText(
        "Claude Code나 Codex에 붙여넣으면, 에이전트가 최근 14일 동안 만든 HTML을 찾아 주제별 방으로 정리해요. 원본은 그대로 두고 링크만 만들어요.",
      ),
    ).toBeInTheDocument();
    for (const name of ["방", "Journal", "inbox"]) expect(screen.getByText(name, { selector: "p" })).toHaveClass("text-[15px]", "font-medium");
    expect(text("주제별 폴더예요. ~/rooms/<방>/에 HTML이 들어오면 바로 카드가 돼요.")).toBeInTheDocument();
    expect(screen.getByText("~/rooms/<방>/")).toHaveClass("font-mono");
    expect(screen.getByText("날짜별로 그날 만든 문서와 내 계획·회고 노트를 모아요.")).toBeInTheDocument();
    expect(screen.getByText("방을 못 정한 문서가 기다리는 곳. 왼쪽 방으로 끌어다 놓으면 옮겨져요.")).toBeInTheDocument();
    expect(screen.getAllByTestId("example-card").map((c) => c.textContent)).toEqual(EXAMPLES);
    expect(EXAMPLE_PROMPTS.map((e) => e.text)).toEqual(EXAMPLES);
    expect(screen.getByText("팁")).toBeInTheDocument();
    expect(
      screen.getByText("⌘K로 방과 문서를 찾고, ⌘B로 사이드바를 접어요. 카드에 마우스를 올리고 ↗를 누르면 새 탭에서 크게 열려요."),
    ).toHaveClass("text-[14px]", "text-ink");
  });

  it("복사 is the single thread-deep action; chip and button are labelled 프롬프트 복사", async () => {
    await render();
    const targets = screen.getAllByRole("button", { name: "프롬프트 복사" });
    expect(targets).toEqual([screen.getByTestId("welcome-prompt"), screen.getByTestId("welcome-copy")]);
    expect(screen.getByTestId("welcome-copy")).toHaveClass("bg-thread-deep", "text-white", "h-10");
    expect(document.querySelectorAll('[class*="thread-deep"]')).toHaveLength(1);
  });

  it("복사 copies the prompt and flips to 복사했어요 for 1.5s", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const writeText = clipboard();
    await render();
    const button = screen.getByTestId("welcome-copy");
    await act(async () => {
      fireEvent.click(button);
    });
    expect(writeText).toHaveBeenCalledWith(PROMPT);
    expect(button).toHaveTextContent(/^복사했어요$/);
    act(() => vi.advanceTimersByTime(1000));
    expect(button).toHaveTextContent(/^복사했어요$/);
    act(() => vi.advanceTimersByTime(500));
    expect(button).toHaveTextContent(/^복사$/);
  });

  it("clicking the chip also copies the prompt (absolute path off ~/rooms)", async () => {
    const writeText = clipboard();
    await render({ home: "/opt/rooms" });
    await act(async () => {
      fireEvent.click(screen.getByTestId("welcome-prompt"));
    });
    expect(writeText).toHaveBeenCalledWith("/opt/rooms/ONBOARD.md 를 읽고 따라 해줘");
    expect(screen.getByTestId("welcome-copy")).toHaveTextContent("복사했어요");
  });

  it("a refused clipboard shows 문제가 생겼어요 and keeps 복사", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    clipboard(async () => {
      throw new Error("denied");
    });
    await render();
    await act(async () => {
      fireEvent.click(screen.getByTestId("welcome-copy"));
    });
    expect(screen.getByText("문제가 생겼어요")).toBeInTheDocument();
    expect(screen.getByTestId("welcome-copy")).toHaveTextContent(/^복사$/);
    vi.mocked(console.warn).mockRestore();
  });

  it.each(EXAMPLES)("the example card copies its own text: %s", async (example) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const writeText = clipboard();
    await render();
    const card = screen.getByRole("button", { name: `예시 복사: ${example}` });
    await act(async () => {
      fireEvent.click(card);
    });
    expect(writeText).toHaveBeenCalledExactlyOnceWith(example);
    expect(within(card).getByRole("status")).toHaveTextContent("복사했어요");
    for (const other of screen.getAllByTestId("example-card").filter((c) => c !== card)) {
      expect(within(other).getByRole("status")).toBeEmptyDOMElement();
    }
    expect(screen.getByTestId("welcome-copy")).toHaveTextContent(/^복사$/);
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
    expect(screen.getByRole("heading", { level: 1, name: "Rooms에 오신 걸 환영해요" })).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: `예시 복사: ${EXAMPLES[1]}` }));
    });
    expect(writeText).toHaveBeenCalledWith(EXAMPLES[1]);
  });

  it("the compact form has none of the welcome page", async () => {
    await renderWithStores(<OnboardingCard compact />, { home: "/Users/me/rooms", rooms: [room("inbox", "Inbox"), room("a", "가")] });
    expect(screen.queryByText("Rooms에 오신 걸 환영해요")).toBeNull();
    expect(screen.queryByTestId("welcome")).toBeNull();
    expect(screen.getByText("에이전트로 다시 정리하기")).toBeInTheDocument();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([PROMPT, "rooms 정리해줘"]);
  });
});

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AnswerMarkdown } from "./AnswerMarkdown";

describe("AnswerMarkdown", () => {
  afterEach(cleanup);

  it("bolds CJK text whose emphasis closes after punctuation", () => {
    render(<AnswerMarkdown text="**턴(AskTurn)**은 질문 하나입니다" />);
    expect(screen.getByText("턴(AskTurn)").tagName).toBe("STRONG");
  });

  it("renders links and images as plain text", () => {
    const { container } = render(<AnswerMarkdown text="[문서](https://x.dev) ![그림](https://x.dev/a.png) [로컬](file:///etc) **굵게**" />);
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("문서 (https://x.dev)");
    expect(container.textContent).toContain("그림");
    expect(container.textContent).not.toContain("file://");
    expect(screen.getByText("굵게").tagName).toBe("STRONG");
  });
});

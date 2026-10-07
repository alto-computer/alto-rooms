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

  it("styles headings, inline code and code blocks so they stand apart from body text", () => {
    const { container } = render(<AnswerMarkdown text={"# Title\n\n## Section\n\nUse `p95` here.\n\n```ts\nconst a = 1;\n```\n\n> quoted"} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveClass("font-semibold", "text-[16px]");
    expect(screen.getByRole("heading", { level: 2 })).toHaveClass("font-semibold", "text-[14.5px]");
    expect(screen.getByText("p95")).toHaveClass("bg-[#f2f2f2]", "font-mono", "rounded");
    const pre = container.querySelector("pre")!;
    expect(pre).toHaveClass("bg-[#f6f6f6]", "rounded-lg", "p-3", "overflow-x-auto", "text-[12.5px]");
    expect(pre.textContent).toContain("const a = 1;");
    expect(container.querySelector("blockquote")).toHaveClass("border-l-2");
  });
});

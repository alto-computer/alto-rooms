import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    expect(pre).toHaveClass("overflow-x-auto", "text-[12.5px]");
    expect(pre.parentElement).toHaveClass("bg-[#f6f6f6]", "rounded-lg");
    expect(pre.textContent).toContain("const a = 1;");
    expect(pre.parentElement!.textContent).toContain("ts");
    expect(container.querySelector("blockquote")).toHaveClass("border-l-2");
  });

  it("renders a GFM table in a frame that scrolls sideways", () => {
    const md = "| | Before | After |\n|---|---|---|\n| **웹** | Redux `slice` | `draftStore` 하나 |\n| 데스크탑 | 자체 화면 | 같은 store |";
    const { container } = render(<AnswerMarkdown text={md} />);
    const table = container.querySelector("table")!;
    expect(table).not.toBeNull();
    expect(table.parentElement).toHaveClass("overflow-x-auto");
    expect(container.querySelectorAll("th")).toHaveLength(3);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(screen.getByText("웹").tagName).toBe("STRONG");
    expect(container.textContent).not.toContain("|---|");
  });

  it("keeps column alignment from the delimiter row", () => {
    const { container } = render(<AnswerMarkdown text={"| a | b |\n|:-:|--:|\n| 1 | 2 |"} />);
    const [c, r] = Array.from(container.querySelectorAll("td"));
    expect(c.style.textAlign).toBe("center");
    expect(r.style.textAlign).toBe("right");
  });

  it("strikes through ~~double~~ tildes but leaves a single tilde as text", () => {
    const { container } = render(<AnswerMarkdown text={"~~old~~ 1~2개, 3~4분"} />);
    expect(container.querySelectorAll("del")).toHaveLength(1);
    expect(screen.getByText("old").tagName).toBe("DEL");
    expect(container.textContent).toContain("1~2개, 3~4분");
  });

  it("shows task lists as read-only checkboxes", () => {
    const { container } = render(<AnswerMarkdown text={"- [x] done\n- [ ] todo"} />);
    const boxes = container.querySelectorAll<HTMLInputElement>("input[type=checkbox]");
    expect(Array.from(boxes).map((b) => b.checked)).toEqual([true, false]);
    expect(boxes[0]).toBeDisabled();
  });

  it("copies a code block without its trailing newline", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<AnswerMarkdown text={"```sh\nbun install\nbun run dev\n```"} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("bun install\nbun run dev"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Copy code" })).toHaveAttribute("data-copied", "true"));
  });
});

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ThinkingLine } from "./ThinkingLine";

describe("ThinkingLine", () => {
  afterEach(cleanup);

  it("shows only Thinking: no timer, no key hint, no image", () => {
    const { container } = render(<ThinkingLine />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("Thinking");
  });

  it("shows what the agent is doing in place of Thinking", () => {
    const { container } = render(<ThinkingLine label="Read · doc.html" />);
    expect(container.textContent).toBe("Read · doc.html");
  });
});

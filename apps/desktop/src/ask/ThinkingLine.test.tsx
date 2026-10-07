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
});

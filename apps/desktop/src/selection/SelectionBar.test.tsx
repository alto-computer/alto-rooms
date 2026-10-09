import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { askAction, SelectionBar } from "./SelectionBar";

afterEach(cleanup);

const rect = { x: 100, y: 200, w: 80, h: 16 };

describe("SelectionBar", () => {
  it("with Ask alone is one button over the selection's center", () => {
    const ask = vi.fn();
    render(<SelectionBar rect={rect} actions={[askAction(ask)]} />);
    const button = screen.getByRole("button", { name: "Ask" });
    expect(button).toHaveAttribute("data-selection-ask");
    expect(button.style.left).toBe("140px");
    expect(screen.queryByRole("toolbar")).toBeNull();
    fireEvent.click(button);
    expect(ask).toHaveBeenCalledOnce();
  });

  it("puts Ask first, then plugin actions, in one bar that keeps the selection on mousedown", () => {
    const mark = vi.fn();
    render(
      <SelectionBar
        rect={rect}
        actions={[askAction(() => {}), { key: "marker:mark", title: "Mark", color: "#ffd400", run: mark }, { key: "marker:note", title: "Note", run: () => {} }]}
      />,
    );
    const bar = screen.getByRole("toolbar", { name: "Selection actions" });
    expect(bar).toHaveAttribute("data-selection-ask");
    expect(Array.from(bar.querySelectorAll("button")).map((b) => b.textContent)).toEqual(["Ask", "Mark", "Note"]);
    expect(fireEvent.mouseDown(screen.getByRole("button", { name: "Mark" })), "mousedown is prevented").toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Mark" }));
    expect(mark).toHaveBeenCalledOnce();
  });

  it("goes below a selection near the top", () => {
    render(<SelectionBar rect={{ x: 10, y: 4, w: 20, h: 16 }} actions={[askAction(() => {})]} />);
    expect(screen.getByRole("button", { name: "Ask" }).style.top).toBe("28px");
  });

  it("renders nothing without actions, as under read-only with no plugin actions", () => {
    const { container } = render(<SelectionBar rect={rect} actions={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

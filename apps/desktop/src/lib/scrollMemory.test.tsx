import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { clearScrollMemory, useScrollMemory } from "./scrollMemory";

function Pane({ k, ready = true }: { k: string; ready?: boolean }) {
  const ref = useScrollMemory<HTMLDivElement>(k, ready);
  return <div data-testid="pane" ref={ref} />;
}

afterEach(() => {
  cleanup();
  clearScrollMemory();
});

describe("useScrollMemory", () => {
  it("restores the offset a remounted view had under the same key, not another key's", () => {
    const first = render(<Pane k="tab1:room:a" />);
    const pane = first.getByTestId("pane");
    pane.scrollTop = 480;
    fireEvent.scroll(pane);
    first.unmount();

    const again = render(<Pane k="tab1:room:a" />);
    expect(again.getByTestId("pane").scrollTop).toBe(480);
    again.unmount();

    const other = render(<Pane k="tab2:room:a" />);
    expect(other.getByTestId("pane").scrollTop).toBe(0);
  });

  it("restores again when the same view shows other content", () => {
    const v = render(<Pane k="journal:a" />);
    const pane = v.getByTestId("pane");
    pane.scrollTop = 200;
    fireEvent.scroll(pane);
    v.rerender(<Pane k="journal:b" />);
    expect(pane.scrollTop).toBe(0);
    pane.scrollTop = 50;
    fireEvent.scroll(pane);
    v.rerender(<Pane k="journal:a" />);
    expect(pane.scrollTop).toBe(200);
  });

  it("waits until the content is ready, and restores only once", () => {
    const a = render(<Pane k="k" />);
    a.getByTestId("pane").scrollTop = 300;
    fireEvent.scroll(a.getByTestId("pane"));
    a.unmount();

    const b = render(<Pane k="k" ready={false} />);
    const pane = b.getByTestId("pane");
    expect(pane.scrollTop).toBe(0);
    b.rerender(<Pane k="k" ready />);
    expect(pane.scrollTop).toBe(300);
    pane.scrollTop = 10;
    b.rerender(<Pane k="k" ready={false} />);
    b.rerender(<Pane k="k" ready />);
    expect(pane.scrollTop).toBe(10);
  });
});

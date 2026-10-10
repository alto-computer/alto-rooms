import { useRef } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { dimsInDark, readToneMessage, useFrameTone } from "./artifactTone";

afterEach(cleanup);

function Probe() {
  const frame = useRef<HTMLIFrameElement>(null);
  const tone = useFrameTone(frame);
  return (
    <>
      <iframe ref={frame} title="page" />
      <output>{tone ?? "unknown"}</output>
    </>
  );
}

const post = (data: unknown, source: MessageEventSource | null) => act(() => void window.dispatchEvent(new MessageEvent("message", { data, source })));

describe("artifact tone", () => {
  it("dims a light page and a page that hasn't said, never a dark one", () => {
    expect(dimsInDark("light")).toBe(true);
    expect(dimsInDark(null)).toBe(true);
    expect(dimsInDark("dark")).toBe(false);
  });

  it("reads only the bridge's tone message", () => {
    expect(readToneMessage({ roomsTone: 1, tone: "dark" })).toBe("dark");
    expect(readToneMessage({ roomsTone: 1, tone: "grey" })).toBeNull();
    expect(readToneMessage({ roomsSelection: 1, text: "x" })).toBeNull();
    expect(readToneMessage("dark")).toBeNull();
  });

  it("takes the tone from its own frame only", () => {
    render(<Probe />);
    const own = screen.getByTitle<HTMLIFrameElement>("page").contentWindow;
    expect(screen.getByRole("status")).toHaveTextContent("unknown");
    post({ roomsTone: 1, tone: "dark" }, window);
    expect(screen.getByRole("status")).toHaveTextContent("unknown");
    post({ roomsTone: 1, tone: "dark" }, own);
    expect(screen.getByRole("status")).toHaveTextContent("dark");
    post({ roomsTone: 1, tone: "light" }, own);
    expect(screen.getByRole("status")).toHaveTextContent("light");
  });
});

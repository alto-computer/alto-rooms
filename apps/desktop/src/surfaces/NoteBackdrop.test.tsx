import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import { NOTE_QUIET_MS, NoteBackdrop } from "./NoteBackdrop";
import { surfaceHub, type SurfaceId } from "./surfaceHub";

const id: SurfaceId = { kind: "note", date: "2026-10-10", name: "Plan.md" };

class FakeHighlight {
  ranges: Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}
const highlights = new Map<string, FakeHighlight>();
const painted = () => (highlights.get("rooms-tagger-amber")?.ranges ?? []).map((r) => r.toString());

/** The one ResizeObserver the backdrop makes, so a test can say the textarea's box changed. */
let resized: (() => void) | null = null;

let seat: ReturnType<typeof surfaceHub.register>;
let sent: Record<string, unknown>[];
beforeEach(() => {
  vi.useFakeTimers();
  highlights.clear();
  vi.stubGlobal("Highlight", FakeHighlight);
  vi.stubGlobal("CSS", { highlights, supports: () => true });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(cb: () => void) {
        resized = cb;
      }
      observe() {}
      disconnect() {
        resized = null;
      }
    },
  );
  sent = [];
  seat = surfaceHub.register("tagger", (m) => void sent.push(m));
});
afterEach(() => {
  seat.dispose();
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const opens = () => sent.filter((m) => m.type === "surface.open").map((m) => m.text);
const paint = (ranges: { id: string; start: number; end: number }[]) =>
  seat.receive({ rooms: "surface", v: 1, type: "paint", surface: id, styles: { amber: "#c79a3e" }, ranges: ranges.map((r) => ({ ...r, style: "amber" })) });

function Note({ text, surface = id }: { text: string; surface?: SurfaceId }) {
  const ta = useRef<HTMLTextAreaElement>(null);
  return (
    <div>
      <NoteBackdrop id={surface} text={text} textarea={ta} className="font-serif" />
      <textarea ref={ta} value={text} readOnly />
    </div>
  );
}

const backdrop = (c: HTMLElement) => c.querySelector("[data-note-backdrop]") as HTMLDivElement;
const textarea = (c: HTMLElement) => c.querySelector("textarea") as HTMLTextAreaElement;
const flush = () => act(async () => {});

describe("NoteBackdrop", () => {
  it("tells plugins the note's text at once, then once per pause while typing, and keeps the paint on its word meanwhile", async () => {
    const TEXT = "first line\nthe quick brown fox";
    const view = render(<Note text={TEXT} />);
    await flush();
    expect(opens()).toEqual([TEXT]);
    paint([{ id: "q", start: 15, end: 20 }]);
    expect(painted()).toEqual(["quick"]);
    for (const text of [`A${TEXT}`, `AB${TEXT}`, `ABC ${TEXT}`]) {
      view.rerender(<Note text={text} />);
      await flush();
      await act(async () => void vi.advanceTimersByTime(100));
      expect(painted(), text).toEqual(["quick"]);
    }
    expect(opens(), "nothing posted between keystrokes").toHaveLength(1);
    await act(async () => void vi.advanceTimersByTime(NOTE_QUIET_MS));
    expect(opens()).toEqual([TEXT, `ABC ${TEXT}`]);
    expect(backdrop(view.container).textContent, "the mirror holds the text, nothing more").toBe(`ABC ${TEXT}`);
    view.unmount();
    expect(sent.at(-1)).toMatchObject({ type: "surface.close", surface: id });
  });

  it("mirrors a file with CRLF line ends as the textarea's value reads them, so offsets agree", async () => {
    const view = render(<Note text={"one\r\ntwo\rthree\nfour"} />);
    await flush();
    expect(opens()).toEqual(["one\ntwo\nthree\nfour"]);
    expect(textarea(view.container).value, "the browser's own normalization of the value").toBe("one\ntwo\nthree\nfour");
    paint([{ id: "t", start: 8, end: 13 }]);
    expect(painted()).toEqual(["three"]);
  });

  it("drops the paint on a word the user types inside until the plugin paints again", async () => {
    const view = render(<Note text="the quick brown fox" />);
    await flush();
    paint([{ id: "q", start: 4, end: 9 }, { id: "f", start: 16, end: 19 }]);
    view.rerender(<Note text="the quiXck brown fox" />);
    await flush();
    expect(painted()).toEqual(["fox"]);
    view.rerender(<Note text="the quiXck brown" />);
    await flush();
    expect(painted(), "deleting the word takes its paint").toEqual([]);
  });

  it("follows the textarea's scroll and its content box, so the paint sits where the text wraps", async () => {
    const view = render(<Note text={"line\n".repeat(200)} />);
    await flush();
    const ta = textarea(view.container);
    const el = backdrop(view.container);
    Object.defineProperty(ta, "clientWidth", { value: 640, configurable: true });
    Object.defineProperty(ta, "clientHeight", { value: 480, configurable: true });
    await act(async () => resized?.());
    expect(el.style.width).toBe("640px");
    expect(el.style.height).toBe("480px");
    Object.defineProperty(ta, "clientWidth", { value: 625, configurable: true });
    await act(async () => resized?.());
    expect(el.style.width, "a scrollbar came: the text wraps narrower").toBe("625px");
    ta.scrollTop = 1200;
    ta.dispatchEvent(new Event("scroll"));
    expect(el.scrollTop).toBe(1200);
  });

  it("brings a revealed range into the textarea's view instead of scrolling the page", async () => {
    const view = render(<Note text={"line\n".repeat(200)} />);
    await flush();
    const ta = textarea(view.container);
    const el = backdrop(view.container);
    Object.defineProperty(ta, "clientHeight", { value: 400, configurable: true });
    el.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
    Range.prototype.getBoundingClientRect = () => ({ top: 2100 }) as DOMRect;
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    paint([{ id: "l", start: 5 * 150, end: 5 * 150 + 4 }]);
    surfaceHub.reveal(id, "l");
    expect(ta.scrollTop, "the range's top less half a view").toBe(2000 - 200);
    expect(el.scrollTop).toBe(ta.scrollTop);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("indexes a 5,000-line note on each keystroke and keeps a paint near its end in place", async () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`);
    const text = lines.join("\n");
    const view = render(<Note text={text} />);
    await flush();
    const at = text.lastIndexOf("line 4999");
    paint([{ id: "l", start: at, end: at + 9 }]);
    expect(painted()).toEqual(["line 4999"]);
    const began = performance.now();
    for (let i = 0; i < 20; i++) {
      view.rerender(<Note text={`${"x".repeat(i + 1)}\n${text}`} />);
      await flush();
    }
    const took = performance.now() - began;
    expect(painted(), "the paint moved with its line through 20 keystrokes at the top").toEqual(["line 4999"]);
    expect(opens()).toHaveLength(1);
    expect(took, `20 keystrokes took ${took.toFixed(0)} ms`).toBeLessThan(2000);
  });
});

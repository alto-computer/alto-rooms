import { act, cleanup, render } from "@testing-library/react";
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import { useTextSelection } from "@/selection/useTextSelection";
import { surfaceHub, surfaceKey, type SurfaceId } from "./surfaceHub";
import { TextSurface } from "./TextSurface";

const id: SurfaceId = { kind: "answer", scope: { kind: "doc", fileKey: "0123456789abcdef" }, turnId: "t1" };

let seat: ReturnType<typeof surfaceHub.register>;
let sent: Record<string, unknown>[];
beforeEach(() => {
  sent = [];
  seat = surfaceHub.register("tagger", (m) => void sent.push(m));
});
afterEach(() => {
  seat.dispose();
  cleanup();
});

const opens = () => sent.filter((m) => m.type === "surface.open").map((m) => m.text);

describe("TextSurface", () => {
  it("posts the text once the answer's Markdown is in, not the pending fallback, and once per text", async () => {
    const view = render(
      <TextSurface id={id}>
        <div data-answer-pending>raw *markdown*</div>
      </TextSurface>,
    );
    expect(opens()).toEqual([]);
    view.rerender(
      <TextSurface id={id}>
        <div><p>raw <em>markdown</em></p></div>
      </TextSurface>,
    );
    await act(async () => {});
    expect(opens()).toEqual(["raw markdown"]);
    view.rerender(
      <TextSurface id={id}>
        <div><p>raw <em>markdown</em></p></div>
      </TextSurface>,
    );
    await act(async () => {});
    expect(opens(), "the same text again is not posted again").toEqual(["raw markdown"]);
    view.rerender(
      <TextSurface id={id}>
        <div><p>raw <em>markdown</em>, edited</p></div>
      </TextSurface>,
    );
    await act(async () => {});
    expect(opens()).toEqual(["raw markdown", "raw markdown, edited"]);
    view.unmount();
    expect(sent.at(-1)).toMatchObject({ type: "surface.close", surface: id });
  });

  it("sends a click on a painted range to the plugin and leaves other clicks alone", async () => {
    vi.stubGlobal("Highlight", class { constructor(..._r: Range[]) {} });
    vi.stubGlobal("CSS", { highlights: new Map(), supports: () => true });
    const view = render(
      <TextSurface id={id}>
        <p>the quick brown fox</p>
      </TextSurface>,
    );
    await act(async () => {});
    seat.receive({ rooms: "surface", v: 1, type: "paint", surface: id, styles: { amber: "#c79a3e" }, ranges: [{ id: "q", start: 4, end: 9, style: "amber" }] });
    const text = view.container.querySelector("p")!.firstChild!;
    (document as unknown as { caretPositionFromPoint: unknown }).caretPositionFromPoint = (x: number) => ({ offsetNode: text, offset: x });
    const root = view.container.querySelector("[data-surface]") as HTMLElement;
    expect(root.dataset.surface).toBe(surfaceKey(id));
    root.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 1, clientY: 0 }));
    expect(sent.some((m) => m.type === "range.click")).toBe(false);
    root.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 6, clientY: 0 }));
    expect(sent.at(-1)).toMatchObject({ type: "range.click", surface: id, rangeId: "q" });
    delete (document as unknown as { caretPositionFromPoint?: unknown }).caretPositionFromPoint;
    vi.unstubAllGlobals();
  });
});

describe("useTextSelection with surfaces", () => {
  beforeEach(() => {
    Range.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: 10, height: 10 }) as DOMRect;
  });

  function select(from: Node, start: number, to: Node, end: number) {
    const r = document.createRange();
    r.setStart(from, start);
    r.setEnd(to, end);
    const s = document.getSelection()!;
    s.removeAllRanges();
    s.addRange(r);
  }

  it("names the surface and offsets for a selection inside one answer, and none for one across two", async () => {
    const t2: SurfaceId = { ...id, turnId: "t2" };
    const view = render(
      <div data-sheet>
        <TextSurface id={id}>
          <p>first answer here</p>
        </TextSurface>
        <TextSurface id={t2}>
          <p>second answer</p>
        </TextSurface>
      </div>,
    );
    await act(async () => {});
    const sheet = view.container.querySelector("[data-sheet]") as HTMLElement;
    const { result } = renderHook(() => {
      const scope = useRef<HTMLElement | null>(sheet);
      return useTextSelection(scope, scope, true, surfaceHub.locate);
    });
    const [p1, p2] = Array.from(view.container.querySelectorAll("p")).map((p) => p.firstChild!);
    select(p1, 6, p1, 12);
    await act(async () => {
      document.dispatchEvent(new Event("mouseup"));
      await new Promise((r) => setTimeout(r, 1));
    });
    expect(result.current.picked).toMatchObject({ text: "answer", span: { key: surfaceKey(id), start: 6, end: 12 } });
    select(p1, 6, p2, 6);
    await act(async () => {
      document.dispatchEvent(new Event("mouseup"));
      await new Promise((r) => setTimeout(r, 1));
    });
    expect(result.current.picked!.text).toContain("second");
    expect(result.current.picked!.span).toBeNull();
  });

  it("clamps a selection that runs past the sheet and the surface, as a triple-click does, to the surface's end", async () => {
    const view = render(
      <div>
        <div data-sheet>
          <TextSurface id={id}>
            <p>first answer here</p>
          </TextSurface>
          <div data-after>Save as note</div>
        </div>
        <div data-sr>Answer done</div>
      </div>,
    );
    await act(async () => {});
    const sheet = view.container.querySelector("[data-sheet]") as HTMLElement;
    const { result } = renderHook(() => {
      const scope = useRef<HTMLElement | null>(sheet);
      return useTextSelection(scope, scope, true, surfaceHub.locate);
    });
    const p1 = view.container.querySelector("p")!.firstChild!;
    const sr = view.container.querySelector("[data-sr]")!;
    select(p1, 0, sr, 0);
    await act(async () => {
      document.dispatchEvent(new Event("mouseup"));
      await new Promise((r) => setTimeout(r, 1));
    });
    expect(result.current.picked).toMatchObject({ text: "first answer hereSave as note", span: { key: surfaceKey(id), start: 0, end: 17 } });
    select(p1, 6, view.container.querySelector("[data-after]")!.firstChild!, 4);
    await act(async () => {
      document.dispatchEvent(new Event("mouseup"));
      await new Promise((r) => setTimeout(r, 1));
    });
    expect(result.current.picked, "a selection into the surface's trailing row still marks only the answer").toMatchObject({ text: "answer hereSave", span: { key: surfaceKey(id), start: 6, end: 17 } });
    select(sr, 0, sr, 1);
    await act(async () => {
      document.dispatchEvent(new Event("mouseup"));
      await new Promise((r) => setTimeout(r, 1));
    });
    expect(result.current.picked, "a selection wholly outside the sheet is nothing").toBeNull();
  });
});

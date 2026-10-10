import { useEffect, useState, type RefObject } from "react";
import type { SurfaceSpan } from "@/surfaces/surfaceHub";

/** Where the selection is, in px from the top-left of the box the bar is placed in. */
export type SelectionRect = { x: number; y: number; w: number; h: number };

/** The bridge's message from a doc frame: `{roomsSelection: 1, text, rect}`. Anything else is null. */
export function readSelectionMessage(data: unknown): { text: string; rect: SelectionRect | null } | null {
  if (!data || typeof data !== "object" || (data as { roomsSelection?: unknown }).roomsSelection !== 1) return null;
  const { text, rect } = data as { text?: unknown; rect?: unknown };
  if (typeof text !== "string") return null;
  const r = rect as Partial<Record<keyof SelectionRect, unknown>> | null;
  const ok = r && (["x", "y", "w", "h"] as const).every((k) => typeof r[k] === "number" && Number.isFinite(r[k]));
  return { text: text.slice(0, 4000), rect: ok ? (r as SelectionRect) : null };
}

export type PickedText = { text: string; rect: SelectionRect; span: SurfaceSpan | null };

const nowhere = () => null;

/**
 * Text selected inside `scope`, with where it is relative to `box`; null when nothing is. A
 * selection with one end outside the scope counts for the part inside it. Read on release, not
 * while dragging, so a bar over it doesn't chase the pointer. `locate` names the host text surface
 * the selection lies in, when it lies in one, and then the text is that surface's slice: a
 * triple-click on an answer runs into the row under it, and the quote must not.
 */
export function useTextSelection(
  scope: RefObject<HTMLElement | null>,
  box: RefObject<HTMLElement | null>,
  enabled: boolean,
  locate: (range: Range) => SurfaceSpan | null = nowhere,
) {
  const [picked, setPicked] = useState<PickedText | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const read = () => {
      const s = document.getSelection();
      const el = scope.current;
      const b = box.current?.getBoundingClientRect();
      if (!s || s.isCollapsed || s.rangeCount === 0 || !el || !b) return setPicked(null);
      // A triple-click or a drag can run past the scope (into a live region or the composer); what counts is the part inside it.
      const range = s.getRangeAt(0).cloneRange();
      const startIn = el.contains(range.startContainer);
      const endIn = el.contains(range.endContainer);
      if (!startIn && !endIn) return setPicked(null);
      if (!startIn) range.setStart(el, 0);
      if (!endIn) range.setEnd(el, el.childNodes.length);
      const span = locate(range);
      const text = (span ? span.text : range.toString()).trim();
      if (!text) return setPicked(null);
      const r = range.getBoundingClientRect();
      setPicked({ text, rect: { x: r.left - b.left, y: r.top - b.top, w: r.width, h: r.height }, span });
    };
    const onUp = () => setTimeout(read, 0);
    const onChange = () => {
      if (document.getSelection()?.isCollapsed) setPicked(null);
    };
    document.addEventListener("mouseup", onUp);
    document.addEventListener("keyup", onUp);
    document.addEventListener("selectionchange", onChange);
    return () => {
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("keyup", onUp);
      document.removeEventListener("selectionchange", onChange);
    };
  }, [scope, box, enabled, locate]);
  return { picked, dismiss: () => setPicked(null) };
}

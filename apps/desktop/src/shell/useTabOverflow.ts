import { useEffect, useRef, useState } from "react";
import { tabDomId } from "./tabIds";

/** The tab list counts as scrolled to an end within this many pixels. */
const EDGE_SLACK = 2;
/** Fades the side(s) of the tab list that hide more tabs. */
const FADE = {
  none: "",
  left: "[mask-image:linear-gradient(to_right,transparent,#000_32px)]",
  right: "[mask-image:linear-gradient(to_left,transparent,#000_32px)]",
  both: "[mask-image:linear-gradient(to_right,transparent,#000_32px,#000_calc(100%-32px),transparent)]",
} as const;

/**
 * Many tabs, browser style: every tab shrinks evenly (220 → 112px) before the list
 * scrolls; the list then hides its scrollbar, fades the clipped side(s), takes a
 * vertical mouse wheel as sideways scrolling, and keeps the active tab in view.
 */
export function useTabOverflow(activeId: string | null, count: number) {
  const listRef = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState<keyof typeof FADE>("none");

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const update = () => {
      const left = el.scrollLeft > EDGE_SLACK;
      const right = el.scrollWidth - el.clientWidth - el.scrollLeft > EDGE_SLACK;
      setFade(left && right ? "both" : left ? "left" : right ? "right" : "none");
    };
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || Math.abs(e.deltaY) <= Math.abs(e.deltaX) || el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: false });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      el.removeEventListener("wheel", onWheel);
      ro?.disconnect();
    };
  }, [count]);

  useEffect(() => {
    if (!activeId) return;
    document.getElementById(tabDomId(activeId))?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeId, count]);

  return { listRef, fade: FADE[fade] };
}

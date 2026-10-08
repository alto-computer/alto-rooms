import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * At most this many previews stay live (mounted) at once, wherever they are. Each live
 * preview is a whole page running its own scripts, so near-viewport preloading alone can
 * keep a dozen or more of them in memory. Previews on screen are never dropped: past the
 * budget, the one that came near longest ago and is off screen goes first.
 */
export const MAX_LIVE = 8;

type Holder = { el: HTMLElement; drop: () => void };
/** Live previews, the one that came near longest ago first. */
let holders: Holder[] = [];

/** The nearest `[data-scroll-root]`'s box, else the viewport's. */
function rootRect(el: HTMLElement): { top: number; left: number; bottom: number; right: number } {
  const root = el.closest<HTMLElement>("[data-scroll-root]");
  if (root) return root.getBoundingClientRect();
  return { top: 0, left: 0, bottom: window.innerHeight, right: window.innerWidth };
}

export function isOnScreen(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  const v = rootRect(el);
  return r.bottom > v.top && r.top < v.bottom && r.right > v.left && r.left < v.right;
}

function trim() {
  while (holders.length > MAX_LIVE) {
    const victim = holders.find((h) => !isOnScreen(h.el));
    if (!victim) return;
    holders = holders.filter((h) => h !== victim);
    victim.drop();
  }
}

/** For tests. */
export function resetLiveFrames() {
  holders = [];
}

/**
 * Whether the preview in `ref` may be live: while `near`, unless the budget dropped it
 * while it was off screen. A dropped preview comes back once it scrolls on screen.
 */
export function useLiveFrame(ref: RefObject<HTMLElement | null>, near: boolean): boolean {
  const [live, setLive] = useState(false);
  const holder = useRef<Holder | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!near || !el) {
      setLive(false);
      return;
    }
    let frame = 0;
    let unlisten = () => {};
    const join = () => {
      unlisten();
      const h: Holder = { el, drop: () => { holder.current = null; setLive(false); listen(); } };
      holder.current = h;
      holders.push(h);
      setLive(true);
      trim();
    };
    // Dropped: watch scrolling (only while dropped) for when it comes on screen.
    const listen = () => {
      const target: HTMLElement | Window = el.closest<HTMLElement>("[data-scroll-root]") ?? window;
      const onScroll = () => {
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          if (isOnScreen(el)) join();
        });
      };
      target.addEventListener("scroll", onScroll, { passive: true });
      unlisten = () => {
        target.removeEventListener("scroll", onScroll);
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        unlisten = () => {};
      };
    };
    join();
    return () => {
      unlisten();
      const h = holder.current;
      if (h) holders = holders.filter((x) => x !== h);
      holder.current = null;
      setLive(false);
    };
  }, [ref, near]);
  return near && live;
}

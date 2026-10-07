import { useLayoutEffect, useRef, type RefObject } from "react";

/** Scroll offsets by key, for this run of the app. Oldest keys go first past the cap. */
const saved = new Map<string, number>();
const CAP = 200;

function remember(key: string, top: number) {
  saved.delete(key);
  saved.set(key, top);
  if (saved.size > CAP) saved.delete(saved.keys().next().value!);
}

/**
 * Keeps an element's vertical scroll under `key`, so a view that remounts (tab switch,
 * back/forward) comes back where it was. Restores once `ready` (its content is laid out).
 */
export function useScrollMemory<T extends HTMLElement>(key: string, ready: boolean): RefObject<T | null> {
  const ref = useRef<T>(null);
  const restored = useRef(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !ready) return;
    if (!restored.current) {
      restored.current = true;
      const top = saved.get(key);
      if (top !== undefined) el.scrollTop = top;
    }
    const onScroll = () => remember(key, el.scrollTop);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [key, ready]);

  return ref;
}

/** Test seam: forget every saved offset. */
export function clearScrollMemory() {
  saved.clear();
}

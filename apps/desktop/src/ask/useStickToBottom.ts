import { useEffect, useRef, type DependencyList, type RefObject } from "react";

/** How close to the bottom (px) still counts as "reading the latest". */
export const STICK_PX = 48;

function distanceFromBottom(el: HTMLElement): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/**
 * Keeps the scroll container in `ref` at its bottom when `deps` change: always when the element
 * (re)mounts, otherwise only if the user was within STICK_PX of the bottom, so reading an older
 * turn is never interrupted. Scrolling up unpins; scrolling back near the bottom pins again.
 */
export function useStickToBottom(ref: RefObject<HTMLElement | null>, deps: DependencyList): void {
  const element = useRef<HTMLElement | null>(null);
  const pinned = useRef(true);
  const lastTop = useRef(0);

  useEffect(() => {
    const el = ref.current;
    if (el !== element.current) pinned.current = true;
    element.current = el;
    if (!el) return;
    if (pinned.current) el.scrollTo({ top: el.scrollHeight, behavior: prefersReducedMotion() ? "auto" : "smooth" });
    lastTop.current = el.scrollTop;

    // A smooth scroll toward the bottom only moves down, so only an upward move away from the bottom unpins.
    const onScroll = () => {
      if (distanceFromBottom(el) <= STICK_PX) pinned.current = true;
      else if (el.scrollTop < lastTop.current) pinned.current = false;
      lastTop.current = el.scrollTop;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, deps);
}

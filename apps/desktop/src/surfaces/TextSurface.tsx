import { useEffect, useRef, type ReactNode } from "react";
import { surfaceHub, surfaceKey, type SurfaceId } from "./surfaceHub";

/**
 * A host text surface: once its content is in (no `[data-answer-pending]` fallback left), the
 * subtree's text goes to every surface plugin, and changes to it go again. The same text twice
 * posts once. A click on a painted range is the plugin's, not the page's.
 */
export function TextSurface({ id, children }: { id: SurfaceId; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const key = surfaceKey(id);
  const latest = useRef(id);
  latest.current = id;
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let opened: string | null = null;
    const tryOpen = () => {
      if (el.querySelector("[data-answer-pending]")) return;
      const text = el.textContent ?? "";
      if (text === opened) return;
      opened = text;
      surfaceHub.open(latest.current, el);
    };
    tryOpen();
    const observer = new MutationObserver(tryOpen);
    observer.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      surfaceHub.close(key);
    };
  }, [key]);
  return (
    <div
      ref={root}
      data-surface={key}
      onClick={(e) => {
        const s = document.getSelection();
        if (s && !s.isCollapsed) return;
        if (surfaceHub.click(key, e.clientX, e.clientY)) e.preventDefault();
      }}
    >
      {children}
    </div>
  );
}

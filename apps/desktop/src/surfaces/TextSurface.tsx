import { useEffect, useRef, type ReactNode } from "react";
import { surfaceHub, surfaceKey, type SurfaceId } from "./surfaceHub";

/**
 * A host text surface: once its content is in (no `[data-answer-pending]` fallback left), the
 * subtree goes to the hub, and again on every change to it, so paint follows the nodes React
 * puts there; the hub tells plugins only when the text changed. A click on a painted range is
 * the plugin's, not the page's.
 */
export function TextSurface({ id, children }: { id: SurfaceId; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const key = surfaceKey(id);
  const latest = useRef(id);
  latest.current = id;
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const open = () => {
      if (!el.querySelector("[data-answer-pending]")) surfaceHub.open(latest.current, el);
    };
    open();
    const observer = new MutationObserver(open);
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

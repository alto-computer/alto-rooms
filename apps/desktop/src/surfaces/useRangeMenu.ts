import { useEffect, useSyncExternalStore, type RefObject } from "react";
import type { SelectionRect } from "@/selection/useTextSelection";
import { surfaceHub, type SurfaceMenu } from "./surfaceHub";

/** Where a plugin's menu goes: under the last line of its range, relative to `box`. */
export function menuRect(menu: SurfaceMenu, box: HTMLElement): SelectionRect {
  const rects = menu.range.getClientRects();
  const r = rects.length ? rects[rects.length - 1] : menu.range.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  return { x: r.left - b.left, y: r.top - b.top, w: r.width, h: r.height };
}

/** A plugin's menu over one of its painted ranges inside `scope`, until a click elsewhere or Esc. */
export function useRangeMenu(scope: RefObject<HTMLElement | null>): SurfaceMenu | null {
  const { menu } = useSyncExternalStore(surfaceHub.subscribe, surfaceHub.getSnapshot);
  const mine = menu && scope.current?.contains(menu.range.startContainer) ? menu : null;
  useEffect(() => {
    if (!mine) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest("[data-selection-ask]")) surfaceHub.closeMenu();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") surfaceHub.closeMenu();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [mine]);
  return mine;
}

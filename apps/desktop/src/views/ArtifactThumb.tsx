import { useEffect, useRef, useState, type RefObject } from "react";
import type { Artifact, Info } from "@alto-rooms/protocol-ts";
import { useClient } from "@/data/hooks";
import { dimsInDark, useFrameTone } from "@/lib/artifactTone";
import { useLiveFrame } from "@/lib/liveFrames";
import { useLoadSlot } from "@/lib/loadSlots";
import { useLingering } from "@/lib/useLingering";
import { cn } from "@/lib/utils";
import { DocSkeleton } from "./DocSkeleton";

/** Previews are laid out at this width, then scaled down to the box. */
const LAYOUT_WIDTH = 1280;
/** A preview stays loaded this long after its box scrolls out of range, so scrolling back and forth doesn't reload it. */
const UNLOAD_DELAY_MS = 2000;

/** Inner box size before it is measured, per place a preview is shown (both 16:10). */
const FALLBACK = { card: { w: 300, h: 188 }, row: { w: 104, h: 65 } } as const;

/** True while `el` is within a quarter viewport of its scroll root (the nearest `[data-scroll-root]`, else the viewport). */
function useNearViewport(ref: RefObject<HTMLElement | null>): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const root = el.closest<HTMLElement>("[data-scroll-root]");
    const io = new IntersectionObserver((entries) => setNear(entries[entries.length - 1]?.isIntersecting ?? false), {
      root,
      rootMargin: "25%",
    });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return near;
}

/** The box's inner size; `fallback` until measured. */
function useBoxSize(ref: RefObject<HTMLElement | null>, fallback: { w: number; h: number }) {
  const [size, setSize] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[entries.length - 1]?.contentRect;
      if (r && r.width > 0 && r.height > 0) setSize((s) => (s.w === r.width && s.h === r.height ? s : { w: r.width, h: r.height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/**
 * The top of an artifact, cropped to a 16:10 box: a live, sandboxed, non-interactive page laid
 * out at 1280px and scaled to the box's width. It loads only near the viewport, within the
 * live-preview budget and a load slot, and shows a skeleton until then. In dark mode a light
 * page is dimmed.
 */
export function ArtifactThumb({ artifact, info, variant, className }: { artifact: Artifact; info: Info; variant: "card" | "row"; className?: string }) {
  const client = useClient();
  const boxRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  // Near the viewport, and within the live-preview budget.
  const live = useLiveFrame(boxRef, useLingering(useNearViewport(boxRef), UNLOAD_DELAY_MS));
  const slot = useLoadSlot(live);
  // The preview unmounts when the box scrolls far away (or the budget drops it), so loading starts over then.
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!live) setLoaded(false);
  }, [live]);
  const tone = useFrameTone(frameRef);
  const box = useBoxSize(boxRef, FALLBACK[variant]);
  const scale = box.w / LAYOUT_WIDTH;

  return (
    <div
      ref={boxRef}
      data-testid="artifact-thumb"
      className={cn(
        "relative aspect-[16/10] overflow-hidden bg-surface after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:shadow-[inset_0_0_0_1px_var(--hairline)]",
        className,
      )}
    >
      {slot.granted ? (
        <iframe
          ref={frameRef}
          onLoad={() => {
            setLoaded(true);
            slot.loaded();
          }}
          title={artifact.title}
          aria-hidden
          tabIndex={-1}
          src={client.fileUrl(info, artifact)}
          sandbox="allow-scripts allow-popups"
          // A preview is clicked, never scrolled: no scrollbar inside the page.
          scrolling="no"
          className={cn(
            "absolute top-0 left-0 border-0 bg-white transition-opacity duration-300 ease-out",
            loaded ? "opacity-100" : "opacity-0",
            dimsInDark(tone) && "[filter:var(--thumb-filter)]",
          )}
          style={{
            width: LAYOUT_WIDTH,
            height: (LAYOUT_WIDTH * box.h) / box.w,
            transform: `scale(${scale})`,
            transformOrigin: "0 0",
            pointerEvents: "none",
          }}
        />
      ) : null}
      {loaded && live ? null : <DocSkeleton compact />}
    </div>
  );
}

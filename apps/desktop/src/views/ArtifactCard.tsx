import { memo, useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import type { Artifact, Info } from "@alto-rooms/protocol-ts";
import { Maximize2 } from "lucide-react";
import { useClient } from "@/data/hooks";
import { artifactDragSource } from "@/lib/drag";
import { wantsNewTab } from "@/lib/nav";
import { cn } from "@/lib/utils";
import { DocSkeleton } from "./DocSkeleton";

/** Previews are laid out at this width, then scaled down to the page box. */
const LAYOUT_WIDTH = 1280;
/** A preview stays loaded this long after its card scrolls out of range, so scrolling back and forth doesn't reload it. */
const UNLOAD_DELAY_MS = 2000;

const SIZES = {
  // Room grid: 300 wide with a 420 page. Hover only raises the hovered card (shadow and
  // a darker hairline); it never resizes a card, which would reflow the grid.
  strip: {
    card: "w-[300px]",
    page: "h-[420px] transition-[box-shadow,border-color] duration-200 ease-out group-hover/card:border-[#c8c8c8] group-hover/card:shadow-float group-focus-within/card:shadow-float motion-reduce:transition-none",
    expand: "top-3 right-3 size-9",
    label: "font-mono text-[12px] text-ink-3",
    // Inner page box (inside the 1px border) before it is measured.
    fallback: { w: 298, h: 418 },
  },
  // Journal row: 220 wide, page 250.
  journal: {
    card: "w-[220px]",
    page: "h-[250px] transition-shadow duration-200 group-hover/card:shadow-float group-focus-within/card:shadow-float",
    expand: "top-2.5 right-2.5 size-[34px]",
    label: "text-[12px] text-ink-3",
    fallback: { w: 218, h: 248 },
  },
} as const;

export type ArtifactCardProps = {
  artifact: Artifact;
  info: Info;
  /** Date text (`Today` / `MM·DD`) in the strip, or a room name in the journal. */
  label: string;
  isNew: boolean;
  size: "strip" | "journal";
  /** Opens the document: here, or in a new tab (⌘/middle click, or the expand button). Pass a stable function: cards are memoized. */
  onOpen: (artifact: Artifact, newTab: boolean) => void;
  /** The whole card drags onto sidebar rooms (inbox cards, when writable). */
  draggable?: boolean;
};

/** True while `el` is within half a viewport (above or below) of its scroll root (the nearest `[data-scroll-root]`, else the viewport). */
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
      rootMargin: "50% 0px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return near;
}

/** `value`, except that turning false waits `ms` (and is dropped if it turns true again meanwhile). */
function useLingering(value: boolean, ms: number): boolean {
  const [held, setHeld] = useState(value);
  useEffect(() => {
    if (value) {
      setHeld(true);
      return;
    }
    const t = setTimeout(() => setHeld(false), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return value || held;
}

/** The page box's inner size; `fallback` until measured. */
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
 * One artifact: a white page holding a live, sandboxed, non-interactive preview
 * (laid out at 1280px and scaled to fit), then title, new-doc dot and label.
 * The card body is a focusable button: click/Enter/Space opens the doc in this tab
 * (⌘ or a middle click: a new tab); the expand button, shown on hover or focus,
 * always opens a new tab.
 */
export const ArtifactCard = memo(function ArtifactCard({ artifact, info, label, isNew, size, onOpen: open, draggable = false }: ArtifactCardProps) {
  const client = useClient();
  const s = SIZES[size];
  const pageRef = useRef<HTMLDivElement>(null);
  const near = useLingering(useNearViewport(pageRef), UNLOAD_DELAY_MS);
  // The preview unmounts when the card scrolls far away, so loading starts over then.
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!near) setLoaded(false);
  }, [near]);
  const box = useBoxSize(pageRef, s.fallback);
  const scale = box.w / LAYOUT_WIDTH;
  const onOpen = (newTab: boolean) => open(artifact, newTab);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpen(wantsNewTab(e));
    }
  };

  return (
    <div
      data-testid="artifact-card"
      {...(draggable ? artifactDragSource({ roomId: artifact.roomId, artifactId: artifact.id }) : {})}
      className={cn("group/card relative shrink-0", s.card)}
    >
      <div
        role="button"
        tabIndex={0}
        aria-label={artifact.title}
        onClick={(e) => onOpen(wantsNewTab(e))}
        onAuxClick={(e) => e.button === 1 && onOpen(true)}
        onKeyDown={onKeyDown}
        className="flex cursor-pointer flex-col gap-3 rounded-xl outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
      >
        <div ref={pageRef} className={cn("relative overflow-hidden rounded-xl border border-[#ddd] bg-white", s.page)}>
          {near ? (
            <iframe
              onLoad={() => setLoaded(true)}
              title={artifact.title}
              aria-hidden
              tabIndex={-1}
              src={client.fileUrl(info, artifact)}
              sandbox="allow-scripts allow-popups"
              // A preview is clicked, never scrolled: no scrollbar inside the page.
              scrolling="no"
              className={cn("absolute top-0 left-0 border-0 bg-white transition-opacity duration-300 ease-out", loaded ? "opacity-100" : "opacity-0")}
              style={{
                width: LAYOUT_WIDTH,
                height: (LAYOUT_WIDTH * box.h) / box.w,
                transform: `scale(${scale})`,
                transformOrigin: "0 0",
                pointerEvents: "none",
              }}
            />
          ) : null}
          {loaded && near ? null : <DocSkeleton compact={size === "journal"} />}
        </div>
        <div className="flex min-w-0 items-center gap-2 px-0.5">
          <span data-testid="card-title" className="min-w-0 truncate text-[15px] font-medium text-ink">
            {artifact.title}
          </span>
          {isNew ? <span role="img" aria-label="New doc" className="size-1.5 shrink-0 rounded-full bg-[#222]" /> : null}
          <span className={cn("ml-auto shrink-0 whitespace-nowrap", s.label)}>{label}</span>
        </div>
      </div>
      <button
        type="button"
        aria-label="Open in new tab"
        onClick={() => onOpen(true)}
        className={cn(
          "absolute flex items-center justify-center rounded-lg border border-[#ddd] bg-white text-ink shadow-float",
          "opacity-0 transition-opacity group-focus-within/card:opacity-100 group-hover/card:opacity-100",
          "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink",
          s.expand,
        )}
      >
        <Maximize2 size={16} aria-hidden />
      </button>
    </div>
  );
});

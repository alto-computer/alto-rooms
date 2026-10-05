import { useEffect, useRef, useState, type MouseEvent } from "react";
import { ArrowLeft, ArrowRight, Calendar, FileText, Folder, LayoutGrid, PanelLeft, Plus, X, type LucideIcon } from "lucide-react";
import { useArtifacts, useRooms, useViewer, useViewerStore } from "@/data/hooks";
import type { Tab } from "@/data/viewerStore";
import { noteBase } from "@/lib/notes";
import { monthDay } from "@/lib/dates";
import { cn } from "@/lib/utils";

export const tabDomId = (id: string) => `tab-${id}`;
export const TAB_PANEL_ID = "tab-panel";

const ICONS: Record<Tab["kind"], LucideIcon> = {
  room: Folder,
  doc: FileText,
  note: FileText,
  journal: Calendar,
  new: LayoutGrid,
};

/** Before the first sync we can't tell yet. */
const PENDING = "…";
const GONE_ROOM = "Missing room";
const GONE_DOC = "Missing doc";

/** Room names come from RoomsState by id on every render; tabs never cache them. */
function RoomLabel({ roomId }: { roomId: string }) {
  const { rooms, info } = useRooms();
  const name = rooms.find((r) => r.id === roomId)?.name;
  return <>{name ?? (info ? GONE_ROOM : PENDING)}</>;
}

function DocLabel({ roomId, artifactId }: { roomId: string; artifactId: string }) {
  const { rooms, info } = useRooms();
  const artifacts = useArtifacts(roomId);
  const title = artifacts?.find((a) => a.id === artifactId)?.title;
  if (title !== undefined) return <>{title}</>;
  if (!info) return <>{PENDING}</>;
  // The journal room is never listed; any other room must be.
  const roomGone = roomId !== info.journalRoomId && !rooms.some((r) => r.id === roomId);
  return <>{roomGone || artifacts !== undefined ? GONE_DOC : PENDING}</>;
}

function TabLabel({ tab }: { tab: Tab }) {
  switch (tab.kind) {
    case "room":
      return <RoomLabel roomId={tab.roomId} />;
    case "doc":
      return <DocLabel roomId={tab.roomId} artifactId={tab.artifactId} />;
    case "journal":
      return <>{`Journal · ${monthDay(tab.date)}`}</>;
    case "note":
      return <>{noteBase(tab.name)}</>;
    case "new":
      return <>New tab</>;
  }
}

const ICON_BUTTON =
  "grid size-8 shrink-0 place-items-center rounded-lg text-ink-2 hover:bg-[#f2f2f2] hover:text-ink focus-visible:outline-2 focus-visible:outline-ink disabled:pointer-events-none disabled:text-ink-3 disabled:opacity-50";

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
function useTabOverflow(activeId: string | null, count: number) {
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

export function TabBar() {
  const { tabs, activeId, sidebarOpen } = useViewer();
  const viewer = useViewerStore();
  const { listRef, fade } = useTabOverflow(activeId, tabs.length);

  return (
    <div className="flex min-w-0 items-center gap-1 px-1 pb-2">
      {sidebarOpen ? null : (
        <button type="button" aria-label="Show sidebar (⌘B)" onClick={() => viewer.setSidebarOpen(true)} className={ICON_BUTTON}>
          <PanelLeft size={17} strokeWidth={1.75} aria-hidden />
        </button>
      )}
      <button type="button" aria-label="Back (⌘[)" disabled={!viewer.canGoBack()} onClick={() => viewer.back()} className={ICON_BUTTON}>
        <ArrowLeft size={17} strokeWidth={1.75} aria-hidden />
      </button>
      <button
        type="button"
        aria-label="Forward (⌘])"
        disabled={!viewer.canGoForward()}
        onClick={() => viewer.forward()}
        className={cn(ICON_BUTTON, "mr-1")}
      >
        <ArrowRight size={17} strokeWidth={1.75} aria-hidden />
      </button>
      <div
        ref={listRef}
        role="tablist"
        aria-label="Tabs"
        className={cn("flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", fade)}
      >
        {tabs.map((tab) => (
          <TabItem
            key={tab.id}
            tab={tab}
            active={tab.id === activeId}
            onActivate={() => viewer.activate(tab.id)}
            onClose={() => viewer.close(tab.id)}
          />
        ))}
      </div>
      <button type="button" aria-label="New tab" onClick={() => viewer.open({ kind: "new" })} className={ICON_BUTTON}>
        <Plus size={17} strokeWidth={1.75} aria-hidden />
      </button>
    </div>
  );
}

function TabItem({ tab, active, onActivate, onClose }: { tab: Tab; active: boolean; onActivate: () => void; onClose: () => void }) {
  const Icon = ICONS[tab.kind];
  const middle = (e: MouseEvent) => {
    if (e.button === 1) {
      e.preventDefault();
      onClose();
    }
  };
  return (
    <div role="presentation" className="group relative flex min-w-[112px] flex-[0_1_220px]">
      <button
        type="button"
        role="tab"
        id={tabDomId(tab.id)}
        aria-selected={active}
        aria-controls={active ? TAB_PANEL_ID : undefined}
        onClick={onActivate}
        onAuxClick={middle}
        // Stop the middle-button autoscroll cursor.
        onMouseDown={(e) => e.button === 1 && e.preventDefault()}
        className={cn(
          // The active tab keeps room for its always-visible close button; the others never
          // change padding on hover (their close button fades in over the label's end instead).
          "flex min-h-[34px] w-full min-w-0 items-center gap-2 rounded-lg border pl-3 text-[14px]",
          "focus-visible:outline-2 focus-visible:outline-ink",
          active ? "pr-8" : "pr-3",
          active ? "border-[#ddd] bg-white text-[#222]" : "border-transparent text-[#6a6a6a] hover:text-[#222]",
        )}
      >
        <Icon size={15} strokeWidth={1.75} aria-hidden className="shrink-0" />
        <span className="truncate">
          <TabLabel tab={tab} />
        </span>
      </button>
      <button
        type="button"
        aria-label="Close tab"
        onClick={onClose}
        onAuxClick={middle}
        className={cn(
          "absolute top-1/2 right-[1px] flex h-[32px] -translate-y-1/2 items-center rounded-r-lg pr-[7px] text-[#6a6a6a] hover:text-[#222] focus-visible:outline-2 focus-visible:outline-ink",
          "transition-opacity duration-150",
          active
            ? "bg-white opacity-100"
            : "bg-[linear-gradient(to_right,transparent,var(--surface)_12px)] pl-4 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100",
        )}
      >
        <span className="grid size-5 place-items-center rounded hover:bg-[#f2f2f2]">
          <X size={15} strokeWidth={1.75} aria-hidden />
        </span>
      </button>
    </div>
  );
}

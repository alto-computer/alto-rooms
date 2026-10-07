import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent, type Modifier } from "@dnd-kit/core";
import { horizontalListSortingStrategy, SortableContext, sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowLeft, ArrowRight, Calendar, FileText, Folder, LayoutGrid, PanelLeft, Plus, Puzzle, X, type LucideIcon } from "lucide-react";
import { useArtifacts, usePlugins, useInfo, useRoomList, useViewer, useViewerStore } from "@/data/hooks";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { pluginIcon } from "@/plugins/icons";
import type { Tab } from "@/data/viewerStore";
import { noteBase } from "@/lib/notes";
import { monthDay } from "@/lib/dates";
import { IconTip } from "@/components/IconTip";
import { cn } from "@/lib/utils";

export const tabDomId = (id: string) => `tab-${id}`;
export const TAB_PANEL_ID = "tab-panel";

const ICONS: Record<Tab["kind"], LucideIcon> = {
  room: Folder,
  doc: FileText,
  note: FileText,
  journal: Calendar,
  new: LayoutGrid,
  plugin: Puzzle,
};

/** Before the first sync we can't tell yet. */
const PENDING = "…";
const GONE_ROOM = "Missing room";
const GONE_DOC = "Missing doc";

/** Room names come from RoomsState by id on every render; tabs never cache them. */
function RoomLabel({ roomId }: { roomId: string }) {
  const rooms = useRoomList();
  const info = useInfo();
  const name = rooms.find((r) => r.id === roomId)?.name;
  return <>{name ?? (info ? GONE_ROOM : PENDING)}</>;
}

function DocLabel({ roomId, artifactId }: { roomId: string; artifactId: string }) {
  const rooms = useRoomList();
  const info = useInfo();
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
    case "plugin":
      return <PluginLabel pluginId={tab.pluginId} />;
  }
}

function PluginLabel({ pluginId }: { pluginId: string }) {
  const { list, loaded } = usePlugins();
  const p = list.find((x) => x.id === pluginId);
  return <>{p?.slots.tab?.title ?? (loaded ? "Missing plugin" : PENDING)}</>;
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
  const sensors = useSensors(
    // A few pixels of movement before a drag starts, so a click still switches tabs.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    // Space picks a tab up, ←/→ move it, Space drops; Enter keeps activating it.
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates, keyboardCodes: KEYBOARD_CODES }),
  );
  // While a tab is picked up with the keyboard, the arrows move it instead of the focus.
  const [dragging, setDragging] = useState(false);
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setDragging(false);
    if (!over || active.id === over.id) return;
    viewer.move(String(active.id), tabs.findIndex((t) => t.id === over.id));
  };
  // Chrome's rule: after a close click, tabs keep their width until the pointer leaves the
  // strip, so the next tab's close button lands under the cursor.
  const [frozenWidth, setFrozenWidth] = useState<number | null>(null);

  // ARIA tabs: one Tab stop (the active tab); ←/→/Home/End switch tabs, Delete closes one.
  const onListKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (dragging || e.metaKey || e.ctrlKey || e.altKey) return;
    const i = tabs.findIndex((t) => tabDomId(t.id) === (e.target as HTMLElement).id);
    if (i < 0) return;
    const to = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (to !== undefined) {
      e.preventDefault();
      const next = tabs[(to + tabs.length) % tabs.length];
      viewer.activate(next.id);
      document.getElementById(tabDomId(next.id))?.focus();
    } else if (e.key === "Delete") {
      e.preventDefault();
      viewer.close(tabs[i].id);
      const { activeId: now } = viewer.getState();
      requestAnimationFrame(() => now && document.getElementById(tabDomId(now))?.focus());
    }
  };

  return (
    <div className="flex min-w-0 items-center gap-1 px-1 pb-2">
      {sidebarOpen ? null : (
        <IconTip label="Show sidebar" shortcut="⌘B">
          <button type="button" aria-label="Show sidebar (⌘B)" onClick={() => viewer.setSidebarOpen(true)} className={ICON_BUTTON}>
            <PanelLeft size={17} strokeWidth={1.75} aria-hidden />
          </button>
        </IconTip>
      )}
      <IconTip label="Back" shortcut="⌘[">
        <button type="button" aria-label="Back (⌘[)" disabled={!viewer.canGoBack()} onClick={() => viewer.back()} className={ICON_BUTTON}>
          <ArrowLeft size={17} strokeWidth={1.75} aria-hidden />
        </button>
      </IconTip>
      <IconTip label="Forward" shortcut="⌘]">
        <button
          type="button"
          aria-label="Forward (⌘])"
          disabled={!viewer.canGoForward()}
          onClick={() => viewer.forward()}
          className={cn(ICON_BUTTON, "mr-1")}
        >
          <ArrowRight size={17} strokeWidth={1.75} aria-hidden />
        </button>
      </IconTip>
      <div
        ref={listRef}
        role="tablist"
        aria-label="Tabs"
        onKeyDown={onListKeyDown}
        onMouseLeave={() => setFrozenWidth(null)}
        className={cn("flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", fade)}
      >
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[horizontalOnly]}
          // Browser style: the tab you pick up is the one you're looking at.
          onDragStart={({ active }) => {
            setDragging(true);
            viewer.activate(String(active.id));
          }}
          onDragCancel={() => setDragging(false)}
          onDragEnd={onDragEnd}
        >
          <SortableContext items={tabs.map((t) => t.id)} strategy={horizontalListSortingStrategy}>
            {tabs.map((tab) => (
              <TabItem
                key={tab.id}
                tab={tab}
                active={tab.id === activeId}
                width={frozenWidth}
                onActivate={() => viewer.activate(tab.id)}
                onClose={(width) => {
                  if (width !== undefined) setFrozenWidth(width);
                  viewer.close(tab.id);
                }}
              />
            ))}
          </SortableContext>
        </DndContext>
      </div>
      <IconTip label="New tab" shortcut="⌘T">
        <button type="button" aria-label="New tab" onClick={() => viewer.open({ kind: "new" })} className={ICON_BUTTON}>
          <Plus size={17} strokeWidth={1.75} aria-hidden />
        </button>
      </IconTip>
    </div>
  );
}

const KEYBOARD_CODES = { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter"] };

/** Tabs only move sideways. */
const horizontalOnly: Modifier = ({ transform }) => ({ ...transform, y: 0 });

function TabItem({
  tab,
  active,
  width,
  onActivate,
  onClose,
}: {
  tab: Tab;
  active: boolean;
  /** A fixed width while closes are frozen (see TabBar), else the usual shrink-to-fit. */
  width: number | null;
  onActivate: () => void;
  /** `width`: the closed tab's width when closed by a pointer click on its button. */
  onClose: (width?: number) => void;
}) {
  const { list } = usePlugins();
  const Icon = tab.kind === "plugin" ? pluginIcon(list.find((p) => p.id === tab.pluginId)?.slots.tab?.icon) : ICONS[tab.kind];
  const sort = useSortable({ id: tab.id });
  const style = {
    transform: CSS.Translate.toString(sort.transform),
    transition: sort.transition,
    ...(width === null ? {} : { flex: `0 0 ${width}px` }),
  };
  const middle = (e: MouseEvent<HTMLElement>) => {
    if (e.button === 1) {
      e.preventDefault();
      onClose(e.currentTarget.parentElement?.getBoundingClientRect().width);
    }
  };
  return (
    <div
      ref={sort.setNodeRef}
      style={style}
      role="presentation"
      className={cn("group relative flex min-w-[112px] flex-[0_1_220px]", sort.isDragging && "z-10")}
    >
      <Tooltip delayDuration={600}>
        <TooltipTrigger asChild>
          <button
            type="button"
            id={tabDomId(tab.id)}
            aria-selected={active}
            aria-controls={active ? TAB_PANEL_ID : undefined}
            onClick={onActivate}
            onAuxClick={middle}
            // Stop the middle-button autoscroll cursor.
            onMouseDown={(e) => e.button === 1 && e.preventDefault()}
            {...sort.attributes}
            {...sort.listeners}
            // dnd-kit's attributes would turn the tab into a "button" and a Tab stop; it stays a tab, and only the active one is a stop.
            role="tab"
            tabIndex={active ? 0 : -1}
            aria-roledescription={undefined}
            aria-pressed={undefined}
            className={cn(
              // The active tab keeps room for its always-visible close button; the others never
              // change padding on hover (their close button fades in over the label's end instead).
              "flex min-h-[34px] w-full min-w-0 items-center gap-2 rounded-lg border pl-3 text-[14px]",
              "focus-visible:outline-2 focus-visible:outline-ink",
              active ? "pr-8" : "pr-3",
              active ? "border-[#ddd] bg-white text-[#222]" : "border-transparent text-[#6a6a6a] group-focus-within:bg-[#efefef] hover:bg-[#efefef] hover:text-[#222]",
              sort.isDragging && "cursor-grabbing border-[#ddd] bg-white shadow-float",
            )}
          >
            <Icon size={15} strokeWidth={1.75} aria-hidden className="shrink-0" />
            <span className="truncate">
              <TabLabel tab={tab} />
            </span>
          </button>
        </TooltipTrigger>
        {/* The full title, for labels the tab cuts off. */}
        <TooltipContent side="bottom" sideOffset={6} className="max-w-[360px]">
          <TabLabel tab={tab} />
        </TooltipContent>
      </Tooltip>
      <button
        type="button"
        aria-label="Close tab"
        tabIndex={-1}
        onClick={(e) => onClose(e.detail > 0 ? e.currentTarget.parentElement?.getBoundingClientRect().width : undefined)}
        onAuxClick={middle}
        className={cn(
          "absolute top-1/2 right-[1px] flex h-[32px] -translate-y-1/2 items-center rounded-r-lg pr-[7px] text-[#6a6a6a] hover:text-[#222] focus-visible:outline-2 focus-visible:outline-ink",
          "transition-opacity duration-150",
          active
            ? "bg-white opacity-100"
            : "bg-[linear-gradient(to_right,transparent,#efefef_12px)] pl-4 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100",
        )}
      >
        <span className="grid size-5 place-items-center rounded hover:bg-[#f2f2f2]">
          <X size={15} strokeWidth={1.75} aria-hidden />
        </span>
      </button>
    </div>
  );
}

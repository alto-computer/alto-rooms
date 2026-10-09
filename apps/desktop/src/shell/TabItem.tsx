import type { MouseEvent } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Calendar, FileText, Folder, Puzzle, X, type LucideIcon } from "lucide-react";
import { RoomDot } from "@/components/RoomDot";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { usePlugins, useRoomList } from "@/data/hooks";
import type { Tab } from "@/data/viewerStore";
import { roomTint } from "@/lib/roomTint";
import { cn } from "@/lib/utils";
import { pluginIcon } from "@/plugins/icons";
import { TAB_PANEL_ID, tabDomId } from "./tabIds";
import { TabLabel } from "./TabLabel";

const ICONS: Record<Tab["kind"], LucideIcon> = {
  room: Folder,
  doc: FileText,
  note: FileText,
  journal: Calendar,
  plugin: Puzzle,
};

/** One tab in the strip: activates on click, sorts by drag, closes from its button or a middle click. */
export function TabItem({
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
  const rooms = useRoomList();
  const Icon = tab.kind === "plugin" ? pluginIcon(list.find((p) => p.id === tab.pluginId)?.slots.tab?.icon) : ICONS[tab.kind];
  // A pinned room's tab shows its colour dot in place of the folder.
  const color = tab.kind === "room" ? (rooms.find((r) => r.id === tab.roomId)?.color ?? null) : null;
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
      data-active={active || undefined}
      {...roomTint(color)}
      className={cn(
        // The active tab is a folder tab joined to the pane: its fill (--tab-bg) is whatever the
        // view paints along its top edge, the room band for a room and the plain pane otherwise.
        tab.kind === "room" ? "[--tab-bg:var(--room-band)]" : "[--tab-bg:var(--pane)]",
        // The 220px width also sets the strip's own size: Chrome sizes a flex row from its items'
        // widths, not their flex-basis, so without it every tab shrank to fit its label.
        "group relative flex w-[220px] min-w-[112px] flex-[0_1_220px]",
        // Chrome's divider between resting tabs: it marks where a tab with a short label ends,
        // and gives way next to the active and the hovered tab, whose own box shows the edge.
        "before:absolute before:top-1/2 before:-left-[2.5px] before:h-4 before:w-px before:-translate-y-1/2 before:bg-hairline",
        "first:before:hidden hover:before:hidden data-active:before:hidden [[data-active]+&]:before:hidden [:hover+&]:before:hidden",
        active && "z-[1]",
        sort.isDragging && "z-10 [--tab-bg:var(--sheet)] before:hidden",
      )}
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
              "relative flex min-h-[34px] w-full min-w-0 items-center gap-2 border border-transparent pl-3 text-left text-body",
              // Inset, so the tab list's clipping can't cut the ring off along the pane.
              "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink",
              active
                ? cn(
                    "rounded-t-[9px] bg-(--tab-bg) pr-8 text-ink",
                    // Inverted corners at the base flow the tab into the pane's top edge.
                    "before:absolute before:bottom-[-1px] before:-left-[11px] before:size-2.5 before:bg-[radial-gradient(circle_at_0_0,transparent_9.5px,var(--tab-bg)_10px)]",
                    "after:absolute after:-right-[11px] after:bottom-[-1px] after:size-2.5 after:bg-[radial-gradient(circle_at_100%_0,transparent_9.5px,var(--tab-bg)_10px)]",
                  )
                : "rounded-lg pr-3 text-ink-2 group-focus-within:bg-surface hover:bg-surface hover:text-ink",
              sort.isDragging && "cursor-grabbing rounded-lg border-hairline shadow-float before:hidden after:hidden",
            )}
          >
            {color ? <RoomDot color={color} /> : <Icon size={15} strokeWidth={1.75} aria-hidden className="shrink-0" />}
            {/* Chrome style: a long label fades out at the tab's end instead of an ellipsis, so more of it shows. */}
            <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap [mask-image:linear-gradient(to_left,transparent,#000_20px)]">
              <TabLabel tab={tab} />
            </span>
          </button>
        </TooltipTrigger>
        {/* The full title, for labels the tab cuts off; never over a tab being dragged. */}
        {sort.isDragging ? null : (
          <TooltipContent side="bottom" sideOffset={6} className="max-w-[360px]">
            <TabLabel tab={tab} />
          </TooltipContent>
        )}
      </Tooltip>
      <button
        type="button"
        aria-label="Close tab"
        tabIndex={-1}
        onClick={(e) => onClose(e.detail > 0 ? e.currentTarget.parentElement?.getBoundingClientRect().width : undefined)}
        onAuxClick={middle}
        className={cn(
          // Inside the tab's 2px focus ring, so it never paints over it.
          "absolute top-1/2 right-[2px] flex h-[30px] -translate-y-1/2 items-center rounded-r-lg pr-2 text-ink-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-ink",
          "transition-opacity duration-150",
          active
            ? "bg-(--tab-bg) opacity-100"
            : "bg-[linear-gradient(to_right,transparent,var(--surface)_20px)] pl-6 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100",
        )}
      >
        <span className="grid size-5 place-items-center rounded hover:bg-surface">
          <X size={15} strokeWidth={1.75} aria-hidden />
        </span>
      </button>
    </div>
  );
}

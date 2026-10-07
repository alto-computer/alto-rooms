import type { MouseEvent } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Calendar, FileText, Folder, LayoutGrid, Puzzle, X, type LucideIcon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { usePlugins } from "@/data/hooks";
import type { Tab } from "@/data/viewerStore";
import { cn } from "@/lib/utils";
import { pluginIcon } from "@/plugins/icons";
import { TAB_PANEL_ID, tabDomId } from "./tabIds";
import { TabLabel } from "./TabLabel";

const ICONS: Record<Tab["kind"], LucideIcon> = {
  room: Folder,
  doc: FileText,
  note: FileText,
  journal: Calendar,
  new: LayoutGrid,
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
      data-active={active || undefined}
      className={cn(
        "group relative flex min-w-[112px] flex-[0_1_220px]",
        // Chrome's divider between resting tabs: it marks where a tab with a short label ends,
        // and gives way next to the active and the hovered tab, whose own box shows the edge.
        "before:absolute before:top-1/2 before:-left-[2.5px] before:h-4 before:w-px before:-translate-y-1/2 before:bg-[#dcdcdc]",
        "first:before:hidden hover:before:hidden data-active:before:hidden [[data-active]+&]:before:hidden [:hover+&]:before:hidden",
        sort.isDragging && "z-10 before:hidden",
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
            : "bg-[linear-gradient(to_right,transparent,#efefef_20px)] pl-6 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100",
        )}
      >
        <span className="grid size-5 place-items-center rounded hover:bg-[#f2f2f2]">
          <X size={15} strokeWidth={1.75} aria-hidden />
        </span>
      </button>
    </div>
  );
}

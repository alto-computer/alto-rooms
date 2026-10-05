import type { MouseEvent } from "react";
import { Calendar, FileText, Folder, LayoutGrid, PanelLeft, Plus, X, type LucideIcon } from "lucide-react";
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

const PENDING = "…";

/** Room names come from RoomsState by id on every render; tabs never cache them. */
function RoomLabel({ roomId }: { roomId: string }) {
  const { rooms } = useRooms();
  return <>{rooms.find((r) => r.id === roomId)?.name ?? PENDING}</>;
}

function DocLabel({ roomId, artifactId }: { roomId: string; artifactId: string }) {
  const artifacts = useArtifacts(roomId);
  return <>{artifacts?.find((a) => a.id === artifactId)?.title ?? PENDING}</>;
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
      return <>새 탭</>;
  }
}

const ICON_BUTTON =
  "grid size-8 shrink-0 place-items-center rounded-lg text-ink-2 hover:bg-[#f2f2f2] hover:text-ink focus-visible:outline-2 focus-visible:outline-ink";

export function TabBar() {
  const { tabs, activeId, sidebarOpen } = useViewer();
  const viewer = useViewerStore();

  return (
    <div className="flex min-w-0 items-center gap-1 px-1 pb-2">
      {sidebarOpen ? null : (
        <button type="button" aria-label="사이드바 펼치기 (⌘B)" onClick={() => viewer.setSidebarOpen(true)} className={ICON_BUTTON}>
          <PanelLeft size={17} strokeWidth={1.75} aria-hidden />
        </button>
      )}
      <div role="tablist" aria-label="탭" className="no-scrollbar flex min-w-0 items-center gap-1 overflow-x-auto">
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
      <button type="button" aria-label="새 탭" onClick={() => viewer.open({ kind: "new" })} className={ICON_BUTTON}>
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
    <div role="presentation" className="group relative flex max-w-[220px] min-w-0 shrink-0">
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
          "flex min-h-[34px] w-full min-w-0 items-center gap-2 rounded-lg border px-3 text-[14px]",
          "group-hover:pr-8 group-focus-within:pr-8 focus-visible:outline-2 focus-visible:outline-ink",
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
        aria-label="탭 닫기"
        onClick={onClose}
        onAuxClick={middle}
        className="absolute top-1/2 right-2 grid size-5 -translate-y-1/2 place-items-center rounded text-[#6a6a6a] opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:text-[#222] focus-visible:outline-2 focus-visible:outline-ink"
      >
        <X size={16} strokeWidth={1.75} aria-hidden />
      </button>
    </div>
  );
}

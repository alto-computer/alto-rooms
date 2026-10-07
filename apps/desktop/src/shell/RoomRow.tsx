import { useState, type DragEvent } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Room } from "@alto-rooms/protocol-ts";
import { Folder } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useClient, useViewerStore } from "@/data/hooks";
import { carriesArtifact, draggingFromRoom, endArtifactDrag, readArtifactPayload, type ArtifactDragPayload } from "@/lib/drag";
import { wantsNewTab } from "@/lib/nav";
import { cn } from "@/lib/utils";
import { EditableTitle } from "@/views/EditableTitle";
import { ICON, ITEM, ITEM_INTERACTIVE } from "./sidebarItem";

/** Drop handlers for a room row that accepts artifacts; `over` drives the highlight. */
function useDropTarget(roomId: string, onMove: ((p: ArtifactDragPayload, toRoomId: string) => void) | undefined) {
  const [over, setOver] = useState(false);
  if (!onMove) return { over: false, handlers: {} };
  const accepts = (e: DragEvent) => carriesArtifact(e.dataTransfer) && draggingFromRoom() !== roomId;
  const enter = (e: DragEvent) => {
    if (!accepts(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setOver(true);
  };
  return {
    over,
    handlers: {
      onDragEnter: enter,
      onDragOver: enter,
      onDragLeave: (e: DragEvent<HTMLElement>) => {
        if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
        setOver(false);
      },
      onDrop: (e: DragEvent) => {
        setOver(false);
        const p = readArtifactPayload(e.dataTransfer);
        if (!p) return;
        e.preventDefault();
        endArtifactDrag();
        if (p.roomId === roomId) return;
        onMove(p, roomId);
      },
    },
  };
}

/** A room in the sidebar list: opens on click, renames on double click, sorts by drag, and takes dropped docs. */
export function RoomRow({
  room,
  active,
  readOnly,
  sortable,
  onMove,
}: {
  room: Room;
  active: boolean;
  readOnly: boolean;
  /** The row can be dragged up and down to reorder the rooms. */
  sortable: boolean;
  /** Set when the row is a drop target for artifacts. */
  onMove?: (p: ArtifactDragPayload, toRoomId: string) => void;
}) {
  const viewer = useViewerStore();
  const client = useClient();
  const [editing, setEditing] = useState(false);
  const unavailable = room.status === "unavailable";
  const drop = useDropTarget(room.id, onMove);
  const sort = useSortable({ id: room.id, disabled: !sortable });
  const style = { transform: CSS.Translate.toString(sort.transform), transition: sort.transition };

  if (editing && !readOnly) {
    return (
      <li className="flex min-h-9 items-center gap-2.5 rounded-lg bg-white px-2.5 py-1.5 text-[15px] shadow-[0_0_0_2px_#222]">
        <Folder {...ICON} className="shrink-0" />
        <div className="min-w-0 flex-1">
          <EditableTitle
            value={room.name}
            defaultEditing
            ariaLabel="Room name"
            onSave={async (next) => {
              await client.renameRoom(room.id, next);
            }}
            onSaved={() => setEditing(false)}
            onCancel={() => setEditing(false)}
            className="w-full text-[15px] text-ink"
            inputClassName="bg-transparent p-0"
          />
        </div>
      </li>
    );
  }

  const row = (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={(e) => viewer.go({ kind: "room", roomId: room.id }, wantsNewTab(e))}
      onAuxClick={(e) => e.button === 1 && viewer.open({ kind: "room", roomId: room.id })}
      onDoubleClick={readOnly ? undefined : () => setEditing(true)}
      {...(sortable ? { ...sort.attributes, ...sort.listeners } : {})}
      {...drop.handlers}
      className={cn(
        ITEM,
        ITEM_INTERACTIVE,
        active && "bg-[#ebebeb] hover:bg-[#ebebeb]",
        drop.over && "bg-[#ebebeb] outline-1 outline-ink outline-solid hover:bg-[#ebebeb]",
        sort.isDragging && "cursor-grabbing bg-white shadow-float hover:bg-white",
      )}
    >
      <Folder {...ICON} className={cn("shrink-0", active ? "fill-[#fff0f3]" : "fill-none")} />
      <span className={cn("truncate", unavailable && "opacity-50")}>{room.name}</span>
    </button>
  );

  return (
    <li ref={sort.setNodeRef} style={style} className={cn("relative", sort.isDragging && "z-10")}>
      {unavailable ? (
        <Tooltip>
          <TooltipTrigger asChild>{row}</TooltipTrigger>
          <TooltipContent side="right">Folder not found</TooltipContent>
        </Tooltip>
      ) : (
        row
      )}
    </li>
  );
}

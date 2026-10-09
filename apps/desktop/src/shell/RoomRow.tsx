import { useState, type DragEvent } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Room } from "@alto-rooms/protocol-ts";
import { Folder } from "lucide-react";
import { RoomDot } from "@/components/RoomDot";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useClient, useViewerStore } from "@/data/hooks";
import { carriesArtifact, draggingFromRoom, endArtifactDrag, readArtifactPayload, type ArtifactDragPayload } from "@/lib/drag";
import { wantsNewTab } from "@/lib/nav";
import { cn } from "@/lib/utils";
import { EditableTitle } from "@/views/EditableTitle";
import { ICON, ITEM, ITEM_CURRENT, ITEM_INTERACTIVE } from "./sidebarItem";

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
  unread,
  readOnly,
  sortable,
  onMove,
}: {
  room: Room;
  active: boolean;
  /** Something arrived since the user last left the room: the name shows semibold. */
  unread: boolean;
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
  const mark = room.color ? <RoomDot color={room.color} /> : null;

  if (editing && !readOnly) {
    return (
      <li className={cn(ITEM, "h-auto min-h-7 bg-sheet py-1 shadow-sheet ring-[1.5px] ring-ink/40 ring-inset")}>
        {mark ?? <Folder {...ICON} className="shrink-0 text-ink-2" />}
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
            className="w-full text-body text-ink"
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
      onAuxClick={(e) => e.button === 1 && viewer.go({ kind: "room", roomId: room.id }, true)}
      onDoubleClick={readOnly ? undefined : () => setEditing(true)}
      {...(sortable ? { ...sort.attributes, ...sort.listeners } : {})}
      {...drop.handlers}
      className={cn(
        ITEM,
        ITEM_INTERACTIVE,
        active && ITEM_CURRENT,
        drop.over && "bg-surface-strong outline-1 -outline-offset-1 outline-ink outline-solid hover:bg-surface-strong",
        // While carried the row is the gap where it would land; the lifted copy follows the pointer (RoomList).
        sort.isDragging && "invisible",
      )}
    >
      {mark ?? <Folder {...ICON} className={cn("shrink-0", active ? "text-ink-2" : "text-ink-3")} />}
      {/* The native title shows a name the sidebar cuts off (unavailable rows have their own tooltip). */}
      <span title={unavailable ? undefined : room.name} className={cn("truncate", unread && "font-semibold", unavailable && "opacity-50")}>
        {room.name}
      </span>
    </button>
  );

  return (
    // Above the lifted copy (z 999), so the thread line shows over it.
    <li ref={sort.setNodeRef} style={style} data-drop={sort.isDragging || undefined} className={cn("relative", sort.isDragging && "z-[1000]")}>
      {sort.isDragging ? <ThreadLine /> : null}
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

/** The drop indicator: a thin ink thread along the top of the gap, with a small knot where it starts. */
function ThreadLine() {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute -top-[1.25px] right-1 left-2.5 h-[1.5px] rounded-full bg-ink before:absolute before:top-1/2 before:-left-1 before:size-[7px] before:-translate-y-1/2 before:rounded-full before:bg-desk before:shadow-[inset_0_0_0_1.5px_var(--ink)]"
    />
  );
}

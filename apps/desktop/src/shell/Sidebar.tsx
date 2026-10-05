import { useState, type DragEvent } from "react";
import type { Room } from "@alto-rooms/protocol-ts";
import { Calendar, CircleAlert, Folder, PanelLeft, Plus, Search } from "lucide-react";
import { Sidebar as ShadcnSidebar } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useClient, useReadOnly, useRooms, useViewer, useViewerStore } from "@/data/hooks";
import type { ViewerStore } from "@/data/viewerStore";
import { localDate } from "@/lib/dates";
import {
  carriesArtifact,
  draggingFromRoom,
  endArtifactDrag,
  INBOX_ID,
  readArtifactPayload,
  type ArtifactDragPayload,
} from "@/lib/drag";
import { moveErrorCopy } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { useBriefError } from "@/views/briefError";
import { EditableTitle } from "@/views/EditableTitle";
import logo from "@/assets/logo.svg";
import { NewRoomRow } from "./NewRoomRow";

/** Shared sizing for sidebar items and room rows (min-height 36, padding 0 10px, radius 8, 15px, gap 10). */
const ITEM = "flex min-h-9 w-full min-w-0 items-center gap-2.5 rounded-lg px-2.5 text-left text-[15px] text-ink";
const ITEM_INTERACTIVE = "hover:bg-[#f2f2f2] focus-visible:outline-2 focus-visible:outline-ink";
const ICON = { size: 17, strokeWidth: 1.75, "aria-hidden": true } as const;

/** Opens (or activates) the single journal tab, pointed at today's local date. */
export function openJournal(viewer: ViewerStore) {
  const today = localDate();
  const existing = viewer.getState().tabs.find((t) => t.kind === "journal");
  if (!existing) {
    viewer.open({ kind: "journal", date: today });
    return;
  }
  viewer.replace(existing.id, { kind: "journal", date: today });
  viewer.activate(existing.id);
}

export function Sidebar({ onFind }: { onFind: () => void }) {
  const { rooms } = useRooms();
  const { tabs, activeId, sidebarOpen } = useViewer();
  const viewer = useViewerStore();
  const readOnly = useReadOnly();
  const client = useClient();
  const [creating, setCreating] = useState(false);
  const moveFailed = useBriefError();
  const [moveError, setMoveError] = useState("");

  // Success needs no word: the SSE events move the doc in both lists.
  const move = (p: ArtifactDragPayload, toRoomId: string) => {
    client.moveArtifact(p.roomId, p.artifactId, toRoomId).then(
      () => moveFailed.clear(),
      (e: unknown) => {
        console.warn("could not move the artifact", e);
        setMoveError(moveErrorCopy(e));
        moveFailed.flash();
      },
    );
  };

  const active = tabs.find((t) => t.id === activeId);
  const activeRoomId = active?.kind === "room" ? active.roomId : null;

  return (
    <ShadcnSidebar
      collapsible="offcanvas"
      // Design values: no border; the content column's panel carries the edge.
      className="group-data-[side=left]:border-r-0"
      // Offcanvas only slides it out of view; keep it out of the tab order and a11y tree too.
      inert={!sidebarOpen}
      aria-hidden={sidebarOpen ? undefined : true}
    >
      <div className="flex h-full min-h-0 flex-col px-[10px] py-4">
        <div className="flex items-center gap-2.5 pl-2.5">
          <img src={logo} alt="" width={26} height={26} className="size-[26px] shrink-0" />
          <span className="text-[17px] font-medium text-ink">Rooms</span>
          <button
            type="button"
            aria-label="사이드바 접기 (⌘B)"
            onClick={() => viewer.setSidebarOpen(false)}
            className="ml-auto grid size-8 shrink-0 place-items-center rounded-lg text-ink-2 hover:bg-[#f2f2f2] hover:text-ink focus-visible:outline-2 focus-visible:outline-ink"
          >
            <PanelLeft {...ICON} />
          </button>
        </div>

        <nav className="mt-4 flex flex-col gap-0.5">
          <button type="button" onClick={onFind} className={cn(ITEM, ITEM_INTERACTIVE)}>
            <Search {...ICON} className="shrink-0 text-ink-2" />
            <span className="truncate">찾기</span>
          </button>
          <button
            type="button"
            onClick={() => openJournal(viewer)}
            aria-current={active?.kind === "journal" ? "page" : undefined}
            className={cn(ITEM, ITEM_INTERACTIVE, active?.kind === "journal" && "bg-[#ebebeb] hover:bg-[#ebebeb]")}
          >
            <Calendar {...ICON} className="shrink-0 text-ink" />
            <span className="truncate">Journal</span>
          </button>
        </nav>

        <div className="mt-5 flex min-h-7 items-center justify-between pl-2.5">
          <span className="text-[12px] text-ink-3">방</span>
          {readOnly ? null : (
            <button
              type="button"
              aria-label="새 방"
              onClick={() => setCreating(true)}
              className="grid size-7 place-items-center rounded-lg text-ink-2 hover:bg-[#f2f2f2] hover:text-ink focus-visible:outline-2 focus-visible:outline-ink"
            >
              <Plus size={16} strokeWidth={1.75} aria-hidden />
            </button>
          )}
        </div>

        <ul aria-label="방" className="no-scrollbar mt-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-0.5">
          {creating && !readOnly ? <NewRoomRow onDone={() => setCreating(false)} /> : null}
          {rooms.map((room) => (
            <RoomRow
              key={room.id}
              room={room}
              active={room.id === activeRoomId}
              readOnly={readOnly}
              onMove={readOnly || !isDropTarget(room) ? undefined : move}
            />
          ))}
        </ul>
        {moveFailed.shown ? (
          <p role="status" className="mt-2 flex items-center gap-1.5 px-2.5 text-[13px] text-[#c13515]">
            <CircleAlert size={16} aria-hidden className="shrink-0" />
            {moveError}
          </p>
        ) : null}
        {readOnly || rooms.every((r) => r.id === INBOX_ID) ? null : (
          <button
            type="button"
            onClick={() => viewer.openOnboarding()}
            className="mt-2 self-start rounded-lg px-2.5 py-1.5 text-[13px] text-ink-3 hover:text-ink focus-visible:outline-2 focus-visible:outline-ink"
          >
            에이전트로 정리하기
          </button>
        )}
      </div>
    </ShadcnSidebar>
  );
}

/** Docs can be dropped on owned, available rooms other than the inbox. */
const isDropTarget = (room: Room) => room.kind === "owned" && room.id !== INBOX_ID && room.status === "ok";

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

function RoomRow({
  room,
  active,
  readOnly,
  onMove,
}: {
  room: Room;
  active: boolean;
  readOnly: boolean;
  /** Set when the row is a drop target for artifacts. */
  onMove?: (p: ArtifactDragPayload, toRoomId: string) => void;
}) {
  const viewer = useViewerStore();
  const client = useClient();
  const [editing, setEditing] = useState(false);
  const unavailable = room.status === "unavailable";
  const drop = useDropTarget(room.id, onMove);

  if (editing && !readOnly) {
    return (
      <li className="flex min-h-9 items-center gap-2.5 rounded-lg bg-white px-2.5 py-1.5 text-[15px] shadow-[0_0_0_2px_#222]">
        <Folder {...ICON} className="shrink-0" />
        <div className="min-w-0 flex-1">
          <EditableTitle
            value={room.name}
            defaultEditing
            ariaLabel="방 이름"
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
      onClick={() => viewer.open({ kind: "room", roomId: room.id })}
      onDoubleClick={readOnly ? undefined : () => setEditing(true)}
      {...drop.handlers}
      className={cn(
        ITEM,
        ITEM_INTERACTIVE,
        active && "bg-[#ebebeb] hover:bg-[#ebebeb]",
        drop.over && "bg-[#ebebeb] outline-1 outline-ink outline-solid hover:bg-[#ebebeb]",
      )}
    >
      <Folder {...ICON} className={cn("shrink-0", active ? "fill-[#fff0f3]" : "fill-none")} />
      <span className={cn("truncate", unavailable && "opacity-50")}>{room.name}</span>
    </button>
  );

  return (
    <li>
      {unavailable ? (
        <Tooltip>
          <TooltipTrigger asChild>{row}</TooltipTrigger>
          <TooltipContent side="right">폴더를 찾을 수 없어요</TooltipContent>
        </Tooltip>
      ) : (
        row
      )}
    </li>
  );
}

import { useEffect, useState } from "react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { Room } from "@alto-rooms/protocol-ts";
import { BookOpen, CircleAlert, Inbox, PanelLeft, Plus, Search } from "lucide-react";
import { Sidebar as ShadcnSidebar } from "@/components/ui/sidebar";
import { useClient, useReadOnly, useRoomList, useViewer, useViewerStore } from "@/data/hooks";
import type { ViewerStore } from "@/data/viewerStore";
import { isNewSince, localDate } from "@/lib/dates";
import { INBOX_ID, type ArtifactDragPayload } from "@/lib/drag";
import { moveErrorCopy } from "@/lib/errors";
import { wantsNewTab } from "@/lib/nav";
import { IconTip } from "@/components/IconTip";
import { cn } from "@/lib/utils";
import { useBriefError } from "@/views/briefError";
import { DRAG_KEYBOARD_CODES } from "./dragKeys";
import { BrandMenu } from "./BrandMenu";
import { NewRoomRow } from "./NewRoomRow";
import { PluginItems } from "./PluginItems";
import { RoomRow } from "./RoomRow";
import { ICON, ITEM, ITEM_CURRENT, ITEM_INTERACTIVE, SECTION } from "./sidebarItem";

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
  const rooms = useRoomList();
  const { tabs, activeId, sidebarOpen, lastVisit, firstRunAt } = useViewer();
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

  // Reordering: rooms below the pinned inbox are sortable. After a drop the new order shows at
  // once (`pending`) and stays until the core's `rooms.reordered` brings the same order.
  const [pending, setPending] = useState<string[] | null>(null);
  const shown = inOrder(rooms, pending);
  useEffect(() => {
    if (pending && rooms.map((r) => r.id).join("\n") === pending.join("\n")) setPending(null);
  }, [rooms, pending]);
  const sortableIds = shown.filter((r) => r.id !== INBOX_ID).map((r) => r.id);
  const sensors = useSensors(
    // A few pixels of movement before a drag starts, so a click still opens the room.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    // Space picks a room up, ↑/↓ move it, Space drops; Enter keeps opening the room.
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates, keyboardCodes: DRAG_KEYBOARD_CODES }),
  );
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const id = String(active.id);
    const from = sortableIds.indexOf(id);
    const to = over ? sortableIds.indexOf(String(over.id)) : -1;
    if (from < 0 || to < 0 || from === to) return;
    const pinned = shown.some((r) => r.id === INBOX_ID) ? [INBOX_ID] : [];
    setPending([...pinned, ...arrayMove(sortableIds, from, to)]);
    client.moveRoom(id, to).then(
      () => moveFailed.clear(),
      (e: unknown) => {
        console.warn("could not move the room", e);
        setPending(null);
        setMoveError(moveErrorCopy(e));
        moveFailed.flash();
      },
    );
  };

  const active = tabs.find((t) => t.id === activeId);
  const activeRoomId = active?.kind === "room" ? active.roomId : null;
  // The empty inbox stays out of the sidebar, unless it is the room being viewed.
  const inbox = shown.find((r) => r.id === INBOX_ID && (r.artifactCount > 0 || r.id === activeRoomId));
  const listed = shown.filter((r) => r.id !== INBOX_ID);
  // Something arrived since you last left the room; the room you are in never counts.
  const unread = (r: Room) => r.id !== activeRoomId && r.updatedAt !== null && isNewSince(r.updatedAt, lastVisit[r.id] ?? firstRunAt);

  return (
    <ShadcnSidebar
      collapsible="offcanvas"
      // Design values: no border; the content column's panel carries the edge.
      className="group-data-[side=left]:border-r-0"
      // Offcanvas only slides it out of view; keep it out of the tab order and a11y tree too.
      inert={!sidebarOpen}
      aria-hidden={sidebarOpen ? undefined : true}
    >
      {/* App chrome: labels don't select on drag or double click (the rename field still does). */}
      <div className="flex h-full min-h-0 flex-col bg-linear-to-b from-(--sidebar-sheen-top) to-(--sidebar-sheen-bottom) px-2.5 pt-3 pb-2.5 select-none [&_input]:select-text">
        <div className="mb-2.5 flex items-center">
          <BrandMenu />
          <IconTip label="Hide sidebar" shortcut="⌘B">
            <button
              type="button"
              aria-label="Hide sidebar (⌘B)"
              onClick={() => viewer.setSidebarOpen(false)}
              className="ml-auto grid size-7 shrink-0 place-items-center rounded-lg text-ink-3 hover:bg-row-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-ink"
            >
              <PanelLeft {...ICON} />
            </button>
          </IconTip>
        </div>

        <nav className="flex flex-col gap-px">
          <button type="button" onClick={onFind} className={cn(ITEM, ITEM_INTERACTIVE)}>
            <Search {...ICON} className="shrink-0 text-ink-2" />
            <span className="truncate">Find</span>
            <kbd aria-hidden className="ml-auto pl-2 font-sans text-caption text-ink-3">⌘K</kbd>
          </button>
          <button
            type="button"
            onClick={() => openJournal(viewer)}
            aria-current={active?.kind === "journal" ? "page" : undefined}
            className={cn(ITEM, ITEM_INTERACTIVE, active?.kind === "journal" && ITEM_CURRENT)}
          >
            <BookOpen {...ICON} className={cn("shrink-0", active?.kind === "journal" ? "text-ink" : "text-ink-2")} />
            <span className="truncate">Journal</span>
          </button>
          {inbox ? (
            <button
              type="button"
              onClick={(e) => viewer.go({ kind: "room", roomId: inbox.id }, wantsNewTab(e))}
              onAuxClick={(e) => e.button === 1 && viewer.go({ kind: "room", roomId: inbox.id }, true)}
              aria-current={inbox.id === activeRoomId ? "page" : undefined}
              className={cn(ITEM, ITEM_INTERACTIVE, inbox.id === activeRoomId && ITEM_CURRENT)}
            >
              <Inbox {...ICON} className={cn("shrink-0", inbox.id === activeRoomId ? "text-ink" : "text-ink-2")} />
              <span className="truncate">Inbox</span>
              {inbox.artifactCount > 0 ? (
                <span className="ml-auto pl-2 text-caption font-normal text-ink-3 tabular-nums">{inbox.artifactCount}</span>
              ) : null}
            </button>
          ) : null}
        </nav>

        <div className={cn(SECTION, "mt-3")}>
          <span>Rooms</span>
          {readOnly ? null : (
            <IconTip label="New room">
              <button
                type="button"
                aria-label="New room"
                onClick={() => setCreating(true)}
                className="grid size-6 place-items-center rounded-md text-ink-3 hover:bg-row-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-ink"
              >
                <Plus size={14} strokeWidth={1.5} aria-hidden />
              </button>
            </IconTip>
          )}
        </div>

        <ul aria-label="Rooms" className="no-scrollbar flex min-h-0 flex-1 flex-col gap-px overflow-y-auto">
          {creating && !readOnly ? <NewRoomRow onDone={() => setCreating(false)} /> : null}
          <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[verticalOnly]} onDragEnd={onDragEnd}>
            <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
              {listed.map((room) => (
                <RoomRow
                  key={room.id}
                  room={room}
                  active={room.id === activeRoomId}
                  unread={unread(room)}
                  readOnly={readOnly}
                  sortable={!readOnly}
                  onMove={readOnly || !isDropTarget(room) ? undefined : move}
                />
              ))}
            </SortableContext>
          </DndContext>
        </ul>
        <PluginItems />
        {moveFailed.shown ? (
          <p role="status" className="mt-2 flex items-center gap-1.5 px-2 text-small text-error">
            <CircleAlert size={14} aria-hidden className="shrink-0" />
            {moveError}
          </p>
        ) : null}
      </div>
    </ShadcnSidebar>
  );
}

/** Docs can be dropped on owned, available rooms other than the inbox. */
const isDropTarget = (room: Room) => room.kind === "owned" && room.id !== INBOX_ID && room.status === "ok";

/** Rooms only move up and down. */
const verticalOnly: Modifier = ({ transform }) => ({ ...transform, x: 0 });

/** `rooms` in the `order` of ids (rooms it doesn't list keep their place at the end); `rooms` when there is none. */
function inOrder(rooms: Room[], order: string[] | null): Room[] {
  if (!order) return rooms;
  const byId = new Map(rooms.map((r) => [r.id, r]));
  const listed = new Set(order);
  return [...order.flatMap((id) => byId.get(id) ?? []), ...rooms.filter((r) => !listed.has(r.id))];
}

import { useState, type ReactNode } from "react";
import { closestCenter, DndContext, DragOverlay, KeyboardSensor, PointerSensor, useSensor, useSensors, type Modifier } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { Room } from "@alto-rooms/protocol-ts";
import { Folder } from "lucide-react";
import { RoomDot } from "@/components/RoomDot";
import { cn } from "@/lib/utils";
import { DRAG_KEYBOARD_CODES } from "./dragKeys";
import { ICON, ITEM } from "./sidebarItem";

/**
 * One sidebar section of rooms ("Pinned", "Rooms") as its own sortable list, so a room can only be
 * dragged within its section. While a room is carried, the rows part where it would land, a thread
 * line marks the gap (RoomRow), and a lifted copy follows the pointer.
 */
export function RoomList({
  label,
  rooms,
  onReorder,
  renderRow,
  children,
}: {
  label: string;
  rooms: Room[];
  /** `to`: the room's new index within this list. */
  onReorder: (id: string, to: number) => void;
  renderRow: (room: Room) => ReactNode;
  /** Rows before the rooms (the new room field). */
  children?: ReactNode;
}) {
  const [carriedId, setCarriedId] = useState<string | null>(null);
  const sensors = useSensors(
    // A few pixels of movement before a drag starts, so a click still opens the room.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    // Space picks a room up, ↑/↓ move it, Space drops; Enter keeps opening the room.
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates, keyboardCodes: DRAG_KEYBOARD_CODES }),
  );
  const ids = rooms.map((r) => r.id);
  const carried = rooms.find((r) => r.id === carriedId);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={({ active }) => setCarriedId(String(active.id))}
      onDragCancel={() => setCarriedId(null)}
      onDragEnd={({ active, over }) => {
        setCarriedId(null);
        const from = ids.indexOf(String(active.id));
        const to = over ? ids.indexOf(String(over.id)) : -1;
        if (from >= 0 && to >= 0 && from !== to) onReorder(String(active.id), to);
      }}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <ul aria-label={label} className="flex flex-col gap-px">
          {children}
          {rooms.map(renderRow)}
        </ul>
      </SortableContext>
      <DragOverlay modifiers={[withinList]} dropAnimation={null}>
        {carried ? (
          <div className={cn(ITEM, "cursor-grabbing bg-sheet font-medium shadow-[var(--elev-lift),0_0_0_.5px_var(--hairline-strong)]")}>
            {carried.color ? <RoomDot color={carried.color} /> : <Folder {...ICON} className="shrink-0 text-ink-3" />}
            <span className="truncate">{carried.name}</span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

/** The carried room moves only up and down, and only over its own list. */
const withinList: Modifier = ({ transform, draggingNodeRect, containerNodeRect }) => {
  if (!draggingNodeRect || !containerNodeRect) return { ...transform, x: 0 };
  const top = containerNodeRect.top - draggingNodeRect.top;
  const bottom = containerNodeRect.bottom - draggingNodeRect.bottom;
  return { ...transform, x: 0, y: Math.min(Math.max(transform.y, top), bottom) };
};

import type { RoomColor } from "@alto-rooms/protocol-ts";
import { roomTint } from "@/lib/roomTint";
import { cn } from "@/lib/utils";

/** A pinned room's colour as a dot, centred in a 16px box so it can stand in for the folder icon. */
export function RoomDot({ color, className }: { color: RoomColor; className?: string }) {
  return (
    <span aria-hidden className={cn("grid size-4 shrink-0 place-items-center", className)}>
      <span {...roomTint(color)} className="size-2 rounded-full bg-room-dot shadow-[inset_0_0_0_.5px_var(--dot-edge)]" />
    </span>
  );
}

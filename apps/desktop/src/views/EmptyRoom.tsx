import type { Room } from "@alto-rooms/protocol-ts";
import { ClewPeek } from "@/components/ClewPeek";
import { tildePath } from "@/lib/paths";
import { CopyChip } from "./CopyChip";

/**
 * A room with no docs: Clew peeking out of the water, the hint, and the
 * folder path as a chip (`~` for the user's home). Clicking the chip copies
 * the absolute path. `home` is the rooms home (`Info.home`).
 */
export function EmptyRoom({ room, home }: { room: Room; home: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
      <ClewPeek label="Clew the otter, peeking out of the water" className="mb-2 w-[220px]" />
      <p className="font-display text-title text-ink">No docs yet</p>
      <CopyChip text={room.path} label={tildePath(room.path, home)} className="mt-2" />
    </div>
  );
}

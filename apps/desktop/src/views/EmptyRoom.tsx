import type { Room } from "@alto-rooms/protocol-ts";
import clewPeek from "@/assets/clew-peek.svg";
import { tildePath } from "@/lib/paths";
import { CopyChip } from "./CopyChip";

/**
 * A room with no artifacts: Clew peeking out of the water, the hint, and the
 * folder path as a chip (`~` for the user's home). Clicking the chip copies
 * the absolute path. `home` is the rooms home (`Info.home`).
 */
export function EmptyRoom({ room, home }: { room: Room; home: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
      <img src={clewPeek} alt="Clew the otter, peeking out of the water" width={220} className="mb-2 h-auto w-[220px]" />
      <p className="text-[17px] text-ink">No artifacts yet</p>
      <p className="text-[15px] text-ink-2">Ask your agent to save HTML into this folder</p>
      <CopyChip text={room.path} label={tildePath(room.path, home)} className="mt-2" />
    </div>
  );
}

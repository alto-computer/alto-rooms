import type { ReactNode } from "react";
import type { Room, RoomColor } from "@alto-rooms/protocol-ts";
import { AppWindow, Copy, TextCursorInput } from "lucide-react";
import { toast } from "sonner";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useClient, useRoomList, useViewerStore } from "@/data/hooks";
import { errorCopy } from "@/lib/errors";
import { ROOM_COLOR_NAMES, ROOM_COLORS, roomTint } from "@/lib/roomTint";
import { cn } from "@/lib/utils";

const NONE = "none";
const TOAST_ID = "room-menu";

/** A colour's swatch in the menu: the dot at 12px, or an empty ring for None. */
function Swatch({ color }: { color: RoomColor | null }) {
  return (
    <span
      aria-hidden
      {...roomTint(color)}
      className={cn(
        "size-3 shrink-0 rounded-full",
        color ? "bg-room-dot shadow-[inset_0_0_0_.5px_var(--dot-edge)]" : "shadow-[inset_0_0_0_1.25px_var(--ink-3)]",
      )}
    />
  );
}

/** Right-click on a sidebar room: open it in a new tab, copy its path, pin it with a colour, rename it. */
export function RoomMenu({ room, readOnly, onRename, children }: { room: Room; readOnly: boolean; onRename: () => void; children: ReactNode }) {
  const viewer = useViewerStore();
  const client = useClient();
  const rooms = useRoomList();
  /** The other pinned rooms by colour, so the menu can say which colours are taken. */
  const usedBy = (color: RoomColor) =>
    rooms
      .filter((r) => r.color === color && r.id !== room.id)
      .map((r) => r.name)
      .join(", ");

  const setColor = (value: string) => {
    const color = value === NONE ? null : (value as RoomColor);
    if (color === room.color) return;
    client.setRoomColor(room.id, color).catch((e: unknown) => {
      console.warn("could not set the room colour", e);
      toast.error(errorCopy(e), { id: TOAST_ID });
    });
  };
  const copyPath = () => {
    navigator.clipboard.writeText(room.path).then(
      () => toast("Copied folder path", { id: TOAST_ID }),
      () => toast.error("Couldn't copy the path", { id: TOAST_ID }),
    );
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent aria-label={`${room.name} menu`} className="w-[232px]">
        <ContextMenuItem onSelect={() => viewer.go({ kind: "room", roomId: room.id }, true)}>
          <AppWindow />
          Open in New Tab
        </ContextMenuItem>
        <ContextMenuItem onSelect={copyPath}>
          <Copy />
          Copy Folder Path
        </ContextMenuItem>
        {readOnly ? null : (
          <>
            <ContextMenuSeparator />
            <ContextMenuSub>
              <ContextMenuSubTrigger>
                <Swatch color={room.color} />
                Colour
              </ContextMenuSubTrigger>
              <ContextMenuSubContent aria-label="Colour" className="w-[236px]">
                <ContextMenuRadioGroup value={room.color ?? NONE} onValueChange={setColor}>
                  <ContextMenuRadioItem value={NONE}>
                    <Swatch color={null} />
                    None
                    <span className="ml-auto pl-3 text-small text-ink-3">Not pinned</span>
                  </ContextMenuRadioItem>
                  <ContextMenuSeparator />
                  {ROOM_COLORS.map((color) => {
                    const used = usedBy(color);
                    return (
                      <ContextMenuRadioItem key={color} value={color}>
                        <Swatch color={color} />
                        {ROOM_COLOR_NAMES[color]}
                        {used ? <span className="ml-auto max-w-[130px] truncate pl-3 text-small text-ink-3">{used}</span> : null}
                      </ContextMenuRadioItem>
                    );
                  })}
                </ContextMenuRadioGroup>
                <ContextMenuSeparator />
                <p className="px-2 pt-1.5 pb-1 text-caption text-ink-3">
                  {room.color ? "None unpins this room." : "Picking a colour pins this room."}
                </p>
              </ContextMenuSubContent>
            </ContextMenuSub>
            <ContextMenuItem onSelect={onRename}>
              <TextCursorInput />
              Rename…
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

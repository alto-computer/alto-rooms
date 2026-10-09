import type { ReactNode } from "react";
import type { Conversation, Room } from "@alto-rooms/protocol-ts";
import { Folder, FolderMinus } from "lucide-react";
import { toast } from "sonner";
import { AgentMark } from "@/components/AgentMark";
import { RoomDot } from "@/components/RoomDot";
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
import { useClient, useReadOnly, useRoomList } from "@/data/hooks";
import { AGENT_NAMES } from "@/lib/agents";
import { conversationRooms, conversationTitle } from "@/lib/conversations";
import { errorCopy } from "@/lib/errors";
import { continueIn } from "./ContinueButton";

const TOAST_ID = "conversation-menu";

/** Opens the conversation menu of the row or card holding `el`, under `el` (the ⋯ button's way in). */
export function openConversationMenu(el: HTMLElement): void {
  const r = el.getBoundingClientRect();
  el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left, clientY: r.bottom + 4 }));
}

function RoomItem({ room }: { room: Room }) {
  return (
    <ContextMenuRadioItem value={room.id}>
      {room.color ? <RoomDot color={room.color} className="size-3.5" /> : <Folder className="text-ink-3" />}
      <span className="min-w-0 truncate">{room.name}</span>
    </ContextMenuRadioItem>
  );
}

/**
 * Right-click on a conversation (or its ⋯, or Shift-F10 on it): continue it, and put it in a room. A conversation is in
 * at most one room, so the menu offers "Add to Room" until it is in one, then "Move to Room" and
 * "Remove from Room". The room list puts pinned rooms first and scrolls when long.
 */
export function ConversationMenu({ conversation, children }: { conversation: Conversation; children: ReactNode }) {
  const client = useClient();
  const readOnly = useReadOnly();
  const { pinned, others } = conversationRooms(useRoomList());
  const inRoom = conversation.roomId !== null;

  const setRoom = (roomId: string | null) => {
    if (roomId === conversation.roomId) return;
    client.setConversationRoom(conversation.id, roomId).catch((e: unknown) => {
      console.warn("could not change the conversation's room", e);
      toast.error(errorCopy(e), { id: TOAST_ID });
    });
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger
        asChild
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget || !(e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey))) return;
          e.preventDefault();
          openConversationMenu(e.currentTarget);
        }}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent aria-label={`${conversationTitle(conversation)} menu`} className="w-[220px]">
        <ContextMenuItem onSelect={() => continueIn(conversation)}>
          <AgentMark agent={conversation.id.agent} />
          Continue in {AGENT_NAMES[conversation.id.agent]}
        </ContextMenuItem>
        {readOnly || pinned.length + others.length === 0 ? null : (
          <>
            <ContextMenuSeparator />
            <ContextMenuSub>
              <ContextMenuSubTrigger>{inRoom ? "Move to Room" : "Add to Room"}</ContextMenuSubTrigger>
              <ContextMenuSubContent
                className="max-h-[min(360px,var(--radix-context-menu-content-available-height))] w-[208px] overflow-y-auto"
              >
                <ContextMenuRadioGroup value={conversation.roomId ?? ""} onValueChange={setRoom}>
                  {pinned.map((r) => (
                    <RoomItem key={r.id} room={r} />
                  ))}
                  {pinned.length && others.length ? <ContextMenuSeparator /> : null}
                  {others.map((r) => (
                    <RoomItem key={r.id} room={r} />
                  ))}
                </ContextMenuRadioGroup>
              </ContextMenuSubContent>
            </ContextMenuSub>
            {inRoom ? (
              <ContextMenuItem onSelect={() => setRoom(null)}>
                <FolderMinus />
                Remove from Room
              </ContextMenuItem>
            ) : null}
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

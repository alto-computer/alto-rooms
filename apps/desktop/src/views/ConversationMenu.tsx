import type { ReactNode } from "react";
import type { Conversation, Room } from "@alto-rooms/protocol-ts";
import { ChevronDown, Folder, FolderMinus, FolderPlus } from "lucide-react";
import { toast } from "sonner";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useClient, useReadOnly, useRoomList, useViewerStore } from "@/data/hooks";
import { conversationRooms, conversationTitle } from "@/lib/conversations";
import { errorCopy } from "@/lib/errors";
import { wantsNewTab } from "@/lib/nav";

const TOAST_ID = "conversation-menu";

/** Opens the conversation menu of the row or card holding `el`, under `el` (the ⋯ button's way in). */
export function openConversationMenu(el: HTMLElement): void {
  const r = el.getBoundingClientRect();
  el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left, clientY: r.bottom + 4 }));
}

function RoomMark({ room }: { room: Room }) {
  return room.color ? <RoomDot color={room.color} className="size-3.5" /> : <Folder strokeWidth={1.75} className="size-3.5 shrink-0 text-ink-3" />;
}

function RoomItem({ room }: { room: Room }) {
  return (
    <ContextMenuRadioItem value={room.id}>
      <RoomMark room={room} />
      <span className="min-w-0 truncate">{room.name}</span>
    </ContextMenuRadioItem>
  );
}

/** Whether this viewer can put a conversation in a room: not read-only, and some room besides the inbox exists. */
export function useCanMoveConversation(): boolean {
  const readOnly = useReadOnly();
  const { pinned, others } = conversationRooms(useRoomList());
  return !readOnly && pinned.length + others.length > 0;
}

/** The rooms a conversation can go to, and the call that puts it in one (or none, with `null`). */
function useConversationRoom(conversation: Conversation) {
  const client = useClient();
  const movable = useCanMoveConversation();
  const { pinned, others } = conversationRooms(useRoomList());
  const setRoom = (roomId: string | null) => {
    if (roomId === conversation.roomId) return;
    client.setConversationRoom(conversation.id, roomId).catch((e: unknown) => {
      console.warn("could not change the conversation's room", e);
      toast.error(errorCopy(e), { id: TOAST_ID });
    });
  };
  return { pinned, others, setRoom, movable };
}

/**
 * Right-click on a conversation (or its ⋯, or Shift-F10 on it) puts it in a room. A conversation is
 * in at most one room, so the menu offers "Add to Room" until it is in one, then "Move to Room" and
 * "Remove from Room". The room list puts pinned rooms first and scrolls when long. With nowhere to
 * move it, there is no menu. Continuing it is the session tab's job.
 */
export function ConversationMenu({ conversation, children }: { conversation: Conversation; children: ReactNode }) {
  const { pinned, others, setRoom, movable } = useConversationRoom(conversation);
  const inRoom = conversation.roomId !== null;
  if (!movable) return children;

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
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * The room chip in a session's toolbar: the room it is in, or "Add to Room". One click opens the
 * room list, pinned rooms first and the current one checked, and picking one moves the session
 * there. In a room, the menu also opens that room or takes the session out of it. Read-only, the
 * chip only opens the room it names.
 */
export function ConversationRoomMenu({ conversation, room }: { conversation: Conversation; room: Room | undefined }) {
  const viewer = useViewerStore();
  const { pinned, others, setRoom, movable } = useConversationRoom(conversation);
  if (!room && !movable) return null;
  const roomItem = (r: Room) => (
    <DropdownMenuRadioItem key={r.id} value={r.id}>
      <RoomMark room={r} />
      <span className="min-w-0 truncate">{r.name}</span>
    </DropdownMenuRadioItem>
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={room ? `Room: ${room.name}` : "Add to Room"}
        className="inline-flex h-7 max-w-[220px] min-w-0 shrink items-center gap-1.5 rounded-lg pr-2 pl-2.5 text-small font-medium whitespace-nowrap text-ink-2 shadow-[inset_0_0_0_1px_var(--hairline)] outline-none hover:bg-surface hover:text-ink focus-visible:outline-2 focus-visible:outline-ink data-[state=open]:bg-surface data-[state=open]:text-ink"
      >
        {room ? <RoomMark room={room} /> : <FolderPlus size={14} strokeWidth={1.75} aria-hidden className="shrink-0" />}
        <span className="min-w-0 truncate">{room ? room.name : "Add to Room"}</span>
        <ChevronDown size={12} aria-hidden className="shrink-0 text-ink-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="w-[220px]">
        {room ? (
          <DropdownMenuItem onClick={(e) => viewer.go({ kind: "room", roomId: room.id }, wantsNewTab(e))}>
            <RoomMark room={room} />
            <span className="min-w-0 truncate">Open {room.name}</span>
          </DropdownMenuItem>
        ) : null}
        {movable ? (
          <>
            {room ? <DropdownMenuSeparator /> : null}
            <DropdownMenuRadioGroup
              value={conversation.roomId ?? ""}
              onValueChange={setRoom}
              className="-mx-1 max-h-[296px] overflow-x-hidden overflow-y-auto px-1"
            >
              {pinned.map(roomItem)}
              {pinned.length && others.length ? <DropdownMenuSeparator /> : null}
              {others.map(roomItem)}
            </DropdownMenuRadioGroup>
            {room ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setRoom(null)}>
                  <FolderMinus />
                  Remove from Room
                </DropdownMenuItem>
              </>
            ) : null}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

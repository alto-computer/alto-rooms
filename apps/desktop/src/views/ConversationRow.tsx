import type { KeyboardEvent, MouseEvent } from "react";
import type { Conversation, Room } from "@alto-rooms/protocol-ts";
import { Ellipsis, Folder } from "lucide-react";
import { AgentMark } from "@/components/AgentMark";
import { RoomDot } from "@/components/RoomDot";
import { useReadOnly, useViewerStore } from "@/data/hooks";
import { conversationTab, conversationTitle } from "@/lib/conversations";
import { conversationDragSource } from "@/lib/drag";
import { wantsNewTab } from "@/lib/nav";
import { cn } from "@/lib/utils";
import { ConversationMenu, openConversationMenu, useCanMoveConversation } from "./ConversationMenu";

/** The one room a conversation is in, as a small chip: its dot when pinned, else a folder. */
export function RoomChip({ room }: { room: Room }) {
  return (
    <span className="inline-flex h-5 max-w-[180px] shrink-0 items-center gap-1.5 rounded-full bg-surface pr-2 pl-[7px] text-caption font-medium whitespace-nowrap text-ink-2">
      {room.color ? <RoomDot color={room.color} className="size-3" /> : <Folder size={12} strokeWidth={1.5} aria-hidden className="shrink-0" />}
      <span className="truncate">{room.name}</span>
    </span>
  );
}

/**
 * A conversation in the Journal: one 30px line, the agent's mark and the title, and a room chip
 * when it is in a room. A click opens it in a tab like an artifact (⌘-click or a middle click in a
 * new one); hover or focus shows a ⋯ for the room menu, which right-click also opens. It drags
 * onto a sidebar room.
 */
export function ConversationRow({ conversation, room, entryKey }: {
  conversation: Conversation;
  /** The room it is in, when that room is listed. */
  room: Room | undefined;
  entryKey: string;
}) {
  const readOnly = useReadOnly();
  const viewer = useViewerStore();
  const hasMenu = useCanMoveConversation();
  const title = conversationTitle(conversation);
  const open = (newTab: boolean) => viewer.go(conversationTab(conversation.id), newTab);
  // A native button clicks on Enter; ⌘-Enter opens a new tab instead.
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "Enter" || !wantsNewTab(e)) return;
    e.preventDefault();
    open(true);
  };
  return (
    <ConversationMenu conversation={conversation}>
      <div
        data-testid="day-conversation"
        data-entry-key={entryKey}
        role="group"
        aria-label={title}
        {...(readOnly ? {} : conversationDragSource({ id: conversation.id, roomId: conversation.roomId }))}
        className={cn(
          "group -ml-2 flex h-[30px] min-w-0 cursor-default items-center gap-1 rounded-lg pr-1.5 hover:bg-row-hover",
          "data-[state=open]:bg-row-hover data-[state=open]:shadow-[inset_0_0_0_1.5px_color-mix(in_srgb,var(--ink)_30%,transparent)]",
        )}
      >
        <button
          type="button"
          onClick={(e) => open(wantsNewTab(e))}
          onAuxClick={(e: MouseEvent) => e.button === 1 && open(true)}
          onKeyDown={onKeyDown}
          className="flex h-full min-w-0 flex-1 cursor-default items-center gap-2.5 rounded-lg pl-2 text-left outline-none focus-visible:outline-2 focus-visible:outline-ink"
        >
          <AgentMark agent={conversation.id.agent} labelled className="text-ink-2" />
          <span className="min-w-0 flex-1 truncate text-body text-ink">{title}</span>
          {room ? <RoomChip room={room} /> : null}
        </button>
        {/* While the menu is open the ⋯ stays, so focus can come back to it. */}
        {hasMenu ? (
          <button
            type="button"
            aria-label={`More for ${title}`}
            onClick={(e) => {
              e.stopPropagation();
              openConversationMenu(e.currentTarget);
            }}
            className="-ml-1 hidden size-6 shrink-0 place-items-center rounded-md text-ink-2 outline-none group-focus-within:grid group-hover:grid group-data-[state=open]:grid hover:bg-surface-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-ink"
          >
            <Ellipsis size={15} strokeWidth={1.75} aria-hidden />
          </button>
        ) : null}
      </div>
    </ConversationMenu>
  );
}

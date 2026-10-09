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
import { ContinueButton } from "./ContinueButton";
import { ConversationMenu, openConversationMenu } from "./ConversationMenu";

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
 * new one); hover or focus shows the continue pill and a ⋯ for the menu, which right-click also
 * opens. It drags onto a sidebar room.
 */
export function ConversationRow({ conversation, room, entryKey }: {
  conversation: Conversation;
  /** The room it is in, when that room is listed. */
  room: Room | undefined;
  entryKey: string;
}) {
  const readOnly = useReadOnly();
  const viewer = useViewerStore();
  const title = conversationTitle(conversation);
  const open = (newTab: boolean) => viewer.go(conversationTab(conversation.id), newTab);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    open(wantsNewTab(e));
  };
  const onAuxClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.button === 1) open(true);
  };
  return (
    <ConversationMenu conversation={conversation}>
      <div
        data-testid="day-conversation"
        data-entry-key={entryKey}
        role="group"
        tabIndex={0}
        aria-label={title}
        onClick={(e) => open(wantsNewTab(e))}
        onAuxClick={onAuxClick}
        onKeyDown={onKeyDown}
        {...(readOnly ? {} : conversationDragSource({ id: conversation.id, roomId: conversation.roomId }))}
        className={cn(
          "group -ml-2 flex h-[30px] min-w-0 cursor-default items-center gap-2.5 rounded-lg pr-1.5 pl-2 outline-none hover:bg-row-hover focus-visible:outline-2 focus-visible:outline-ink",
          "data-[state=open]:bg-row-hover data-[state=open]:shadow-[inset_0_0_0_1.5px_color-mix(in_srgb,var(--ink)_30%,transparent)]",
        )}
      >
        <AgentMark agent={conversation.id.agent} className="text-ink-2" />
        <span className="min-w-0 flex-1 truncate text-body text-ink">{title}</span>
        {room ? <RoomChip room={room} /> : null}
        <ContinueButton conversation={conversation} className="hidden group-focus-within:inline-flex group-hover:inline-flex" />
        {/* While the menu is open the ⋯ stays, so focus can come back to it. */}
        <button
          type="button"
          aria-label={`More for ${title}`}
          onClick={(e) => {
            e.stopPropagation();
            openConversationMenu(e.currentTarget);
          }}
          className="-ml-2 hidden size-6 shrink-0 place-items-center rounded-md text-ink-2 outline-none group-focus-within:grid group-hover:grid group-data-[state=open]:grid hover:bg-surface-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-ink"
        >
          <Ellipsis size={15} strokeWidth={1.75} aria-hidden />
        </button>
      </div>
    </ConversationMenu>
  );
}

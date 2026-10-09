import type { Conversation, ConversationId, Room } from "@alto-rooms/protocol-ts";
import { INBOX_ID } from "./drag";

/** `<agent>:<session>`, as roomsd keys a conversation. */
export const conversationKey = (id: ConversationId): string => `${id.agent}:${id.session}`;

export const sameConversation = (a: ConversationId, b: ConversationId): boolean => a.agent === b.agent && a.session === b.session;

/** How many words of the last reply stand in for a missing title. */
const FALLBACK_WORDS = 8;

/** The conversation's title, else the first words of its last reply, else "Untitled session". */
export function conversationTitle(c: Conversation): string {
  const title = c.title?.trim();
  if (title) return title;
  const words = c.lastReply?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (words.length === 0) return "Untitled session";
  return words.length > FALLBACK_WORDS ? `${words.slice(0, FALLBACK_WORDS).join(" ")}…` : words.join(" ");
}

/** The rooms a conversation can be added to, pinned first (the room list's own order): every room but the inbox. */
export function conversationRooms(rooms: readonly Room[]): { pinned: Room[]; others: Room[] } {
  const open = rooms.filter((r) => r.id !== INBOX_ID && r.kind !== "journal");
  return { pinned: open.filter((r) => r.color !== null), others: open.filter((r) => r.color === null) };
}

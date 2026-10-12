import type { Room, Session, SessionRef, Source } from "@alto-rooms/protocol-ts";
import type { TabInput } from "@/data/viewerStore";
import { isAgent, isSessionId } from "./agents";
import { clockTime, localDate, monthDay } from "./dates";
import { INBOX_ID } from "./drag";

/** `<agent>:<id>`, as roomsd keys a session. A `Session` is a `SessionRef` too. */
export const sessionKey = (s: SessionRef): string => `${s.agent}:${s.id}`;

export const sameSession = (a: SessionRef, b: SessionRef): boolean => a.agent === b.agent && a.id === b.id;

/** Just the pointer, without the rest of a `Session`. */
export const toSessionRef = ({ agent, id }: SessionRef): SessionRef => ({ agent, id });

/** The session that wrote an artifact, when its source names an agent Rooms reads and a valid session id. */
export function sourceSessionRef(source: Source): SessionRef | null {
  const { agent, session } = source;
  return isAgent(agent) && isSessionId(session) ? { agent, id: session } : null;
}

/** How many words of the last reply stand in for a missing title. */
const FALLBACK_WORDS = 8;

/** The session's title, else the first words of its last reply, else "Untitled session". */
export function sessionTitle(session: Session): string {
  const title = session.title?.trim();
  if (title) return title;
  const words = session.lastReply?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (words.length === 0) return "Untitled session";
  return words.length > FALLBACK_WORDS ? `${words.slice(0, FALLBACK_WORDS).join(" ")}…` : words.join(" ");
}

/** The rooms a session can be added to, pinned first (the room list's own order): every room but the inbox. */
export function sessionRooms(rooms: readonly Room[]): { pinned: Room[]; others: Room[] } {
  const open = rooms.filter((r) => r.id !== INBOX_ID && r.kind !== "journal");
  return { pinned: open.filter((r) => r.color !== null), others: open.filter((r) => r.color === null) };
}

/** The tab a session opens in. */
export const sessionTab = (s: SessionRef): TabInput => ({ kind: "session", agent: s.agent, sessionId: s.id });

/** When it ran: `Today, 13:58 – 15:10`, `Oct 9, 13:58 – 15:10`, or `Oct 9, 23:50 – Oct 10, 00:10` over midnight. */
export function sessionSpan(session: Session, now: Date = new Date()): string {
  const day = (iso: string) => {
    const d = localDate(new Date(iso));
    return d === localDate(now) ? "Today" : monthDay(d);
  };
  const [start, end] = [session.startedAt, session.endedAt];
  const sameDay = localDate(new Date(start)) === localDate(new Date(end));
  const from = `${day(start)}, ${clockTime(start)}`;
  if (clockTime(start) === clockTime(end) && sameDay) return from;
  return `${from} – ${sameDay ? "" : `${day(end)}, `}${clockTime(end)}`;
}

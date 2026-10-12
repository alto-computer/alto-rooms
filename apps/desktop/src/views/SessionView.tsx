import type { ReactNode } from "react";
import type { Artifact, Info, Room, Session, SessionRef } from "@alto-rooms/protocol-ts";
import { BookOpen, ChevronRight, Folder } from "lucide-react";
import { AgentMark } from "@/components/AgentMark";
import { RoomDot } from "@/components/RoomDot";
import { useInfo, useJournalDays, useRoomList, useViewerStore } from "@/data/hooks";
import { useSession } from "@/data/useSession";
import { AGENT_NAMES } from "@/lib/agents";
import { sameSession, sessionSpan, sessionTitle, sourceSessionRef } from "@/lib/sessions";
import { addDays, count, localDate, monthDay } from "@/lib/dates";
import { INBOX_ID } from "@/lib/drag";
import { GENERIC_ERROR } from "@/lib/errors";
import { wantsNewTab } from "@/lib/nav";
import { tildePath } from "@/lib/paths";
import { AskBar } from "@/ask/AskBar";
import { ContinueButton } from "./ContinueButton";
import { SessionRoomMenu } from "./SessionMenu";
import { ArtifactEntry } from "./Daybook";

/** collect.db keeps this many characters of a message; a last reply this long was cut there. */
const PREVIEW_CHARS = 240;

const crumbButton =
  "-mx-1.5 flex min-w-0 items-center gap-[7px] rounded-md px-1.5 py-0.5 outline-none hover:bg-row-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-ink";

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 items-center justify-center bg-pane p-12 text-center text-heading text-ink-2">{children}</div>;
}

/** Room › title when it is in a room, else Journal › the day it was last active › title. Each step opens its tab. */
function Breadcrumb({ session, room }: { session: Session; room: Room | undefined }) {
  const viewer = useViewerStore();
  const day = localDate(new Date(session.endedAt));
  const chevron = <ChevronRight size={12} className="shrink-0 text-ink-3" aria-hidden />;
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-[7px] text-body whitespace-nowrap text-ink-2">
      {room ? (
        <button
          type="button"
          onClick={(e) => viewer.go({ kind: "room", roomId: room.id }, wantsNewTab(e))}
          onAuxClick={(e) => e.button === 1 && viewer.go({ kind: "room", roomId: room.id }, true)}
          className={crumbButton}
        >
          {room.color ? <RoomDot color={room.color} className="size-3.5" /> : <Folder size={14} className="shrink-0 text-ink-3" aria-hidden />}
          <span className="truncate">{room.name}</span>
        </button>
      ) : (
        <>
          <span className="flex items-center gap-[7px]">
            <BookOpen size={14} className="shrink-0 text-ink-3" aria-hidden />
            Journal
          </span>
          {chevron}
          <button
            type="button"
            onClick={(e) => viewer.go({ kind: "journal", date: day }, wantsNewTab(e))}
            onAuxClick={(e) => e.button === 1 && viewer.go({ kind: "journal", date: day }, true)}
            className={crumbButton}
          >
            {monthDay(day)}
          </button>
        </>
      )}
      {chevron}
      <span aria-current="page" className="truncate font-semibold text-ink">
        {sessionTitle(session)}
      </span>
    </nav>
  );
}

/** A session open longer than this is searched for its artifacts over its last this-many days. */
const MAX_SPAN_DAYS = 31;

/** The local days from `start` to `end`, both included, at most the last `MAX_SPAN_DAYS`. */
function daysOf(start: string, end: string): string[] {
  const days: string[] = [];
  for (let d = end; d >= start && days.length < MAX_SPAN_DAYS; d = addDays(d, -1)) days.unshift(d);
  return days;
}

/**
 * The artifacts this session wrote that a room holds: those whose source names this session, among
 * the artifacts of every day it was open (the Journal lists every room's artifacts by day).
 */
function useArtifactsWritten(session: Session): Artifact[] {
  const days = useJournalDays(daysOf(localDate(new Date(session.startedAt)), localDate(new Date(session.endedAt))));
  const mine = (a: Artifact) => {
    const writer = sourceSessionRef(a.source);
    return writer !== null && sameSession(writer, session);
  };
  const seen = new Set<string>();
  return days.flatMap((d) => d?.artifacts ?? []).filter((a) => mine(a) && !seen.has(a.id) && !!seen.add(a.id));
}

function placeOf(a: Artifact, info: Info, rooms: readonly Room[]): { label: string; room: Room | undefined } {
  const room = rooms.find((r) => r.id === a.roomId);
  if (a.roomId === INBOX_ID) return { label: "Inbox", room };
  if (a.roomId === info.journalRoomId) return { label: "Journal", room };
  return { label: room?.name ?? "Room", room };
}

/** What the session is, in one quiet line: agent · folder · when · how long. */
function MetaLine({ session, home }: { session: Session; home: string | undefined }) {
  return (
    <p className="flex min-w-0 items-center gap-1.5 text-small whitespace-nowrap text-ink-3">
      <span className="mr-1 grid size-[22px] shrink-0 place-items-center rounded-full text-ink-2 shadow-[inset_0_0_0_1px_var(--hairline-strong)]">
        <AgentMark agent={session.agent} className="size-3" />
      </span>
      <span className="font-medium text-ink-2">{AGENT_NAMES[session.agent]}</span>
      {session.cwd ? (
        <>
          <span aria-hidden>·</span>
          <span className="min-w-0 truncate font-mono">{home ? tildePath(session.cwd, home) : session.cwd}</span>
        </>
      ) : null}
      <span aria-hidden>·</span>
      <span>{sessionSpan(session)}</span>
      <span aria-hidden>·</span>
      <span>{count(session.messages, "message")}</span>
    </p>
  );
}

function Loaded({ session }: { session: Session }) {
  const info = useInfo();
  const rooms = useRoomList();
  const room = rooms.find((r) => r.id === session.roomId);
  const written = useArtifactsWritten(session);
  const agent = AGENT_NAMES[session.agent];
  const reply = session.lastReply?.trim();

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-pane">
      <header className="flex h-[52px] shrink-0 items-center gap-3 pr-4 pl-5">
        <Breadcrumb session={session} room={room} />
        <div role="group" aria-label="Session actions" className="ml-auto flex shrink-0 items-center gap-2">
          <SessionRoomMenu session={session} room={room} />
          <ContinueButton session={session} />
        </div>
      </header>
      <div className="relative flex min-h-0 flex-1">
        <div data-scroll-root className="min-h-0 flex-1 overflow-y-auto">
          <article aria-label={sessionTitle(session)} className="mx-auto max-w-[736px] px-14 pt-7 pb-44">
            <MetaLine session={session} home={info?.home} />
            <h1 className="mt-3 font-serif text-title leading-[1.36] font-medium text-pretty break-keep text-ink [overflow-wrap:anywhere]">{sessionTitle(session)}</h1>
            {reply ? (
              <section aria-label="Last reply" className="mt-8">
                <h2 className="flex items-center gap-2 text-small text-ink-3">
                  <span className="font-semibold text-ink-2">{agent}</span>
                  last replied
                </h2>
                <blockquote className="mt-2 border-l-2 border-hairline-strong pl-4 text-lead break-keep text-ink-2 [overflow-wrap:anywhere]">
                  {reply}
                  {reply.length >= PREVIEW_CHARS ? "…" : null}
                </blockquote>
              </section>
            ) : null}
            {written.length && info ? (
              <section aria-label="Artifacts it wrote" className="mt-9">
                <h2 className="mb-3 text-small font-semibold tracking-[0.02em] text-ink-3">{written.length === 1 ? "Wrote an artifact" : `Wrote ${count(written.length, "artifact")}`}</h2>
                <ul className="flex flex-col gap-3">
                  {written.map((a) => {
                    const { label, room: home } = placeOf(a, info, rooms);
                    return (
                      <li key={a.id}>
                        <ArtifactEntry artifact={a} label={label} color={home?.color ?? null} info={info} />
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : null}
          </article>
        </div>
        <AskBar subject={{ kind: "session", session }} />
      </div>
    </div>
  );
}

/**
 * A session tab: the breadcrumb, its room menu and "Continue in <Agent>" over what the logs say of
 * it (agent, folder, when, how many messages), its title, the start of its last reply and the
 * artifacts it wrote. The ask bar below asks the agent in a fork of this same session.
 */
export function SessionView({ sessionRef }: { sessionRef: SessionRef }) {
  const session = useSession(sessionRef);
  if (session === undefined) return <div className="flex-1 bg-pane" />;
  if (session === null) return <Centered>This session is gone</Centered>;
  if (session === "error") return <Centered>{GENERIC_ERROR}</Centered>;
  return <Loaded session={session} />;
}

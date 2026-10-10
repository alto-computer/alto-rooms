import type { ReactNode } from "react";
import type { Artifact, Conversation, ConversationId, Info, Room } from "@alto-rooms/protocol-ts";
import { BookOpen, ChevronRight, Folder } from "lucide-react";
import { AgentMark } from "@/components/AgentMark";
import { RoomDot } from "@/components/RoomDot";
import { useInfo, useJournalDays, useRoomList, useViewerStore } from "@/data/hooks";
import { useConversation } from "@/data/useConversation";
import { AGENT_NAMES } from "@/lib/agents";
import { conversationSpan, conversationTitle } from "@/lib/conversations";
import { addDays, count, localDate, monthDay } from "@/lib/dates";
import { INBOX_ID } from "@/lib/drag";
import { GENERIC_ERROR } from "@/lib/errors";
import { wantsNewTab } from "@/lib/nav";
import { tildePath } from "@/lib/paths";
import { AskBar } from "@/ask/AskBar";
import { ContinueButton } from "./ContinueButton";
import { ConversationRoomMenu } from "./ConversationMenu";
import { ArtifactEntry } from "./Daybook";

/** collect.db keeps this many characters of a message; a last reply this long was cut there. */
const PREVIEW_CHARS = 240;

const crumbButton =
  "-mx-1.5 flex min-w-0 items-center gap-[7px] rounded-md px-1.5 py-0.5 outline-none hover:bg-row-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-ink";

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 items-center justify-center bg-pane p-12 text-center text-heading text-ink-2">{children}</div>;
}

/** Room › title when it is in a room, else Journal › the day it was last active › title. Each step opens its tab. */
function Breadcrumb({ conversation, room }: { conversation: Conversation; room: Room | undefined }) {
  const viewer = useViewerStore();
  const day = localDate(new Date(conversation.endedAt));
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
        {conversationTitle(conversation)}
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
function useArtifactsWritten(c: Conversation): Artifact[] {
  const days = useJournalDays(daysOf(localDate(new Date(c.startedAt)), localDate(new Date(c.endedAt))));
  const mine = (a: Artifact) => a.source.agent === c.id.agent && a.source.session === c.id.session;
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
function MetaLine({ conversation, home }: { conversation: Conversation; home: string | undefined }) {
  return (
    <p className="flex min-w-0 items-center gap-1.5 text-small whitespace-nowrap text-ink-3">
      <span className="mr-1 grid size-[22px] shrink-0 place-items-center rounded-full text-ink-2 shadow-[inset_0_0_0_1px_var(--hairline-strong)]">
        <AgentMark agent={conversation.id.agent} className="size-3" />
      </span>
      <span className="font-medium text-ink-2">{AGENT_NAMES[conversation.id.agent]}</span>
      {conversation.cwd ? (
        <>
          <span aria-hidden>·</span>
          <span className="min-w-0 truncate font-mono">{home ? tildePath(conversation.cwd, home) : conversation.cwd}</span>
        </>
      ) : null}
      <span aria-hidden>·</span>
      <span>{conversationSpan(conversation)}</span>
      <span aria-hidden>·</span>
      <span>{count(conversation.messages, "message")}</span>
    </p>
  );
}

function Loaded({ conversation }: { conversation: Conversation }) {
  const info = useInfo();
  const rooms = useRoomList();
  const room = rooms.find((r) => r.id === conversation.roomId);
  const written = useArtifactsWritten(conversation);
  const agent = AGENT_NAMES[conversation.id.agent];
  const reply = conversation.lastReply?.trim();

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-pane">
      <header className="flex h-[52px] shrink-0 items-center gap-3 pr-4 pl-5">
        <Breadcrumb conversation={conversation} room={room} />
        <div role="group" aria-label="Session actions" className="ml-auto flex shrink-0 items-center gap-2">
          <ConversationRoomMenu conversation={conversation} room={room} />
          <ContinueButton conversation={conversation} />
        </div>
      </header>
      <div className="relative flex min-h-0 flex-1">
        <div data-scroll-root className="min-h-0 flex-1 overflow-y-auto">
          <article aria-label={conversationTitle(conversation)} className="mx-auto max-w-[736px] px-14 pt-7 pb-44">
            <MetaLine conversation={conversation} home={info?.home} />
            <h1 className="mt-3 font-serif text-title leading-[1.36] font-medium text-pretty break-keep text-ink [overflow-wrap:anywhere]">{conversationTitle(conversation)}</h1>
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
        <AskBar subject={{ kind: "conversation", conversation }} />
      </div>
    </div>
  );
}

/**
 * A session tab: the breadcrumb, its room menu and "Continue in <Agent>" over what the logs say of
 * it (agent, folder, when, how many messages), its title, the start of its last reply and the
 * artifacts it wrote. The ask bar below asks the agent in a fork of this same session.
 */
export function ConversationView({ id }: { id: ConversationId }) {
  const conversation = useConversation(id);
  if (conversation === undefined) return <div className="flex-1 bg-pane" />;
  if (conversation === null) return <Centered>This session is gone</Centered>;
  if (conversation === "error") return <Centered>{GENERIC_ERROR}</Centered>;
  return <Loaded conversation={conversation} />;
}

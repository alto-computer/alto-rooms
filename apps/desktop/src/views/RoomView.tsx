import { useState, type ReactNode } from "react";
import type { Artifact, Conversation, Room } from "@alto-rooms/protocol-ts";
import { CircleAlert, FolderOpen } from "lucide-react";
import { AskBar } from "@/ask/AskBar";
import { useFrameAfter } from "@/ask/useFrameAfter";
import { Dotted } from "@/components/Dotted";
import { useScrollMemory } from "@/lib/scrollMemory";
import { useCurrentTabId } from "@/shell/currentTab";
import { useArtifacts, useClient, useInfo, useOpenDoc, useReadOnly, useRoomList, useScopeError } from "@/data/hooks";
import { useRoomConversations } from "@/data/useRoomConversations";
import { conversationKey } from "@/lib/conversations";
import { agoPhrase, count, isNewSince } from "@/lib/dates";
import { GENERIC_ERROR } from "@/lib/errors";
import { showInFinder } from "@/lib/native";
import { isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { ArtifactCard } from "./ArtifactCard";
import { ConversationCard } from "./ConversationCard";
import { EditableTitle } from "./EditableTitle";
import { EmptyRoom } from "./EmptyRoom";
import { bandButton, perchFor, RoomBand } from "./RoomBand";
import { SortBar } from "./SortBar";
import { useVisitsAtArrival } from "./useVisitsAtArrival";
import { INBOX_ID } from "@/lib/drag";

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 items-center justify-center p-12 text-center text-heading text-ink-2">{children}</div>;
}

/** `7 artifacts · 2 sessions · last added 12 min ago by claude-code`; `No artifacts yet` for an empty room. */
function roomMeta(room: Room, newest: Artifact | undefined, conversations: number): ReactNode {
  const talks = conversations ? count(conversations, "session") : null;
  if (room.artifactCount === 0) return <Dotted parts={["No artifacts yet", talks]} />;
  const added = newest ? `last added ${agoPhrase(newest.createdAt)}${newest.source.agent ? ` by ${newest.source.agent}` : ""}` : null;
  return <Dotted parts={[count(room.artifactCount, "artifact"), talks, added]} />;
}

type Filter = "all" | "artifacts" | "conversations";

/** All · Artifacts · Sessions, each with its count; shown only when the room has conversations. */
function FilterRow({ value, onChange, artifacts, conversations }: { value: Filter; onChange: (f: Filter) => void; artifacts: number; conversations: number }) {
  const options: [Filter, string, number][] = [
    ["all", "All", artifacts + conversations],
    ["artifacts", "Artifacts", artifacts],
    ["conversations", "Sessions", conversations],
  ];
  return (
    <div role="group" aria-label="Show" className="mx-10 mt-6 inline-flex gap-0.5 self-start rounded-[9px] bg-surface p-[3px] shadow-[inset_0_0_0_1px_var(--hairline)]">
      {options.map(([f, label, n]) => (
        <button
          key={f}
          type="button"
          aria-pressed={value === f}
          onClick={() => onChange(f)}
          className="inline-flex items-center gap-1.5 rounded-[7px] px-3 py-[5px] text-small font-medium text-ink-2 outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-ink aria-pressed:bg-sheet aria-pressed:text-ink aria-pressed:shadow-sheet"
        >
          {label}
          <span className="text-ink-3 tabular-nums">{n}</span>
        </button>
      ))}
    </div>
  );
}

/** The room's conversations, below its artifacts and quieter than them. */
function Conversations({ list, alone }: { list: Conversation[]; alone: boolean }) {
  return (
    <section aria-label="Sessions" className={cn("px-10 pb-10", alone && "pt-7")}>
      <h2 className="mb-3 text-small font-semibold tracking-[0.02em] text-ink-3">Sessions</h2>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(400px,1fr))] gap-4">
        {list.map((c) => (
          <ConversationCard key={conversationKey(c.id)} conversation={c} />
        ))}
      </div>
    </section>
  );
}

/**
 * A room tab: a header band (editable name, what's in it, actions), then a grid of artifact
 * cards newest first that wraps to the window's width, or the empty state. The whole tab scrolls.
 *
 * AppShell mounts this per activation (keyed by tab id, active tab only), so
 * the "New" baseline captured at mount is "the moment the tab became active".
 */
export function RoomView({ roomId }: { roomId: string }) {
  const rooms = useRoomList();
  const info = useInfo();
  const client = useClient();
  const openDoc = useOpenDoc();
  const artifacts = useArtifacts(roomId);
  const loadError = useScopeError(`room:${roomId}`);
  const room = rooms.find((r) => r.id === roomId);
  const readOnly = useReadOnly();
  const scrollRef = useScrollMemory<HTMLDivElement>(`${useCurrentTabId()}:room:${roomId}`, !!artifacts?.length && !!info);

  const baseline = useVisitsAtArrival().since(roomId);
  const conversations = useRoomConversations(roomId) ?? [];
  // A tab moved to another room starts that room on All.
  const [picked, setPicked] = useState<{ roomId: string; filter: Filter } | null>(null);
  const filter = picked?.roomId === roomId ? picked.filter : "all";
  const shows = (part: Exclude<Filter, "all">) => conversations.length === 0 || filter === "all" || filter === part;
  // The ask bar mounts once the cards have painted, so it never delays them.
  const barReady = useFrameAfter(artifacts !== undefined);

  if (!room) {
    // Before the first sync we can't tell; afterwards the room is gone.
    return info ? <Centered>This room is gone</Centered> : <div className="flex-1 bg-pane" />;
  }

  let body: ReactNode;
  if (!shows("artifacts")) {
    body = null;
  } else if (artifacts === undefined) {
    body = loadError ? <Centered>{GENERIC_ERROR}</Centered> : null;
  } else if (artifacts.length === 0) {
    body = info ? <EmptyRoom room={room} home={info.home} /> : null;
  } else {
    body = (
      <div data-grid className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-6 px-10 pt-7 pb-10">
        {info
          ? [...artifacts]
              .reverse()
              .map((a) => (
                <ArtifactCard
                  key={a.id}
                  artifact={a}
                  info={info}
                  isNew={isNewSince(a.createdAt, baseline)}
                  draggable={roomId === INBOX_ID && !readOnly}
                  onOpen={openDoc}
                />
              ))
          : null}
        {perchFor(artifacts.length) ? (
          <div className="grid min-h-40 place-items-center rounded-xl text-small text-ink-3 shadow-[inset_0_0_0_1.5px_var(--hairline)]">
            The next artifact lands here
          </div>
        ) : null}
      </div>
    );
  }

  return (
    // The ask bar floats over the bottom of the room; the page scrolls under it and its end clears it.
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} data-scroll-root className={cn("flex min-h-0 flex-1 flex-col overflow-y-auto [scrollbar-width:thin]", !readOnly && "pb-24")}>
        <RoomBand
          perch={info && artifacts ? perchFor(artifacts.length) : null}
          title={
            <EditableTitle
              key={room.id}
              value={room.name}
              readOnly={readOnly}
              ariaLabel="Room name"
              onSave={async (next) => {
                await client.renameRoom(room.id, next);
              }}
              className="font-display text-display font-medium tracking-[-0.015em] text-ink"
              inputClassName="-ml-2 w-full max-w-[560px] rounded-lg px-2 py-0.5 outline-2 outline-solid outline-ink"
            />
          }
          color={room.color}
          meta={
            <>
              {roomMeta(room, artifacts?.at(-1), conversations.length)}
              {room.status === "unavailable" ? (
                <span className="ml-2 flex items-center gap-1.5 text-error">
                  <CircleAlert size={14} aria-hidden />
                  Folder not found
                </span>
              ) : null}
            </>
          }
          actions={
            isTauri() ? (
              <button type="button" className={bandButton} onClick={() => void showInFinder(room.path)}>
                <FolderOpen aria-hidden />
                Show in Finder
              </button>
            ) : null
          }
        >
          {roomId === INBOX_ID && !readOnly ? (
            <div className="mt-3">
              <SortBar />
            </div>
          ) : null}
        </RoomBand>
        {conversations.length ? <FilterRow value={filter} onChange={(f) => setPicked({ roomId, filter: f })} artifacts={artifacts?.length ?? room.artifactCount} conversations={conversations.length} /> : null}
        {body}
        {conversations.length && shows("conversations") ? <Conversations list={conversations} alone={!shows("artifacts")} /> : null}
      </div>
      {barReady && !readOnly ? <AskBar subject={{ kind: "room", roomId }} /> : null}
    </div>
  );
}

import { useMemo, useRef } from "react";
import type { Artifact } from "@alto-rooms/protocol-ts";
import { useOpenDoc, useReadOnly, useRooms, useViewerStore, useWatchArtifacts } from "@/data/hooks";
import { count, dateLabel, isNewSince } from "@/lib/dates";
import { artifactDragSource, INBOX_ID } from "@/lib/drag";
import { OnboardingCard } from "./OnboardingCard";
import { wantsNewTab } from "@/lib/nav";
import { cn } from "@/lib/utils";
import { useScrollMemory } from "@/lib/scrollMemory";
import { useCurrentTabId } from "@/shell/currentTab";
import { useVisitsAtArrival } from "./useVisitsAtArrival";

/**
 * The new tab: per room, how many docs arrived since the last visit.
 *
 * AppShell mounts this per activation, so the baselines captured at mount are
 * "the moment the tab became active" (same as RoomView's dots).
 *
 * Only rooms whose `updatedAt` is after their baseline can have new docs, so
 * only those are loaded (and watched while the tab is open); the rest count 0.
 * The inbox is always watched, for "Waiting for a room".
 *
 * When no doc is new by createdAt but some rooms (inbox aside) have never been
 * visited, the subtitle counts those as "newly sorted rooms": an agent's links keep
 * the originals' (old) createdAt, so after onboarding nothing reads as new.
 *
 * First run (synced, and no rooms besides inbox): the welcome page takes the
 * place of the grid, in a centered 760px column. Before the first sync nothing is shown.
 */
export function NewTabView() {
  const viewer = useViewerStore();
  const { rooms, artifacts, errors, info } = useRooms();
  const readOnly = useReadOnly();
  const openDoc = useOpenDoc();
  const visits = useVisitsAtArrival();
  const { since } = visits;
  const changed = useMemo(
    () => rooms.filter((r) => r.updatedAt !== null && isNewSince(r.updatedAt, since(r.id))).map((r) => r.id),
    // `since` reads the baselines frozen at mount.
    [rooms],
  );
  const hasInbox = rooms.some((r) => r.id === INBOX_ID);
  const watched = useMemo(
    () => (hasInbox && !changed.includes(INBOX_ID) ? [...changed, INBOX_ID] : changed),
    [changed, hasInbox],
  );
  useWatchArtifacts(watched);

  // New-doc counts per room, recomputed only when that room's list changes.
  const counts = useRef(new WeakMap<readonly Artifact[], number>());
  const cards = useMemo(() => {
    const newCount = (roomId: string) => {
      const list = artifacts[roomId];
      if (!list) return 0;
      let n = counts.current.get(list);
      if (n === undefined) {
        const s = since(roomId);
        n = list.filter((a) => isNewSince(a.createdAt, s)).length;
        counts.current.set(list, n);
      }
      return n;
    };
    return rooms
      // An empty inbox has nothing to show (the sidebar hides it too).
      .filter((room) => room.id !== INBOX_ID || room.artifactCount > 0)
      .map((room) => ({ room, newCount: newCount(room.id) }))
      .sort((x, y) => y.newCount - x.newCount || x.room.name.localeCompare(y.room.name, "ko"));
  }, [rooms, artifacts]);

  // Only say anything once every room that needs loading has loaded (or failed to).
  const settled = info !== null && changed.every((id) => artifacts[id] !== undefined || errors[`room:${id}`] !== undefined);
  const roomsWithNew = cards.filter((c) => c.newCount > 0).length;
  // Rooms an agent organized since: never visited (no lastVisit entry), inbox aside.
  const neverVisited = rooms.filter((r) => r.id !== INBOX_ID && visits.lastVisit[r.id] === undefined).length;

  const inbox = useMemo(() => [...(artifacts[INBOX_ID] ?? [])].reverse(), [artifacts]);

  const shell = "flex flex-1 flex-col gap-8 overflow-y-auto bg-pane px-12 pb-10";
  const shellRef = useScrollMemory<HTMLDivElement>(`${useCurrentTabId()}:new`, settled);
  if (info === null) return <div className={cn(shell, "pt-10")} />;

  const waiting =
    inbox.length > 0 ? (
      <InboxList
        artifacts={inbox}
        draggable={!readOnly}
        onOpen={openDoc}
      />
    ) : null;

  if (rooms.every((r) => r.id === INBOX_ID)) {
    return (
      <div ref={shellRef} className={cn(shell, "pt-14")}>
        <OnboardingCard />
        {waiting ? <div className="mx-auto w-full max-w-[760px]">{waiting}</div> : null}
      </div>
    );
  }

  return (
    // Header at the same place and size as a room's or a note's, so switching tabs doesn't jump.
    <div ref={shellRef} className={cn(shell, "pt-10")}>
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-display leading-[1.25] font-medium tracking-[-0.01em] text-ink">Since your last visit</h1>
        {settled ? (
          <p className="text-lead text-ink-2">
            {roomsWithNew > 0
              ? `New artifacts in ${count(roomsWithNew, "room")}.`
              : neverVisited > 0
                ? `${count(neverVisited, "newly sorted room")}.`
                : "No new artifacts."}
          </p>
        ) : null}
      </header>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
        {cards.map(({ room, newCount }) => (
          <li key={room.id} className="contents">
            <button
              type="button"
              data-testid="new-room-card"
              onClick={(e) => viewer.go({ kind: "room", roomId: room.id }, wantsNewTab(e))}
              onAuxClick={(e) => e.button === 1 && viewer.go({ kind: "room", roomId: room.id }, true)}
              className="flex flex-col gap-1 rounded-xl border border-hairline bg-sheet px-5 py-[18px] text-left hover:bg-surface focus-visible:outline-2 focus-visible:outline-ink"
            >
              <span data-testid="new-room-name" className="text-heading font-medium text-ink">
                {room.name}
              </span>
              {newCount > 0 ? <span className="text-body text-ink">{newCount} new</span> : null}
              <span className="text-body text-ink-2">
                {room.status === "unavailable" ? "Folder not found" : count(room.artifactCount, "artifact")}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {waiting}
    </div>
  );
}

/** "Waiting for a room": inbox docs, newest first; rows open the doc and drag onto sidebar rooms. */
function InboxList({
  artifacts,
  draggable,
  onOpen,
}: {
  artifacts: Artifact[];
  draggable: boolean;
  onOpen: (a: Artifact, newTab: boolean) => void;
}) {
  const now = new Date();
  return (
    <section aria-labelledby="inbox-waiting" className="flex flex-col gap-2">
      <h2 id="inbox-waiting" className="text-heading font-medium text-ink">
        Waiting for a room
      </h2>
      <ul className="mt-1 flex flex-col gap-1">
        {artifacts.map((a) => (
          <li key={a.id}>
            <button
              type="button"
              data-testid="inbox-row"
              onClick={(e) => onOpen(a, wantsNewTab(e))}
              onAuxClick={(e) => e.button === 1 && onOpen(a, true)}
              {...(draggable ? artifactDragSource({ roomId: a.roomId, artifactId: a.id }) : {})}
              className="flex w-full min-w-0 items-baseline gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-surface focus-visible:outline-2 focus-visible:outline-ink"
            >
              <span data-testid="inbox-title" className="min-w-0 truncate text-lead font-medium text-ink">
                {a.title}
              </span>
              <span className="shrink-0 font-mono text-small text-ink-3">{dateLabel(a.createdAt, now)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

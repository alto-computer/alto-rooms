import { useMemo, useRef } from "react";
import type { Artifact } from "@alto-rooms/protocol-ts";
import { useReadOnly, useRooms, useViewer, useViewerStore, useWatchArtifacts } from "@/data/hooks";
import { dateLabel, isNewSince } from "@/lib/dates";
import { artifactDragSource, INBOX_ID } from "@/lib/drag";
import { OnboardingCard } from "./OnboardingCard";

/**
 * The new tab: per room, how many docs arrived since the last visit.
 *
 * AppShell mounts this per activation, so the baselines captured at mount are
 * "the moment the tab became active" (same as RoomView's dots).
 *
 * Only rooms whose `updatedAt` is after their baseline can have new docs, so
 * only those are loaded (and watched while the tab is open); the rest count 0.
 * The inbox is always watched, for "방을 기다리는 문서".
 *
 * First run (synced, and no rooms besides inbox): the onboarding card takes
 * the place of the grid. Before the first sync nothing is shown.
 */
export function NewTabView() {
  const viewer = useViewerStore();
  const { activeId, onboardingTabId } = useViewer();
  const { rooms, artifacts, errors, info } = useRooms();
  const readOnly = useReadOnly();

  const baselines = useRef<{ lastVisit: Record<string, string>; firstRunAt: string } | null>(null);
  if (baselines.current === null) {
    const v = viewer.getState();
    baselines.current = { lastVisit: v.lastVisit, firstRunAt: v.firstRunAt };
  }

  const since = (roomId: string) => baselines.current!.lastVisit[roomId] ?? baselines.current!.firstRunAt;
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
      .map((room) => ({ room, newCount: newCount(room.id) }))
      .sort((x, y) => y.newCount - x.newCount || x.room.name.localeCompare(y.room.name, "ko"));
  }, [rooms, artifacts]);

  // Only say anything once every room that needs loading has loaded (or failed to).
  const settled = info !== null && changed.every((id) => artifacts[id] !== undefined || errors[`room:${id}`] !== undefined);
  const roomsWithNew = cards.filter((c) => c.newCount > 0).length;

  const inbox = useMemo(() => [...(artifacts[INBOX_ID] ?? [])].reverse(), [artifacts]);

  const shell = "flex flex-1 flex-col gap-8 overflow-y-auto bg-white px-12 pt-14 pb-10";
  if (info === null) return <div className={shell} />;

  const waiting =
    inbox.length > 0 ? (
      <InboxList
        artifacts={inbox}
        draggable={!readOnly}
        onOpen={(a) => viewer.open({ kind: "doc", roomId: a.roomId, artifactId: a.id })}
      />
    ) : null;

  if (rooms.every((r) => r.id === INBOX_ID)) {
    return (
      <div className={shell}>
        <OnboardingCard />
        {waiting}
      </div>
    );
  }

  return (
    <div className={shell}>
      {onboardingTabId !== null && onboardingTabId === activeId ? <OnboardingCard compact /> : null}
      <header className="flex flex-col gap-2">
        <h1 className="text-[32px] font-medium text-ink">지난 방문 이후</h1>
        {settled ? (
          <p className="text-[17px] text-ink-2">
            {roomsWithNew > 0 ? `방 ${roomsWithNew}곳에 새 문서가 들어왔어요.` : "새로 들어온 문서가 없어요."}
          </p>
        ) : null}
      </header>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
        {cards.map(({ room, newCount }) => (
          <li key={room.id} className="contents">
            <button
              type="button"
              data-testid="new-room-card"
              onClick={() => viewer.open({ kind: "room", roomId: room.id })}
              className="flex flex-col gap-1 rounded-[14px] border border-[#ddd] bg-white px-5 py-[18px] text-left hover:bg-[#f7f7f7] focus-visible:outline-2 focus-visible:outline-ink"
            >
              <span data-testid="new-room-name" className="text-[18px] font-medium text-ink">
                {room.name}
              </span>
              {newCount > 0 ? <span className="text-[14px] text-ink">새 문서 {newCount}</span> : null}
              <span className="text-[14px] text-ink-2">
                {room.status === "unavailable" ? "폴더를 찾을 수 없어요" : `문서 ${room.artifactCount}`}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {waiting}
    </div>
  );
}

/** "방을 기다리는 문서": inbox docs, newest first; rows open the doc and drag onto sidebar rooms. */
function InboxList({ artifacts, draggable, onOpen }: { artifacts: Artifact[]; draggable: boolean; onOpen: (a: Artifact) => void }) {
  const now = new Date();
  return (
    <section aria-labelledby="inbox-waiting" className="flex flex-col gap-2">
      <h2 id="inbox-waiting" className="text-[18px] font-medium text-ink">
        방을 기다리는 문서
      </h2>
      {draggable ? <p className="text-[13px] text-ink-3">카드를 왼쪽 방에 끌어다 놓으면 옮겨져요</p> : null}
      <ul className="mt-1 flex flex-col gap-1">
        {artifacts.map((a) => (
          <li key={a.id}>
            <button
              type="button"
              data-testid="inbox-row"
              onClick={() => onOpen(a)}
              {...(draggable ? artifactDragSource({ roomId: a.roomId, artifactId: a.id }) : {})}
              className="flex w-full min-w-0 items-baseline gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-[#f7f7f7] focus-visible:outline-2 focus-visible:outline-ink"
            >
              <span data-testid="inbox-title" className="min-w-0 truncate text-[16px] font-medium text-ink">
                {a.title}
              </span>
              <span className="shrink-0 font-mono text-[12px] text-ink-3">{dateLabel(a.createdAt, now)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

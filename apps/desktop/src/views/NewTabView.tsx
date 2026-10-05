import { useMemo, useRef } from "react";
import type { Artifact } from "@alto-rooms/protocol-ts";
import { useRooms, useViewerStore, useWatchArtifacts } from "@/data/hooks";
import { isNewSince } from "@/lib/dates";

/**
 * The new tab: per room, how many docs arrived since the last visit.
 *
 * AppShell mounts this per activation, so the baselines captured at mount are
 * "the moment the tab became active" (same as RoomView's dots).
 *
 * Only rooms whose `updatedAt` is after their baseline can have new docs, so
 * only those are loaded (and watched while the tab is open); the rest count 0.
 */
export function NewTabView() {
  const viewer = useViewerStore();
  const { rooms, artifacts, errors, info } = useRooms();

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
  useWatchArtifacts(changed);

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

  return (
    <div className="flex flex-1 flex-col gap-8 overflow-y-auto bg-white px-12 pt-14 pb-10">
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
    </div>
  );
}

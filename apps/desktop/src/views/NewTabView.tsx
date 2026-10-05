import { useEffect, useMemo, useRef } from "react";
import { useRooms, useRoomsStore, useViewerStore } from "@/data/hooks";
import { isNewSince } from "@/lib/dates";

/**
 * The new tab: per room, how many docs arrived since the last visit.
 *
 * AppShell mounts this per activation, so the baselines captured at mount are
 * "the moment the tab became active" (same as RoomView's dots).
 */
export function NewTabView() {
  const store = useRoomsStore();
  const viewer = useViewerStore();
  const { rooms, artifacts, errors, info } = useRooms();

  const baselines = useRef<{ lastVisit: Record<string, string>; firstRunAt: string } | null>(null);
  if (baselines.current === null) {
    const v = viewer.getState();
    baselines.current = { lastVisit: v.lastVisit, firstRunAt: v.firstRunAt };
  }

  useEffect(() => {
    for (const r of rooms) void store.loadArtifacts(r.id);
  }, [store, rooms]);

  const cards = useMemo(() => {
    const b = baselines.current!;
    return rooms
      .map((room) => {
        const list = artifacts[room.id];
        const since = b.lastVisit[room.id] ?? b.firstRunAt;
        const newCount = list ? list.filter((a) => isNewSince(a.createdAt, since)).length : 0;
        return { room, newCount };
      })
      .sort((x, y) => y.newCount - x.newCount || x.room.name.localeCompare(y.room.name, "ko"));
  }, [rooms, artifacts]);

  // Only say anything once every room has loaded (or failed to).
  const settled = info !== null && rooms.every((r) => artifacts[r.id] !== undefined || errors[`room:${r.id}`] !== undefined);
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

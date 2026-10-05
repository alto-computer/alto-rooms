import { useRef, type ReactNode } from "react";
import { CircleAlert } from "lucide-react";
import { useArtifacts, useClient, useReadOnly, useRooms, useScopeError, useViewerStore } from "@/data/hooks";
import { dateLabel, isNewSince } from "@/lib/dates";
import { GENERIC_ERROR } from "@/lib/errors";
import { ArtifactCard } from "./ArtifactCard";
import { EditableTitle } from "./EditableTitle";
import { EmptyRoom } from "./EmptyRoom";
import { INBOX_ID } from "@/lib/drag";

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 items-center justify-center p-12 text-center text-[17px] text-ink-2">{children}</div>;
}

/**
 * A room tab: editable name, `문서 {n}`, and a grid of artifact cards that wraps
 * to the window's width and scrolls vertically (newest first), or the empty state.
 *
 * AppShell mounts this per activation (keyed by tab id, active tab only), so
 * the new-doc baseline captured at mount is "the moment the tab became active".
 */
export function RoomView({ roomId }: { roomId: string }) {
  const { rooms, info } = useRooms();
  const client = useClient();
  const viewer = useViewerStore();
  const artifacts = useArtifacts(roomId);
  const loadError = useScopeError(`room:${roomId}`);
  const room = rooms.find((r) => r.id === roomId);
  const readOnly = useReadOnly();

  // Frozen at activation: `lastVisit` is only written when leaving, and dots must not vanish while viewed.
  const baseline = useRef<string | null>(null);
  if (baseline.current === null) {
    const v = viewer.getState();
    baseline.current = v.lastVisit[roomId] ?? v.firstRunAt;
  }

  if (!room) {
    // Before the first sync we can't tell; afterwards the room is gone.
    return info ? <Centered>이 방은 더 이상 없어요</Centered> : <div className="flex-1 bg-surface" />;
  }

  let body: ReactNode;
  if (artifacts === undefined) {
    body = loadError ? <Centered>{GENERIC_ERROR}</Centered> : <div className="flex-1" />;
  } else if (artifacts.length === 0) {
    body = info ? <EmptyRoom room={room} home={info.home} /> : null;
  } else {
    const now = new Date();
    body = (
      // The grid scrolls inside the panel: -mx-12/px-12 put its scrollbar on the panel's
      // edge, and pt-2.5/-mt-2.5 leave room above the first row for the hover shadow.
      <div
        data-grid
        data-scroll-root
        className="-mx-12 -mt-2.5 grid min-h-0 flex-1 grid-cols-[repeat(auto-fill,300px)] content-start gap-x-7 gap-y-9 overflow-y-auto px-12 pt-2.5 pb-6 [scrollbar-color:#dddddd_transparent] [scrollbar-width:thin]"
      >
        {info
          ? [...artifacts]
              .reverse()
              .map((a) => (
                <ArtifactCard
                  key={a.id}
                  artifact={a}
                  info={info}
                  label={dateLabel(a.createdAt, now)}
                  isNew={isNewSince(a.createdAt, baseline.current!)}
                  size="strip"
                  draggable={roomId === INBOX_ID && !readOnly}
                  onExpand={() => viewer.open({ kind: "doc", roomId, artifactId: a.id }, { activate: true })}
                />
              ))
          : null}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-hidden bg-surface px-12 pt-10">
      <header className="flex flex-col gap-1">
        <EditableTitle
          key={room.id}
          value={room.name}
          readOnly={readOnly}
          ariaLabel="방 이름"
          hint="Enter 또는 바깥을 누르면 저장"
          onSave={async (next) => {
            await client.renameRoom(room.id, next);
          }}
          className="text-[30px] leading-[1.25] font-medium tracking-[-0.01em] text-ink"
          inputClassName="-ml-2 w-full max-w-[560px] rounded-lg px-2 py-0.5 outline-2 outline-solid outline-[#222]"
        />
        <p className="text-[16px] text-ink-2">문서 {room.artifactCount}</p>
        {room.status === "unavailable" ? (
          <p className="mt-1 flex items-center gap-1.5 text-[14px] text-[#c13515]">
            <CircleAlert size={16} aria-hidden />
            폴더를 찾을 수 없어요
          </p>
        ) : null}
      </header>
      {body}
    </div>
  );
}

import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { CircleAlert } from "lucide-react";
import { useArtifacts, useClient, useReadOnly, useRooms, useScopeError, useViewerStore } from "@/data/hooks";
import { dateLabel, isNewSince } from "@/lib/dates";
import { GENERIC_ERROR } from "@/lib/errors";
import { ArtifactCard } from "./ArtifactCard";
import { EditableTitle } from "./EditableTitle";
import { EmptyRoom } from "./EmptyRoom";

/** The strip counts as "at the right end" within this many pixels. */
const PIN_SLACK = 8;

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 items-center justify-center p-12 text-center text-[17px] text-ink-2">{children}</div>;
}

const atRightEnd = (el: HTMLElement) => el.scrollWidth - el.clientWidth - el.scrollLeft <= PIN_SLACK;

/**
 * A room tab: editable name, `문서 {n}`, and a horizontal strip of artifact
 * cards (oldest left, newest right), or the empty state.
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

  // Auto-scroll: to the right end on the first render with artifacts; afterwards
  // stay pinned there when artifacts change, but only if the user was at the end.
  const stripRef = useRef<HTMLDivElement>(null);
  const scrolledOnce = useRef(false);
  const pinned = useRef(true);
  const hasCards = (artifacts?.length ?? 0) > 0;
  useLayoutEffect(() => {
    const el = stripRef.current;
    if (!el || !hasCards) return;
    if (!scrolledOnce.current || pinned.current) {
      el.scrollLeft = el.scrollWidth;
      scrolledOnce.current = true;
      pinned.current = true;
    }
  }, [artifacts, hasCards]);
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const onScroll = () => {
      pinned.current = atRightEnd(el);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [hasCards]);

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
      // overflow-x:auto forces overflow-y to clip, so the hover shadow (0 6px 16px)
      // needs an inset: 10px on top (16 blur − 6 offset), cancelled by -mt so the
      // layout gap stays 24. Below, the shadow falls inside the card (over its footer),
      // so no bottom padding: the panel's pb-6 is the whole 24px bottom gap.
      <div
        ref={stripRef}
        data-strip
        data-scroll-root
        className="group/strip -mx-12 -mt-2.5 flex flex-1 items-start gap-7 overflow-x-auto overflow-y-hidden px-12 pt-2.5"
      >
        {info
          ? artifacts.map((a) => (
              <ArtifactCard
                key={a.id}
                artifact={a}
                info={info}
                label={dateLabel(a.createdAt, now)}
                isNew={isNewSince(a.createdAt, baseline.current!)}
                size="strip"
                onExpand={() => viewer.open({ kind: "doc", roomId, artifactId: a.id }, { activate: true })}
              />
            ))
          : null}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-hidden bg-surface px-12 pt-10 pb-6">
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

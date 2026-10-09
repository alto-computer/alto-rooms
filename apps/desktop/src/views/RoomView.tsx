import type { ReactNode } from "react";
import { CircleAlert } from "lucide-react";
import { useScrollMemory } from "@/lib/scrollMemory";
import { useCurrentTabId } from "@/shell/currentTab";
import { useArtifacts, useClient, useInfo, useOpenDoc, useReadOnly, useRoomList, useScopeError } from "@/data/hooks";
import { count, dateLabel, isNewSince } from "@/lib/dates";
import { GENERIC_ERROR } from "@/lib/errors";
import { ArtifactCard } from "./ArtifactCard";
import { EditableTitle } from "./EditableTitle";
import { EmptyRoom } from "./EmptyRoom";
import { SortBar } from "./SortBar";
import { useVisitsAtArrival } from "./useVisitsAtArrival";
import { INBOX_ID } from "@/lib/drag";

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 items-center justify-center p-12 text-center text-heading text-ink-2">{children}</div>;
}

/**
 * A room tab: editable name, `{n} docs`, and a grid of artifact cards that wraps
 * to the window's width and scrolls vertically (newest first), or the empty state.
 *
 * AppShell mounts this per activation (keyed by tab id, active tab only), so
 * the new-doc baseline captured at mount is "the moment the tab became active".
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
  const gridRef = useScrollMemory<HTMLDivElement>(`${useCurrentTabId()}:room:${roomId}`, !!artifacts?.length && !!info);

  const baseline = useVisitsAtArrival().since(roomId);

  if (!room) {
    // Before the first sync we can't tell; afterwards the room is gone.
    return info ? <Centered>This room is gone</Centered> : <div className="flex-1 bg-pane" />;
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
        ref={gridRef}
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
                  isNew={isNewSince(a.createdAt, baseline)}
                  size="strip"
                  draggable={roomId === INBOX_ID && !readOnly}
                  onOpen={openDoc}
                />
              ))
          : null}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-hidden bg-pane px-12 pt-10">
      <header className="flex flex-col gap-1">
        <EditableTitle
          key={room.id}
          value={room.name}
          readOnly={readOnly}
          ariaLabel="Room name"
          onSave={async (next) => {
            await client.renameRoom(room.id, next);
          }}
          className="font-display text-display leading-[1.25] font-medium tracking-[-0.01em] text-ink"
          inputClassName="-ml-2 w-full max-w-[560px] rounded-lg px-2 py-0.5 outline-2 outline-solid outline-ink"
        />
        <p className="text-lead text-ink-2">{count(room.artifactCount, "doc")}</p>
        {room.status === "unavailable" ? (
          <p className="mt-1 flex items-center gap-1.5 text-body text-error">
            <CircleAlert size={16} aria-hidden />
            Folder not found
          </p>
        ) : null}
        {roomId === INBOX_ID && !readOnly ? (
          <div className="mt-3">
            <SortBar />
          </div>
        ) : null}
      </header>
      {body}
    </div>
  );
}

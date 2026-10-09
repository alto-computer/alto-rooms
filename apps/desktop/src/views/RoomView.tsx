import type { ReactNode } from "react";
import type { Artifact, Room } from "@alto-rooms/protocol-ts";
import { CircleAlert, FolderOpen } from "lucide-react";
import { Dotted } from "@/components/Dotted";
import { useScrollMemory } from "@/lib/scrollMemory";
import { useCurrentTabId } from "@/shell/currentTab";
import { useArtifacts, useClient, useInfo, useOpenDoc, useReadOnly, useRoomList, useScopeError } from "@/data/hooks";
import { agoPhrase, count, isNewSince } from "@/lib/dates";
import { GENERIC_ERROR } from "@/lib/errors";
import { showInFinder } from "@/lib/native";
import { isTauri } from "@/lib/tauri";
import { ArtifactCard } from "./ArtifactCard";
import { EditableTitle } from "./EditableTitle";
import { EmptyRoom } from "./EmptyRoom";
import { bandButton, perchFor, RoomBand } from "./RoomBand";
import { SortBar } from "./SortBar";
import { useVisitsAtArrival } from "./useVisitsAtArrival";
import { INBOX_ID } from "@/lib/drag";

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 items-center justify-center p-12 text-center text-heading text-ink-2">{children}</div>;
}

/** `7 artifacts · last added 12 min ago by claude-code`; `No artifacts yet` for an empty room. */
function roomMeta(room: Room, newest: Artifact | undefined): ReactNode {
  if (room.artifactCount === 0) return "No artifacts yet";
  const added = newest ? `last added ${agoPhrase(newest.createdAt)}${newest.source.agent ? ` by ${newest.source.agent}` : ""}` : null;
  return <Dotted parts={[count(room.artifactCount, "artifact"), added]} />;
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

  if (!room) {
    // Before the first sync we can't tell; afterwards the room is gone.
    return info ? <Centered>This room is gone</Centered> : <div className="flex-1 bg-pane" />;
  }

  let body: ReactNode;
  if (artifacts === undefined) {
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
    <div ref={scrollRef} data-scroll-root className="flex min-h-0 flex-1 flex-col overflow-y-auto [scrollbar-width:thin]">
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
        meta={
          <>
            {roomMeta(room, artifacts?.at(-1))}
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
      {body}
    </div>
  );
}

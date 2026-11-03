import { useEffect, useMemo, useState } from "react";
import type { StudyVolume } from "@alto-rooms/protocol-ts";
import { AskBar } from "@/ask/AskBar";
import { useFrameAfter } from "@/ask/useFrameAfter";
import { useClient, useReadOnly, useStudy, useStudyStore, useViewerStore } from "@/data/hooks";
import { CanvasTools, CardCanvas, type CanvasControls, type CanvasFollow } from "./CardCanvas";
import { dottedDate, versionOf } from "./study";
import { useStudyGo } from "./StudyNav";

export { SAVE_DELAY_MS } from "./CardCanvas";

/** 판: a volume's cards on a dotted sheet. A draft saves itself; a published volume only reads. */
export function VolumePage({ roomId, number }: { roomId: string; number: number }) {
  const client = useClient();
  const [volume, setVolume] = useState<StudyVolume | "missing" | null>(null);
  useEffect(() => {
    let live = true;
    client.studyVolume(roomId, number).then(
      (v) => live && setVolume(v),
      (e: unknown) => {
        console.warn("rooms: could not load the volume", e);
        if (live) setVolume("missing");
      },
    );
    return () => {
      live = false;
    };
  }, [client, roomId, number]);

  if (volume === null) return null;
  if (volume === "missing") return <p className="st-lede st-sub p-16">Volume not found</p>;
  return <Volume roomId={roomId} volume={volume} />;
}

function Volume({ roomId, volume }: { roomId: string; volume: StudyVolume }) {
  const client = useClient();
  const store = useStudyStore();
  const viewer = useViewerStore();
  const go = useStudyGo();
  const appReadOnly = useReadOnly();
  const room = useStudy().rooms?.find((r) => r.id === roomId);
  // The ask bar comes a frame after the canvas, over the sheet's foot; the canvas tools stay in the bar on top.
  const barReady = useFrameAfter(!!room);
  const roomName = room?.name;
  const bar = useMemo(
    () => (roomName === undefined ? null : <AskBar subject={{ kind: "studyVolume", roomId, number: volume.number, roomName }} />),
    [roomId, volume.number, roomName],
  );
  const [confirming, setConfirming] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const frozen = volume.status === "published" || appReadOnly;
  // Nothing changes while a publish is under way: an edit then would land on the frozen volume.
  const readOnly = frozen || publishing;

  const follow: CanvasFollow | null = frozen
    ? null
    : {
        about: (type, e) => type === "resync" || (e.type === "study.changed" && e.roomId === roomId),
        load: async () => {
          const v = await client.studyVolume(roomId, volume.number);
          return v.status === "draft" ? v : null;
        },
      };

  const publish = async ({ flush, unsaved, showError }: CanvasControls) => {
    setPublishing(true);
    try {
      await flush();
      // Publish only what roomsd holds: a save that just failed leaves the error showing instead.
      if (unsaved()) throw new Error("unsaved");
      const summary = await client.publishStudyRoom(roomId);
      void store.refresh();
      const draft = summary.volumes.at(-1);
      if (draft) viewer.navigate({ kind: "study", page: "volume", roomId, number: draft.number });
    } catch (e) {
      if (!unsaved()) showError(e);
      setPublishing(false);
      setConfirming(false);
    }
  };

  const version = `v${versionOf(volume.number)}`;
  return (
    <CardCanvas
      content={volume}
      readOnly={readOnly}
      save={(body) => client.saveStudyVolume(roomId, volume.number, body)}
      follow={follow}
      lead={
        <>
          <button type="button" className="st-backlink" onClick={(e) => go({ page: "room", roomId }, e)}>
            ← {room?.name ?? "Study"}
          </button>
          <span className="st-ver">{version}</span>
        </>
      }
      titleLabel="Subtitle"
      acts={(controls) =>
        volume.status === "published" ? (
          <span className="st-date">{dottedDate(volume.publishedAt)}</span>
        ) : frozen ? null : confirming ? (
          <>
            <span>Once published, {version} can't be edited</span>
            <button type="button" onClick={() => setConfirming(false)} disabled={publishing}>
              Cancel
            </button>
            <button type="button" className="st-pub" onClick={() => void publish(controls)} disabled={publishing}>
              Publish
            </button>
          </>
        ) : (
          <>
            <CanvasTools add={controls.add} />
            <button type="button" className="st-pub" onClick={() => setConfirming(true)}>
              Publish
            </button>
          </>
        )
      }
      bar={barReady && !appReadOnly ? bar : null}
    />
  );
}

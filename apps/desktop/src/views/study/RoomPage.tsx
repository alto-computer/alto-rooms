import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { AskBar } from "@/ask/AskBar";
import { useFrameAfter } from "@/ask/useFrameAfter";
import type { Artifact, StudyLink, StudyRoomSummary } from "@alto-rooms/protocol-ts";
import { FileText, Folder, X } from "lucide-react";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useClient, useReadOnly, useRoomList, useRooms, useStudy, useStudyStore, useViewerStore, useWatchArtifacts } from "@/data/hooks";
import { errorCopy } from "@/lib/errors";
import { clothOf, dottedDate, versionOf } from "./study";
import { Axes, useStudyGo } from "./StudyNav";

/** A wheel turn moves one volume at most this often, so a trackpad flick doesn't spin the arc. */
const WHEEL_STEP_MS = 380;

/** The volume a room opens on: the newest published one, else its draft. */
const startFocus = (room: StudyRoomSummary) => Math.max(0, room.volumes.length - (room.volumes.length > 1 ? 2 : 1));

const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

/** 방: a study room's volumes as covers on an arc, the focused one large, and what it links to in Rooms. */
export function RoomPage({ roomId }: { roomId: string }) {
  const { rooms, failed } = useStudy();
  const room = rooms?.find((r) => r.id === roomId);
  const go = useStudyGo();
  const readOnly = useReadOnly();
  const missing = rooms ? "없는 방이에요" : failed ? "서재를 불러오지 못했어요" : null;
  // The ask bar comes a frame after the room first paints.
  const barReady = useFrameAfter(!!room);
  const name = room?.name;
  const bar = useMemo(() => (name === undefined ? null : <AskBar subject={{ kind: "studyRoom", roomId, roomName: name }} />), [roomId, name]);

  return (
    // Relative, with room at the bottom for the ask bar.
    <div className="st-room">
      <button type="button" className="st-back" onClick={(e) => go({ page: "library" }, e)}>
        ← 서재
      </button>
      <Axes on="library" />
      {room ? <Volumes key={room.id} room={room} /> : missing ? <p className="st-lede st-sub">{missing}</p> : null}
      {room ? <Links room={room} /> : null}
      {barReady && !readOnly ? bar : null}
    </div>
  );
}

function Volumes({ room }: { room: StudyRoomSummary }) {
  const go = useStudyGo();
  const [focus, setFocus] = useState(() => startFocus(room));
  const count = room.volumes.length;
  // A publish adds a volume: keep the focus inside the list.
  const at = Math.min(focus, count - 1);
  const v = room.volumes[at];
  const move = (by: number) => setFocus((f) => Math.min(count - 1, Math.max(0, Math.min(f, count - 1) + by)));

  const lastWheel = useRef(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "ArrowRight") move(1);
      else if (e.key === "ArrowLeft") move(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <>
      <div
        className="st-arc"
        onWheel={(e) => {
          const now = Date.now();
          const delta = e.deltaY + e.deltaX;
          if (delta === 0 || now - lastWheel.current < WHEEL_STEP_MS) return;
          lastWheel.current = now;
          move(delta > 0 ? 1 : -1);
        }}
      >
        {room.volumes.map((vol, i) => {
          const d = i - at;
          const a = Math.abs(d);
          const scale = d === 0 ? 1.18 : Math.max(0.5, 0.86 - a * 0.09);
          const style = {
            // Each volume's cover is a shade deeper in the room's cloth than the one before.
            "--deepen": `${Math.min(i, 5) * 5}%`,
            transform: `translate3d(${d * 178}px, ${-d * 108 + a * a * 4}px, ${-a * 60}px) rotateY(${d === 0 ? -6 : -24}deg) scale(${scale})`,
            zIndex: 20 - a,
            opacity: a > 4 ? 0 : 1,
          } as CSSProperties;
          const draft = vol.status === "draft";
          return (
            <button
              key={vol.number}
              type="button"
              className={draft ? "st-vol st-draft" : "st-vol"}
              data-cloth={clothOf(room.id)}
              style={style}
              aria-label={`${room.name} v${versionOf(vol.number)}`}
              aria-current={d === 0 ? "true" : undefined}
              tabIndex={a > 4 ? -1 : 0}
              onClick={(e) => (d === 0 ? go({ page: "volume", roomId: room.id, number: vol.number }, e) : setFocus(i))}
            >
              <span className="st-vc">
                <span className="st-t">{room.name}</span>
                <span className="st-n">
                  <small>VOL.</small>
                  <b>{String(vol.number).padStart(2, "0")}</b>
                </span>
                <span className="st-v">
                  <i>v</i>
                  {versionOf(vol.number)}
                </span>
                <span className="st-r" />
                <span className="st-s">{vol.title}</span>
              </span>
            </button>
          );
        })}
      </div>
      <div className="st-lede">
        <div key={v.number} className="st-swap">
          <div className="st-kick">{room.name}</div>
          <div className="st-big">
            <i>v</i>
            {versionOf(v.number)}
          </div>
          <div className="st-sub">{v.title}</div>
          {v.status === "published" ? (
            <div className="st-meta">
              <div>
                <span>발행</span>
                {dottedDate(v.publishedAt)}
              </div>
            </div>
          ) : null}
          <button type="button" className="st-go" onClick={(e) => go({ page: "volume", roomId: room.id, number: v.number }, e)}>
            {v.status === "draft" ? "이어 쓰기 →" : "펼쳐 읽기 →"}
          </button>
        </div>
      </div>
    </>
  );
}

const linkKey = (l: StudyLink) => (l.kind === "room" ? `room:${l.roomId}` : `artifact:${l.fileKey}`);

/** Linked artifacts by file key: the artifact, null once roomsd says it is gone, absent while asking. */
function useLinkedArtifacts(fileKeys: readonly string[]): Map<string, Artifact | null> {
  const client = useClient();
  const [found, setFound] = useState(() => new Map<string, Artifact | null>());
  const key = fileKeys.join("\n");
  useEffect(() => {
    let live = true;
    for (const fileKey of key ? key.split("\n") : []) {
      client.findArtifactByFileKey(fileKey).then(
        (a) => live && setFound((m) => new Map(m).set(fileKey, a)),
        (e: unknown) => console.warn("rooms: could not find a linked artifact", e),
      );
    }
    return () => {
      live = false;
    };
  }, [client, key]);
  return found;
}

/** What the room points at in Rooms: rooms and artifacts, opened in a new tab, never moved or copied. */
function Links({ room }: { room: StudyRoomSummary }) {
  const client = useClient();
  const store = useStudyStore();
  const viewer = useViewerStore();
  const readOnly = useReadOnly();
  const roomsList = useRoomList();
  const artifacts = useLinkedArtifacts(room.links.flatMap((l) => (l.kind === "artifact" ? [l.fileKey] : [])));
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Each change replaces the whole list, built from the one shown: one at a time, so none undoes another.
  const [saving, setSaving] = useState(false);

  const save = async (links: StudyLink[]) => {
    setError(null);
    setSaving(true);
    try {
      await client.updateStudyRoom(room.id, { name: room.name, links });
      await store.refresh();
    } catch (e) {
      setError(errorCopy(e));
    } finally {
      setSaving(false);
    }
  };

  const row = (l: StudyLink) => {
    let icon = <Folder size={14} strokeWidth={1.5} aria-hidden />;
    let label: string;
    let open: (() => void) | null = null;
    if (l.kind === "room") {
      const r = roomsList.find((x) => x.id === l.roomId);
      label = r?.name ?? "없는 방";
      if (r) open = () => viewer.open({ kind: "room", roomId: r.id }, { nextToActive: true });
    } else {
      icon = <FileText size={14} strokeWidth={1.5} aria-hidden />;
      const a = artifacts.get(l.fileKey);
      label = a === undefined ? "…" : (a?.title ?? "없는 아티팩트");
      if (a) open = () => viewer.open({ kind: "artifact", roomId: a.roomId, artifactId: a.id }, { nextToActive: true });
    }
    return (
      <li key={linkKey(l)} className="st-link">
        <button type="button" disabled={!open} onClick={open ?? undefined}>
          {icon}
          <span>{label}</span>
        </button>
        {readOnly ? null : (
          <button type="button" className="st-x" aria-label={`${label} 연결 끊기`} disabled={saving} onClick={() => void save(room.links.filter((x) => linkKey(x) !== linkKey(l)))}>
            <X size={13} strokeWidth={1.5} aria-hidden />
          </button>
        )}
      </li>
    );
  };

  return (
    <div className="st-links">
      {room.links.length > 0 ? (
        <ul aria-label="연결된 방과 아티팩트" className="flex flex-col">
          {room.links.map(row)}
        </ul>
      ) : null}
      {readOnly ? null : (
        <Popover open={picking} onOpenChange={setPicking}>
          <PopoverTrigger asChild>
            <button type="button" className="st-connect" disabled={saving}>
              연결
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" side="top" className="w-80 p-0">
            {picking ? (
              <Picker
                linked={new Set(room.links.map(linkKey))}
                onPick={(l) => {
                  setPicking(false);
                  void save([...room.links, l]);
                }}
              />
            ) : null}
          </PopoverContent>
        </Popover>
      )}
      {error ? (
        <p role="alert" className="mt-2 text-right text-small text-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const MAX_ROOMS = 8;
const MAX_ARTIFACTS = 30;
const norm = (s: string) => s.normalize("NFC").toLowerCase();

/** Rooms rooms and artifacts not linked yet, filtered by name or title. Loads every room's artifacts while open, like Find. */
function Picker({ linked, onPick }: { linked: ReadonlySet<string>; onPick: (l: StudyLink) => void }) {
  const { rooms, artifacts, info } = useRooms();
  const [query, setQuery] = useState("");
  const roomIds = useMemo(() => rooms.map((r) => r.id), [rooms]);
  useWatchArtifacts(roomIds);

  const q = norm(query.trim());
  const roomHits = rooms.filter((r) => r.id !== info?.journalRoomId && !linked.has(`room:${r.id}`) && norm(r.name).includes(q)).slice(0, MAX_ROOMS);
  const artifactHits: { a: Artifact; roomName: string }[] = [];
  for (const r of rooms) {
    for (const a of artifacts[r.id] ?? []) {
      if (artifactHits.length >= MAX_ARTIFACTS) break;
      if (!linked.has(`artifact:${a.fileKey}`) && norm(a.title).includes(q)) artifactHits.push({ a, roomName: r.name });
    }
  }

  return (
    <Command shouldFilter={false}>
      <CommandInput placeholder="방이나 아티팩트 찾기" value={query} onValueChange={setQuery} />
      <CommandList>
        <CommandEmpty>없어요</CommandEmpty>
        {roomHits.length > 0 ? (
          <CommandGroup heading="Rooms">
            {roomHits.map((r) => (
              <CommandItem key={r.id} value={`room:${r.id}`} onSelect={() => onPick({ kind: "room", roomId: r.id })}>
                <Folder size={16} strokeWidth={1.75} aria-hidden />
                <span className="min-w-0 flex-1 truncate">{r.name}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
        {artifactHits.length > 0 ? (
          <CommandGroup heading="Artifacts">
            {artifactHits.map(({ a, roomName }) => (
              <CommandItem key={`${a.roomId}/${a.id}`} value={`artifact:${a.roomId}/${a.id}`} onSelect={() => onPick({ kind: "artifact", fileKey: a.fileKey })}>
                <FileText size={16} strokeWidth={1.75} aria-hidden />
                <span className="min-w-0 flex-1 truncate">{a.title}</span>
                <span className="ml-auto shrink-0 text-small text-ink-3">{roomName}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
      </CommandList>
    </Command>
  );
}

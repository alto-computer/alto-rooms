import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { RoomsApiError, type Artifact, type Info, type Note, type Room } from "@alto-rooms/protocol-ts";
import { CircleAlert, Plus } from "lucide-react";
import { useClient, useJournalDay, useRooms, useScopeError, useViewerStore } from "@/data/hooks";
import type { ViewerStore } from "@/data/viewerStore";
import { dateLabel, isNewSince, journalTitle, localDate } from "@/lib/dates";
import { errorCopy, GENERIC_ERROR } from "@/lib/errors";
import { viewerInitial } from "@/lib/native";
import { defaultNoteName, findNote, noteBase, noteFileName } from "@/lib/notes";
import otterAvatar from "@/assets/otter-avatar.svg";
import { ArtifactCard } from "./ArtifactCard";
import { WeekStrip } from "./WeekStrip";

/** The viewer's initial comes from the OS account name; it never changes during a run, so it is fetched once. */
let initialPromise: Promise<string> | null = null;
function useViewerInitial(): string {
  const [initial, setInitial] = useState("");
  useEffect(() => {
    let live = true;
    initialPromise ??= viewerInitial().catch(() => "");
    void initialPromise.then((v) => {
      if (live) setInitial(v);
    });
    return () => {
      live = false;
    };
  }, []);
  return initial;
}

const byCreated = (a: Artifact, b: Artifact) => {
  const d = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  if (d) return d;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

type AgentCard = { artifact: Artifact; label: string };

/** Dream first ("복습"), then the rest by createdAt (then id), each labelled with its source room. */
export function agentCards(artifacts: readonly Artifact[], date: string, info: Info, rooms: readonly Room[]): AgentCard[] {
  const isDream = (a: Artifact) => a.roomId === info.journalRoomId && a.relPath === `${date}/dream.html`;
  const label = (a: Artifact) => {
    if (a.roomId === info.journalRoomId) return "Journal";
    return rooms.find((r) => r.id === a.roomId)?.name ?? "방";
  };
  const dream = artifacts.filter(isDream);
  const rest = artifacts.filter((a) => !isDream(a)).sort(byCreated);
  return [...dream.map((artifact) => ({ artifact, label: "복습" })), ...rest.map((artifact) => ({ artifact, label: label(artifact) }))];
}

function RowLabel({ avatar, name, count }: { avatar: ReactNode; name: string; count: number }) {
  return (
    <div className="flex items-center gap-2">
      {avatar}
      <span className="text-[15px] font-medium text-ink">{name}</span>
      <span className="text-[15px] text-[#929292]">{count}</span>
    </div>
  );
}

function NewNoteCard({ date, notes, viewer }: { date: string; notes: readonly Note[]; viewer: ViewerStore }) {
  const client = useClient();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const start = () => {
    setValue(defaultNoteName(notes));
    setError(null);
    setEditing(true);
  };
  const cancel = () => {
    setEditing(false);
    setError(null);
  };

  const submit = async () => {
    if (!noteBase(value.trim()) || busy) return;
    const fileName = noteFileName(value);
    const open = (name: string) => {
      setEditing(false);
      viewer.open({ kind: "note", date, name });
    };
    // Never save over an existing note: open it instead. The day list may lag
    // behind the disk, so a miss there is confirmed with getNote (404 = free).
    const listed = findNote(notes, fileName);
    if (listed) {
      open(listed.name);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      try {
        await client.getNote(date, fileName);
        open(fileName);
        return;
      } catch (e) {
        if (!(e instanceof RoomsApiError && e.status === 404)) throw e;
      }
      const saved = await client.saveNote(date, fileName, "");
      open(saved?.name || fileName);
    } catch (e) {
      setError(errorCopy(e));
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return; // Korean IME: Enter confirms the syllable first
    if (e.key === "Enter") {
      e.preventDefault();
      void submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  };

  if (!editing) {
    return (
      <button
        type="button"
        aria-label="새 노트"
        onClick={start}
        className="flex h-[150px] w-[160px] shrink-0 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-[#ddd] bg-white text-ink-2 hover:bg-[#f7f7f7] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
      >
        <Plus size={22} aria-hidden />
        <span className="text-[15px]">새 노트</span>
      </button>
    );
  }

  return (
    <div className="flex w-[220px] shrink-0 flex-col gap-2">
      <div className="flex h-[150px] items-start rounded-xl bg-white p-4 shadow-[0_0_0_2px_#222]">
        <label className="sr-only" htmlFor={inputId}>
          노트 이름
        </label>
        <input
          id={inputId}
          ref={inputRef}
          value={value}
          disabled={busy}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => {
            if (!value.trim() && !busy) cancel();
          }}
          className="w-full min-w-0 bg-transparent text-[15px] font-medium text-ink outline-none"
        />
        <span aria-hidden className="ml-2 text-[12px] text-[#929292]">
          ↵
        </span>
      </div>
      {error ? (
        <p role="alert" className="flex items-center gap-1.5 text-[14px] text-[#c13515]">
          <CircleAlert size={16} aria-hidden />
          {error}
        </p>
      ) : null}
    </div>
  );
}

function NoteCard({ note, onOpen, now }: { note: Note; onOpen: () => void; now: Date }) {
  const name = noteBase(note.name);
  return (
    <button
      type="button"
      aria-label={name}
      onClick={onOpen}
      className="flex h-[150px] w-[220px] shrink-0 flex-col justify-between rounded-xl border border-[#ddd] bg-white p-4 text-left hover:shadow-float focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
    >
      <span className="line-clamp-3 text-[15px] font-medium text-ink">{name}</span>
      <span className="font-mono text-[12px] text-[#929292]">{dateLabel(note.updatedAt, now)}</span>
    </button>
  );
}

/**
 * The journal tab: a day's header with a week strip, what agents wrote that
 * day, and the viewer's own notes. Changing the date rewrites this same tab.
 */
export function JournalView({ tabId, date }: { tabId?: string; date: string }) {
  const { rooms, info } = useRooms();
  const viewer = useViewerStore();
  const day = useJournalDay(date);
  const loadError = useScopeError(`day:${date}`);
  const initial = useViewerInitial();
  const readOnly = info?.readOnly ?? false;

  // New-doc dots: frozen at activation (AppShell mounts this per activation),
  // per artifact, against its own room's last visit — as in RoomView.
  const visits = useRef<{ lastVisit: Record<string, string>; firstRunAt: string } | null>(null);
  if (visits.current === null) {
    const v = viewer.getState();
    visits.current = { lastVisit: v.lastVisit, firstRunAt: v.firstRunAt };
  }
  const baselineFor = (roomId: string) => visits.current!.lastVisit[roomId] ?? visits.current!.firstRunAt;

  const setDate = (next: string) => {
    const id = tabId ?? viewer.getState().tabs.find((t) => t.kind === "journal")?.id;
    if (id) viewer.replace(id, { kind: "journal", date: next });
  };

  const now = new Date();
  const isToday = date === localDate(now);
  const cards = day && info ? agentCards(day.artifacts, date, info, rooms) : [];
  const notes = day ? [...day.notes].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) : [];

  let body: ReactNode;
  if (day === undefined) {
    body = loadError ? (
      <div className="flex flex-1 items-center justify-center text-[17px] text-ink-2">{GENERIC_ERROR}</div>
    ) : (
      <div className="flex-1" />
    );
  } else {
    body = (
      <>
        <section aria-label="에이전트가 쓴 것" className="flex flex-col gap-4">
          <RowLabel
            avatar={
              <span className="grid size-6 place-items-center overflow-hidden rounded-full bg-[#f2f2f2]">
                <img src={otterAvatar} alt="" className="size-5" />
              </span>
            }
            name="에이전트"
            count={cards.length}
          />
          <div data-scroll-root className="-mx-12 -mt-2.5 flex items-start gap-5 overflow-x-auto overflow-y-hidden px-12 pt-2.5 pb-1">
            {info
              ? cards.map(({ artifact, label }) => (
                  <ArtifactCard
                    key={artifact.id}
                    artifact={artifact}
                    info={info}
                    label={label}
                    isNew={isNewSince(artifact.createdAt, baselineFor(artifact.roomId))}
                    size="journal"
                    onExpand={() => viewer.open({ kind: "doc", roomId: artifact.roomId, artifactId: artifact.id })}
                  />
                ))
              : null}
          </div>
        </section>
        <section aria-label="내가 쓴 것" className="flex flex-col gap-4">
          <RowLabel
            avatar={
              <span aria-hidden={!initial} className="grid size-6 place-items-center rounded-full bg-[#222] text-[12px] text-white">
                {initial}
              </span>
            }
            name="나"
            count={notes.length}
          />
          <div className="-mx-12 -mt-2.5 flex items-start gap-5 overflow-x-auto px-12 pt-2.5 pb-1">
            {readOnly ? null : <NewNoteCard date={date} notes={notes} viewer={viewer} />}
            {notes.map((n) => (
              <NoteCard key={n.name} note={n} now={now} onOpen={() => viewer.open({ kind: "note", date, name: n.name })} />
            ))}
          </div>
        </section>
      </>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-[26px] overflow-y-auto bg-white px-12 pt-9 pb-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-baseline gap-3">
          <h1 className="text-[30px] leading-[1.25] font-medium tracking-[-0.01em] text-ink">{journalTitle(date)}</h1>
          {isToday ? <span className="text-[17px] text-ink-2">오늘</span> : null}
        </div>
        <WeekStrip date={date} onChange={setDate} />
      </header>
      {body}
    </div>
  );
}

import { useEffect, useRef, useState, type ReactNode } from "react";
import { RoomsApiError, type Artifact, type Info, type Note, type Room } from "@alto-rooms/protocol-ts";
import { CircleAlert, Plus } from "lucide-react";
import { useClient, useJournalDay, useInfo, useOpenDoc, useReadOnly, useRoomList, useScopeError, useViewerStore } from "@/data/hooks";
import type { ViewerStore } from "@/data/viewerStore";
import { dateLabel, isNewSince, journalTitle, localDate } from "@/lib/dates";
import { errorCopy, GENERIC_ERROR } from "@/lib/errors";
import { viewerInitial } from "@/lib/native";
import { wantsNewTab } from "@/lib/nav";
import { useScrollMemory } from "@/lib/scrollMemory";
import { useCurrentTabId } from "@/shell/currentTab";
import { firstNewNoteNames, noteBase, noteFileName, requestNoteBodyFocus } from "@/lib/notes";
import { ArtifactCard } from "./ArtifactCard";
import { useVisitsAtArrival } from "./useVisitsAtArrival";
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

/** Dream first ("Review"), then the rest by createdAt (then id), each labelled with its source room. */
export function agentCards(artifacts: readonly Artifact[], date: string, info: Info, rooms: readonly Room[]): AgentCard[] {
  const isDream = (a: Artifact) => a.roomId === info.journalRoomId && a.relPath === `${date}/dream.html`;
  const label = (a: Artifact) => {
    if (a.roomId === info.journalRoomId) return "Journal";
    return rooms.find((r) => r.id === a.roomId)?.name ?? "Room";
  };
  const dream = artifacts.filter(isDream);
  const rest = artifacts.filter((a) => !isDream(a)).sort(byCreated);
  return [...dream.map((artifact) => ({ artifact, label: "Review" })), ...rest.map((artifact) => ({ artifact, label: label(artifact) }))];
}

function RowLabel({ avatar, name, count }: { avatar?: ReactNode; name: string; count: number }) {
  return (
    <div className="flex items-center gap-2">
      {avatar}
      <span className="text-lead font-medium text-ink">{name}</span>
      <span className="text-lead text-ink-3">{count}</span>
    </div>
  );
}

/** Most default names tried before giving up (each one already on disk costs a getNote). */
const MAX_NEW_NOTE_TRIES = 50;

/**
 * New note: no name asked. Creates the first free default name ("New Note",
 * "New Note 2", …) and opens it in a new tab with the cursor in the body.
 * Never saves over a note: a name in the day list is skipped, and since that
 * list may lag behind the disk, the rest are confirmed with getNote (404 = free).
 */
function NewNoteCard({ date, notes, viewer }: { date: string; notes: readonly Note[]; viewer: ViewerStore }) {
  const client = useClient();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const create = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      for (const candidate of firstNewNoteNames(notes, MAX_NEW_NOTE_TRIES)) {
        const fileName = noteFileName(candidate);
        try {
          await client.getNote(date, fileName);
          continue; // on disk already: never overwrite it
        } catch (e) {
          if (!(e instanceof RoomsApiError && e.status === 404)) throw e;
        }
        const saved = await client.saveNote(date, fileName, "");
        const name = saved?.name || fileName;
        requestNoteBodyFocus(date, name);
        viewer.open({ kind: "note", date, name });
        return;
      }
      setError(GENERIC_ERROR);
    } catch (e) {
      setError(errorCopy(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="flex w-[160px] shrink-0 flex-col gap-2">
      <button
        type="button"
        aria-label="New note"
        aria-busy={busy || undefined}
        onClick={() => void create()}
        className="flex h-[150px] w-[160px] shrink-0 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-hairline-strong bg-sheet text-ink-2 hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
      >
        <Plus size={22} aria-hidden />
        <span className="text-lead">New note</span>
      </button>
      {error ? (
        <p role="alert" className="flex items-center gap-1.5 text-body text-error">
          <CircleAlert size={16} aria-hidden />
          {error}
        </p>
      ) : null}
    </div>
  );
}

function NoteCard({ note, onOpen, now }: { note: Note; onOpen: (newTab: boolean) => void; now: Date }) {
  const name = noteBase(note.name);
  return (
    <button
      type="button"
      aria-label={name}
      onClick={(e) => onOpen(wantsNewTab(e))}
      onAuxClick={(e) => e.button === 1 && onOpen(true)}
      className="flex h-[150px] w-[220px] shrink-0 flex-col justify-between rounded-xl border border-hairline bg-sheet p-4 text-left hover:shadow-float focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
    >
      <span className="line-clamp-3 text-lead font-medium text-ink">{name}</span>
      <span className="font-mono text-small text-ink-3">{dateLabel(note.updatedAt, now)}</span>
    </button>
  );
}

/**
 * The journal tab: a day's header with a week strip, what agents wrote that
 * day, and the viewer's own notes. Changing the date rewrites this same tab.
 */
export function JournalView({ tabId, date }: { tabId?: string; date: string }) {
  const rooms = useRoomList();
  const info = useInfo();
  const viewer = useViewerStore();
  const openDoc = useOpenDoc();
  const day = useJournalDay(date);
  const loadError = useScopeError(`day:${date}`);
  const scrollRef = useScrollMemory<HTMLDivElement>(`${useCurrentTabId()}:journal:${date}`, day !== undefined);
  const initial = useViewerInitial();
  const readOnly = useReadOnly();

  // New-doc dots: per artifact, against its own room's last visit — as in RoomView.
  const visits = useVisitsAtArrival();

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
      <div className="flex flex-1 items-center justify-center text-heading text-ink-2">{GENERIC_ERROR}</div>
    ) : (
      <div className="flex-1" />
    );
  } else {
    body = (
      <>
        <section aria-label="From agents" className="flex flex-col gap-4">
          <RowLabel name="Agents" count={cards.length} />
          <div
            data-scroll-root
            // The fade sits in the side padding, so it only touches cards cut off at the edge.
            className="-mx-12 -mt-2.5 flex items-start gap-5 overflow-x-auto overflow-y-hidden px-12 pt-2.5 pb-1 [mask-image:linear-gradient(to_right,transparent,#000_40px,#000_calc(100%-40px),transparent)]"
          >
            {info
              ? cards.map(({ artifact, label }) => (
                  <ArtifactCard
                    key={artifact.id}
                    artifact={artifact}
                    info={info}
                    label={label}
                    isNew={isNewSince(artifact.createdAt, visits.since(artifact.roomId))}
                    size="journal"
                    onOpen={openDoc}
                  />
                ))
              : null}
          </div>
        </section>
        <section aria-label="From me" className="flex flex-col gap-4">
          <RowLabel
            avatar={
              <span aria-hidden={!initial} className="grid size-6 place-items-center rounded-full bg-ink text-small text-pane">
                {initial}
              </span>
            }
            name="Me"
            count={notes.length}
          />
          {/* pb-6/-mb-5: room below the cards for the hover shadow, which the scroller would clip. */}
          <div className="-mx-12 -mt-2.5 -mb-5 flex items-start gap-5 overflow-x-auto px-12 pt-2.5 pb-6">
            {readOnly ? null : <NewNoteCard date={date} notes={notes} viewer={viewer} />}
            {notes.map((n) => (
              <NoteCard key={n.name} note={n} now={now} onOpen={(newTab) => viewer.go({ kind: "note", date, name: n.name }, newTab)} />
            ))}
          </div>
        </section>
      </>
    );
  }

  return (
    <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-[26px] overflow-y-auto bg-pane px-12 pt-9 pb-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-baseline gap-3">
          <h1 className="font-serif text-display leading-[1.25] font-medium tracking-[-0.01em] text-ink">{journalTitle(date)}</h1>
          {isToday ? <span className="text-heading text-ink-2">Today</span> : null}
        </div>
        <WeekStrip date={date} onChange={setDate} />
      </header>
      {body}
    </div>
  );
}

import { useRef, useState, type ReactNode } from "react";
import { RoomsApiError, type Note } from "@alto-rooms/protocol-ts";
import { CircleAlert, Plus } from "lucide-react";
import { useClient, useJournalDay, useInfo, useOpenDoc, useReadOnly, useRoomList, useScopeError, useViewerStore } from "@/data/hooks";
import type { ViewerStore } from "@/data/viewerStore";
import { AGENT_NAMES } from "@/lib/agents";
import { conversationTitle } from "@/lib/conversations";
import { daybookTitle, isoWeek, localDate, monthDay } from "@/lib/dates";
import { errorCopy, GENERIC_ERROR } from "@/lib/errors";
import { useScrollMemory } from "@/lib/scrollMemory";
import { useCurrentTabId } from "@/shell/currentTab";
import { firstNewNoteNames, noteBase, noteFileName, requestNoteBodyFocus } from "@/lib/notes";
import { Daybook, dayEntries, type DayEntry } from "./Daybook";
import { DayTally, type TallyCell, type TallyItem } from "./DayTally";
import { EmptyDay } from "./EmptyDay";
import { WeekStrip } from "./WeekStrip";

/** Most default names tried before giving up (each one already on disk costs a getNote). */
const MAX_NEW_NOTE_TRIES = 50;

/**
 * Write a note: no name asked. Creates the first free default name ("New Note",
 * "New Note 2", …) and opens it in a new tab with the cursor in the body.
 * Never saves over a note: a name in the day list is skipped, and since that
 * list may lag behind the disk, the rest are confirmed with getNote (404 = free).
 */
function WriteNoteButton({ date, notes, viewer }: { date: string; notes: readonly Note[]; viewer: ViewerStore }) {
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
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        aria-busy={busy || undefined}
        onClick={() => void create()}
        className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-sheet px-2.5 text-small font-medium text-ink shadow-sheet outline-none hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
      >
        <Plus size={14} className="text-ink-2" aria-hidden />
        Write a note
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

/**
 * The journal tab, a daybook: the date in serif over a week strip, then the day in time order
 * (your notes and what agents wrote) beside a tally of it. Changing the date rewrites this same tab.
 */
export function JournalView({ tabId, date }: { tabId?: string; date: string }) {
  const rooms = useRoomList();
  const info = useInfo();
  const viewer = useViewerStore();
  const openDoc = useOpenDoc();
  const day = useJournalDay(date);
  const loadError = useScopeError(`day:${date}`);
  const scrollRef = useScrollMemory<HTMLDivElement>(`${useCurrentTabId()}:journal:${date}`, day !== undefined);
  const readOnly = useReadOnly();
  // The selected conversation's entry key, for this date only.
  const [selection, setSelection] = useState<{ date: string; key: string } | null>(null);
  const selected = selection?.date === date ? selection.key : null;
  const select = (key: string) => setSelection({ date, key });
  /** Selects a conversation's row and brings it into view (from the tally). */
  const reveal = (key: string) => {
    select(key);
    requestAnimationFrame(() => {
      const row = [...(scrollRef.current?.querySelectorAll<HTMLElement>("[data-entry-key]") ?? [])].find((el) => el.dataset.entryKey === key);
      row?.scrollIntoView({ block: "center" });
      row?.focus({ preventScroll: true });
    });
  };

  const setDate = (next: string) => {
    const id = tabId ?? viewer.getState().tabs.find((t) => t.kind === "journal")?.id;
    if (id) viewer.replace(id, { kind: "journal", date: next });
  };

  const isToday = date === localDate();
  const entries = day && info ? dayEntries(day, info, rooms) : [];
  const writeNote = readOnly || !day ? null : <WriteNoteButton date={date} notes={day.notes} viewer={viewer} />;

  // One cell per kind of entry; a kind joins the tally with one more line here.
  const tallyItem = (e: DayEntry): TallyItem => {
    switch (e.kind) {
      case "note":
        return { key: e.key, title: noteBase(e.note.name), at: e.at, meta: "", open: (newTab) => viewer.go({ kind: "note", date, name: e.note.name }, newTab) };
      case "artifact":
        return { key: e.key, title: e.artifact.title, at: e.at, meta: e.label, open: (newTab) => openDoc(e.artifact, newTab) };
      case "conversation":
        return {
          key: e.key,
          title: conversationTitle(e.conversation),
          at: e.at,
          meta: [AGENT_NAMES[e.conversation.id.agent], e.room?.name].filter(Boolean).join(" · "),
          open: () => reveal(e.key),
        };
    }
  };
  const cells: TallyCell[] = [
    { noun: "conversation", items: entries.filter((e) => e.kind === "conversation").map(tallyItem) },
    { noun: "artifact", items: entries.filter((e) => e.kind === "artifact").map(tallyItem) },
    { noun: "note", items: entries.filter((e) => e.kind === "note").map(tallyItem) },
  ];

  let body: ReactNode;
  if (day === undefined) {
    body = loadError ? <div className="flex flex-1 items-center justify-center text-heading text-ink-2">{GENERIC_ERROR}</div> : null;
  } else {
    body = (
      <div className="grid grid-cols-[minmax(0,1fr)_300px] gap-14 px-14 pt-9 pb-10">
        <section aria-label="Your day" className="flex min-w-0 flex-col">
          <div className="mb-4 flex h-7 items-center justify-between">
            <h2 className="text-small font-semibold tracking-[0.02em] text-ink-3">Your day</h2>
            {entries.length ? writeNote : null}
          </div>
          {entries.length && info ? (
            <Daybook entries={entries} info={info} selected={selected} onSelect={select} />
          ) : (
            <EmptyDay date={date} rooms={rooms} writeNote={writeNote} onPick={setDate} />
          )}
        </section>
        <DayTally label={isToday ? "Today" : monthDay(date)} cells={cells} />
      </div>
    );
  }

  return (
    <div ref={scrollRef} data-scroll-root className="flex min-h-0 flex-1 flex-col overflow-y-auto [scrollbar-width:thin]">
      <header className="flex flex-wrap items-end gap-6 px-14 pt-9">
        <div className="flex flex-col">
          <p className="text-small font-semibold tracking-[0.06em] text-ink-3 uppercase">Journal · Week {isoWeek(date)}</p>
          <h1 className="mt-2.5 font-serif text-display font-medium tracking-[-0.01em] text-ink">{daybookTitle(date)}</h1>
        </div>
        <div className="ml-auto">
          <WeekStrip date={date} onChange={setDate} />
        </div>
      </header>
      {body}
    </div>
  );
}

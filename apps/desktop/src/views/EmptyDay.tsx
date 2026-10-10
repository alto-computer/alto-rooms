import { useEffect, useState, type ReactNode } from "react";
import type { JournalDay, Room } from "@alto-rooms/protocol-ts";
import { ChevronRight } from "lucide-react";
import { ClewSleep } from "@/components/ClewSleep";
import { useClient } from "@/data/hooks";
import { addDays, count, dayOfMonth, localDate, longMonthDay, weekdayName } from "@/lib/dates";

/** How far either way the nearest written days are looked for. */
const NEARBY_SPAN = 7;

const isEmpty = (d: JournalDay) => d.artifacts.length === 0 && d.notes.length === 0 && d.conversations.length === 0;

/** The written days closest to `date`: the last one before it and the first one after it (never past today), each within a week. */
function useNearbyDays(date: string): JournalDay[] {
  const client = useClient();
  const [days, setDays] = useState<JournalDay[]>([]);
  useEffect(() => {
    let live = true;
    const today = localDate();
    const look = async (step: -1 | 1) => {
      const dates = Array.from({ length: NEARBY_SPAN }, (_, i) => addDays(date, step * (i + 1))).filter((d) => d <= today);
      const found = await Promise.all(dates.map((d) => client.journalDay(d).then((s) => s.data, () => null)));
      return found.find((d) => d && !isEmpty(d)) ?? null;
    };
    void Promise.all([look(-1), look(1)]).then((near) => {
      if (live) setDays(near.filter((d): d is JournalDay => d !== null));
    });
    return () => {
      live = false;
    };
  }, [client, date]);
  return days;
}

function NearbyDay({ day, rooms, onPick }: { day: JournalDay; rooms: readonly Room[]; onPick: () => void }) {
  const what = [
    day.conversations.length && count(day.conversations.length, "session"),
    day.artifacts.length && count(day.artifacts.length, "artifact"),
    day.notes.length && count(day.notes.length, "note"),
  ].filter(Boolean).join(", ");
  const where = [...new Set(day.artifacts.map((a) => rooms.find((r) => r.id === a.roomId)?.name).filter(Boolean))].join(", ");
  return (
    <button
      type="button"
      onClick={onPick}
      className="flex w-full items-center gap-3.5 rounded-xl bg-sheet px-3.5 py-3 text-left shadow-sheet outline-none hover:shadow-lift focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
    >
      <span className="flex w-10 flex-col items-center">
        <small className="text-caption font-medium text-ink-3 uppercase">{weekdayName(day.date).slice(0, 3)}</small>
        <b className="text-heading font-medium text-ink tabular-nums">{dayOfMonth(day.date)}</b>
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-body font-semibold text-ink">{what}</span>
        {where ? <span className="truncate text-small text-ink-3">{where}</span> : null}
      </span>
      <ChevronRight size={16} className="ml-auto shrink-0 text-ink-3" aria-hidden />
    </button>
  );
}

/**
 * A day with nothing in it: Clew asleep on the page's ruled line, a short line of copy, ways on
 * (write a note, go to today) and the nearest days that have something.
 */
export function EmptyDay({ date, rooms, writeNote, onPick }: { date: string; rooms: readonly Room[]; writeNote: ReactNode; onPick: (date: string) => void }) {
  const today = localDate();
  const nearby = useNearbyDays(date);
  const title = date === today ? "Nothing yet today." : date > today ? "This day hasn't happened yet." : `A quiet ${weekdayName(date)}.`;
  return (
    <div data-testid="empty-day">
      <div className="relative mt-1.5 mb-7 h-24 after:absolute after:inset-x-0 after:bottom-4 after:h-[1.5px] after:rounded-full after:bg-thread-soft">
        <ClewSleep label="Clew the otter, asleep" className="absolute bottom-0 left-[88px] z-10 w-[168px]" />
      </div>
      <div className="pl-[120px]">
        <h2 className="font-serif text-title font-medium text-ink">{title}</h2>
        <p className="mt-2 max-w-[46ch] text-lead text-ink-2">
          No artifacts and no notes on this day. Notes you write here are dated {longMonthDay(date)}.
        </p>
        <div className="mt-5 flex items-center gap-2">
          {writeNote}
          {date !== today ? (
            <button
              type="button"
              onClick={() => onPick(today)}
              className="inline-flex h-7 items-center rounded-lg px-2.5 text-small font-medium text-ink-2 outline-none hover:bg-surface focus-visible:outline-2 focus-visible:outline-ink"
            >
              Go to today
            </button>
          ) : null}
        </div>
        {nearby.length ? (
          <section aria-label="Nearest days" className="mt-10 flex max-w-[440px] flex-col gap-2">
            <h3 className="mb-1 text-small font-semibold tracking-[0.02em] text-ink-3">Nearest days with something in them</h3>
            {nearby.map((day) => (
              <NearbyDay key={day.date} day={day} rooms={rooms} onPick={() => onPick(day.date)} />
            ))}
          </section>
        ) : null}
      </div>
    </div>
  );
}

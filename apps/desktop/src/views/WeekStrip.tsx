import { ChevronLeft, ChevronRight } from "lucide-react";
import { addDays, dayOfMonth, monthDay, weekOf, WEEKDAY_LETTERS } from "@/lib/dates";
import { cn } from "@/lib/utils";

const NAV =
  "grid size-11 shrink-0 place-items-center rounded-lg text-ink-2 hover:bg-surface hover:text-ink focus-visible:outline-2 focus-visible:outline-ink";

/** `‹` · the seven days (Sunday → Saturday) of the selected date's week · `›`. */
export function WeekStrip({ date, onChange }: { date: string; onChange: (date: string) => void }) {
  return (
    <div className="flex items-center gap-1">
      <button type="button" aria-label="Previous week" className={NAV} onClick={() => onChange(addDays(date, -7))}>
        <ChevronLeft size={18} strokeWidth={1.75} aria-hidden />
      </button>
      {weekOf(date).map((d, i) => {
        const selected = d === date;
        return (
          <button
            key={d}
            type="button"
            aria-label={monthDay(d)}
            aria-pressed={selected}
            onClick={() => onChange(d)}
            className={cn(
              "flex min-h-11 w-11 flex-col items-center justify-center rounded-lg leading-tight",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink",
              selected ? "bg-ink text-pane" : "text-ink-2 hover:bg-surface",
            )}
          >
            <span aria-hidden className="text-small">
              {WEEKDAY_LETTERS[i]}
            </span>
            <span aria-hidden className="text-lead">
              {dayOfMonth(d)}
            </span>
          </button>
        );
      })}
      <button type="button" aria-label="Next week" className={NAV} onClick={() => onChange(addDays(date, 7))}>
        <ChevronRight size={18} strokeWidth={1.75} aria-hidden />
      </button>
    </div>
  );
}

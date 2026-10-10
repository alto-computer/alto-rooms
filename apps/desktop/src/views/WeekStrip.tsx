import { ChevronLeft, ChevronRight } from "lucide-react";
import { addDays, dayOfMonth, localDate, monthDay, weekOf, WEEKDAY_LETTERS } from "@/lib/dates";
import { cn } from "@/lib/utils";

const NAV =
  "grid size-8 shrink-0 place-items-center rounded-lg text-ink-2 hover:bg-surface hover:text-ink focus-visible:outline-2 focus-visible:outline-ink";

/** `‹` · the seven days (Sunday → Saturday) of the selected date's week · `›`. Today carries a red dot; days ahead are dimmed. */
export function WeekStrip({ date, onChange }: { date: string; onChange: (date: string) => void }) {
  const today = localDate();
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
              "flex h-14 w-[42px] flex-col items-center justify-center gap-0.5 rounded-[10px] leading-tight",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink",
              selected ? "bg-sheet text-ink shadow-sheet" : "text-ink-2 hover:bg-surface",
              d > today && "opacity-50",
            )}
          >
            <span aria-hidden className="text-caption font-medium text-ink-3">
              {WEEKDAY_LETTERS[i]}
            </span>
            <span aria-hidden className={cn("text-heading tabular-nums", selected ? "font-semibold" : "font-medium")}>
              {dayOfMonth(d)}
            </span>
            <span aria-hidden className={cn("size-1 rounded-full", d === today ? "bg-thread" : "bg-transparent")} />
          </button>
        );
      })}
      <button type="button" aria-label="Next week" className={NAV} onClick={() => onChange(addDays(date, 7))}>
        <ChevronRight size={18} strokeWidth={1.75} aria-hidden />
      </button>
    </div>
  );
}

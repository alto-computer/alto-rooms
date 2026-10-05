import { addDays, dayOfMonth, monthDay, weekOf, WEEKDAY_LETTERS } from "@/lib/dates";
import { cn } from "@/lib/utils";

const NAV =
  "grid size-11 shrink-0 place-items-center rounded-lg text-ink-2 hover:bg-[#f2f2f2] hover:text-ink focus-visible:outline-2 focus-visible:outline-ink";

/** `‹` · the seven days (Sunday → Saturday) of the selected date's week · `›`. */
export function WeekStrip({ date, onChange }: { date: string; onChange: (date: string) => void }) {
  return (
    <div className="flex items-center gap-1">
      <button type="button" aria-label="Previous week" className={NAV} onClick={() => onChange(addDays(date, -7))}>
        <span aria-hidden className="text-[20px] leading-none">‹</span>
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
              selected ? "bg-[#222] text-white" : "text-ink-2 hover:bg-[#f2f2f2]",
            )}
          >
            <span aria-hidden className="text-[12px]">
              {WEEKDAY_LETTERS[i]}
            </span>
            <span aria-hidden className="text-[15px]">
              {dayOfMonth(d)}
            </span>
          </button>
        );
      })}
      <button type="button" aria-label="Next week" className={NAV} onClick={() => onChange(addDays(date, 7))}>
        <span aria-hidden className="text-[20px] leading-none">›</span>
      </button>
    </div>
  );
}

import { Sparkles } from "lucide-react";
import { useViewerStore } from "@/data/hooks";
import { openSettings } from "@/lib/settings";
import { ago, type SortState } from "@/lib/sort";
import { useSortState } from "@/lib/useSortState";

/**
 * Auto-sort above the inbox: one quiet line on what it does now, linking to Settings, where the
 * TypeSafe key and undo live. Renders nothing outside the app (no sorter there).
 */
export function SortBar() {
  const [state] = useSortState();
  const viewer = useViewerStore();
  if (!state) return null;
  const { text, link, error } = line(state);
  return (
    <p data-testid="sort-bar" className="flex flex-wrap items-center gap-x-1.5 text-small text-ink-2">
      <Sparkles size={14} aria-hidden className="shrink-0" />
      <span className={error ? "text-error" : undefined}>{text}</span>
      <span aria-hidden>·</span>
      <button
        type="button"
        onClick={() => openSettings(viewer, "auto-sort")}
        className="text-ink underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
      >
        {link}
      </button>
    </p>
  );
}

function line({ keySource, keyRejected, status }: SortState): { text: string; link: string; error?: boolean } {
  if (keyRejected) return { text: "TypeSafe refused the auto-sort key", link: "Fix in Settings", error: true };
  if (keySource === "none") return { text: "Only artifacts named like a room sort on their own", link: "Add a key in Settings" };
  const run = status ? `${status.movedToday} moved today, ${status.keptToday} left here · ${ago(status.lastRunAt)}` : "first sort within a minute";
  return { text: `Auto-sort is on · ${run}`, link: "Settings" };
}

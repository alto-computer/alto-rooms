import type { MouseEvent } from "react";
import { useViewerStore } from "@/data/hooks";
import type { StudyPage } from "@/data/viewerStore";
import { localDate } from "@/lib/dates";
import { wantsNewTab } from "@/lib/nav";

/** Goes to a Study page in this tab, or in a new one on ⌘/Ctrl or middle click. */
export function useStudyGo(): (page: StudyPage, e?: Pick<MouseEvent, "metaKey" | "ctrlKey" | "button">) => void {
  const viewer = useViewerStore();
  return (page, e) => viewer.go({ kind: "study", ...page }, e ? wantsNewTab(e) : false);
}

/** The two words on top: 서재 (the library) and 달력 (today's page). */
export function Axes({ on }: { on: "library" | "day" }) {
  const go = useStudyGo();
  return (
    <nav className="st-axes" aria-label="Library · Calendar">
      <button type="button" aria-current={on === "library" ? "page" : undefined} onClick={(e) => go({ page: "library" }, e)}>
        Library
      </button>
      <button type="button" aria-current={on === "day" ? "page" : undefined} onClick={(e) => go({ page: "day", date: localDate() }, e)}>
        Calendar
      </button>
    </nav>
  );
}

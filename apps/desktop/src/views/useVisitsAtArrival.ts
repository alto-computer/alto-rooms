import { useRef } from "react";
import { useViewerStore } from "@/data/hooks";

export type Visits = {
  lastVisit: Record<string, string>;
  firstRunAt: string;
  /** The "new since" baseline for a room: its last visit, else the first run. */
  since: (roomId: string) => string;
};

/**
 * The viewer's room visits as they were when this view mounted (AppShell mounts a
 * view on arrival). Frozen: `lastVisit` is only written when leaving, and new-doc
 * dots must not vanish while they are being looked at.
 */
export function useVisitsAtArrival(): Visits {
  const viewer = useViewerStore();
  const visits = useRef<Visits | null>(null);
  if (visits.current === null) {
    const { lastVisit, firstRunAt } = viewer.getState();
    visits.current = { lastVisit, firstRunAt, since: (roomId) => lastVisit[roomId] ?? firstRunAt };
  }
  return visits.current;
}

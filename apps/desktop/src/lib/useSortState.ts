import { useCallback, useEffect, useState } from "react";
import { sortState, type SortState } from "./sort";

const POLL_MS = 20_000;

/**
 * The sorter's state, polled while mounted (rooms-sort runs every minute), and a refresh to
 * call after changing it. Null until known, and always outside the app.
 */
export function useSortState(): [SortState | null, () => Promise<void>] {
  const [state, setState] = useState<SortState | null>(null);
  const refresh = useCallback(async () => {
    try {
      setState(await sortState());
    } catch {
      setState(null);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);
  return [state, refresh];
}

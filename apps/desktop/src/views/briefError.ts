import { useCallback, useEffect, useRef, useState } from "react";

/** How long a passing failure (copy, open in editor) stays on screen. */
export const BRIEF_ERROR_MS = 3000;

/**
 * A failure worth mentioning but not keeping: `flash()` shows it, and it
 * clears itself after BRIEF_ERROR_MS (or when the component unmounts).
 */
export function useBriefError(ms = BRIEF_ERROR_MS): { shown: boolean; flash: () => void; clear: () => void } {
  const [shown, setShown] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const flash = useCallback(() => {
    clearTimeout(timer.current);
    setShown(true);
    timer.current = setTimeout(() => setShown(false), ms);
  }, [ms]);
  const clear = useCallback(() => {
    clearTimeout(timer.current);
    setShown(false);
  }, []);
  return { shown, flash, clear };
}

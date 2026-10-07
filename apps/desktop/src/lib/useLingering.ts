import { useEffect, useState } from "react";

/** `value`, except that turning false waits `ms` (and is dropped if it turns true again meanwhile). */
export function useLingering(value: boolean, ms: number): boolean {
  const [held, setHeld] = useState(value);
  useEffect(() => {
    if (value) {
      setHeld(true);
      return;
    }
    const t = setTimeout(() => setHeld(false), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return value || held;
}

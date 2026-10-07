import { useEffect, useState } from "react";

/**
 * At most a few previews load at once. A room opening asks for a dozen live frames
 * together; loading them a few at a time keeps the first ones (and the UI) quick.
 * A slot is held from start until its frame loads, or for at most SLOT_TIMEOUT_MS.
 */
export const MAX_LOADING = 4;
const SLOT_TIMEOUT_MS = 5000;

type Waiter = () => void;
let busy = 0;
const queue: Waiter[] = [];

function acquire(grant: Waiter): () => void {
  let state: "waiting" | "held" | "done" = "waiting";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const start = () => {
    state = "held";
    busy++;
    timer = setTimeout(release, SLOT_TIMEOUT_MS);
    grant();
  };
  function release() {
    if (state === "waiting") queue.splice(queue.indexOf(start), 1);
    if (state === "held") {
      clearTimeout(timer);
      busy--;
      queue.shift()?.();
    }
    state = "done";
  }
  if (busy < MAX_LOADING) start();
  else queue.push(start);
  return release;
}

/**
 * While `want`, waits for a load slot. Returns whether the caller may start loading,
 * and `loaded` to call when it has (frees the slot early). Letting go of `want` frees it.
 */
export function useLoadSlot(want: boolean): { granted: boolean; loaded: () => void } {
  const [granted, setGranted] = useState(false);
  const [release, setRelease] = useState<(() => void) | null>(null);
  useEffect(() => {
    if (!want) {
      setGranted(false);
      return;
    }
    const r = acquire(() => setGranted(true));
    setRelease(() => r);
    return () => {
      r();
      setRelease(null);
    };
  }, [want]);
  return { granted: want && granted, loaded: () => release?.() };
}

/** Test seam. */
export function resetLoadSlots() {
  busy = 0;
  queue.length = 0;
}

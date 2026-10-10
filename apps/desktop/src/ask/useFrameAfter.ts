import { useEffect, useState } from "react";

// WebKit fires no animation frames for a covered or hidden window; the timeout keeps it from waiting forever.
const FRAME_FALLBACK_MS = 100;

/** False until the frame after `when` first holds, or FRAME_FALLBACK_MS later if no frame comes. */
export function useFrameAfter(when: boolean): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!when || ready) return;
    const done = () => setReady(true);
    const frame = requestAnimationFrame(done);
    const timer = setTimeout(done, FRAME_FALLBACK_MS);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [when, ready]);
  return ready;
}

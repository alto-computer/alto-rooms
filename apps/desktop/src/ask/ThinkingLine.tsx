import { useEffect, useState } from "react";

/** Whole seconds since `startedAt`, ticking every second while mounted. */
function useElapsed(startedAt: string): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);
  return Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
}

/** Codex-style waiting line: a shimmer sweeping over "Thinking", then a muted live "(3s · esc to interrupt)". */
export function ThinkingLine({ startedAt }: { startedAt: string }) {
  const secs = useElapsed(startedAt);
  return (
    <>
      <span className="animate-shimmer bg-linear-to-r from-ink-2 via-[#c9c9c9] to-ink-2 bg-[length:200%_100%] bg-clip-text text-transparent motion-reduce:animate-none motion-reduce:text-ink-2">
        Thinking
      </span>
      <span className="text-ink-3">({secs}s · esc to interrupt)</span>
    </>
  );
}

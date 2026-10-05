import { useEffect, useRef, useState } from "react";
import type { Room } from "@alto-rooms/protocol-ts";
import clewPeek from "@/assets/clew-peek.svg";
import { tildePath } from "@/lib/paths";

/** How long "복사했어요" stays after copying the path. */
const COPIED_MS = 1500;

/**
 * A room with no artifacts: Clew peeking out of the water, the hint, and the
 * folder path as a chip (`~` for the user's home). Clicking the chip copies
 * the absolute path. `home` is the rooms home (`Info.home`).
 */
export function EmptyRoom({ room, home }: { room: Room; home: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(room.path);
    } catch {
      return; // No clipboard access: nothing extra to show.
    }
    clearTimeout(timer.current);
    setCopied(true);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  };

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
      <img src={clewPeek} alt="물 위로 막 올라온 수달 Clew" width={220} className="mb-2 h-auto w-[220px]" />
      <p className="text-[17px] text-ink">아직 아티팩트가 없어요</p>
      <p className="text-[15px] text-ink-2">에이전트에게 이 폴더에 HTML로 저장해 달라고 하세요</p>
      <button
        type="button"
        onClick={() => void copy()}
        className="mt-2 max-w-full truncate rounded-lg border border-[#ddd] bg-white px-3 py-2 font-mono text-[13px] text-ink-2 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
      >
        {tildePath(room.path, home)}
      </button>
      <p role="status" className="min-h-5 text-[14px] text-ink-3">
        {copied ? "복사했어요" : null}
      </p>
    </div>
  );
}

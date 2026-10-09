import type { Room } from "@alto-rooms/protocol-ts";
import { Copy } from "lucide-react";
import { tildePath } from "@/lib/paths";
import { CopyStatus, useCopy } from "./CopyChip";

/**
 * A room with no artifacts, under a band Clew perches on: one sentence, the folder path with a
 * copy button (`~` for the user's home; the copy is absolute), and a compact row on how
 * artifacts arrive. `home` is the rooms home (`Info.home`).
 */
export function EmptyRoom({ room, home }: { room: Room; home: string }) {
  const { copied, failed, copy } = useCopy();
  const path = tildePath(room.path, home);
  return (
    <div className="flex flex-col px-10 pt-12 pb-10">
      <section aria-label="Empty room" className="max-w-[560px]">
        <h2 className="font-display text-title font-medium tracking-[-0.005em] text-ink">Nothing in {room.name} yet</h2>
        <p className="mt-2.5 text-lead text-ink-2">
          Artifacts land here when an agent's work is sorted into this room. You can also drag one onto this room in the sidebar.
        </p>
        <div className="mt-5 flex min-w-0 items-center gap-3">
          <button
            type="button"
            onClick={() => void copy(room.path)}
            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg bg-sheet px-2.5 text-small font-medium text-ink shadow-sheet outline-none hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            <Copy size={14} className="text-ink-2" aria-hidden />
            Copy folder path
          </button>
          <span className="min-w-0 truncate font-mono text-small text-ink-3">{path}</span>
        </div>
        <CopyStatus copied={copied} failed={failed.shown} />
      </section>
      <section aria-labelledby="how-artifacts-arrive" className="mt-10 border-t border-hairline pt-7">
        <h3 id="how-artifacts-arrive" className="text-small font-semibold tracking-[0.02em] text-ink-3">
          How artifacts arrive here
        </h3>
        <ol className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-x-10 gap-y-5">
          {[
            ["An agent writes an HTML artifact", <>A spec, a report or a review, saved wherever the agent was working.</>],
            ["Sorting links it into a room", <>Ask your agent to "sort my rooms". It links each artifact into the room it is about; the original never moves.</>],
            ["Unsure ones wait in the Inbox", <>Drag them onto a room by hand. This room's folder is <code className="font-mono text-ink">{path}</code>.</>],
          ].map(([title, text], i) => (
            <li key={i} className="flex gap-3">
              <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-full text-small font-medium text-ink-2 shadow-[inset_0_0_0_1.25px_var(--hairline-strong)]">
                {i + 1}
              </span>
              <div className="flex flex-col gap-1 pt-0.5">
                <b className="text-body font-semibold text-ink">{title}</b>
                <span className="text-body text-ink-2">{text}</span>
              </div>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

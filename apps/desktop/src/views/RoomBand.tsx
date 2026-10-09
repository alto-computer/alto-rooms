import type { CSSProperties, ReactNode } from "react";
import { ClewPeek } from "@/components/ClewPeek";
import { cn } from "@/lib/utils";

/** Clew perches on the band while a room holds this many artifacts or fewer; from the next one the band is compact and Clew is gone. */
export const PERCH_MAX = 3;

/** Where Clew sits on the band: above the empty-state copy, over the cards, or nowhere (a full room shows artifacts, not an otter). */
export type Perch = "start" | "end" | null;

export function perchFor(artifactCount: number): Perch {
  if (artifactCount === 0) return "start";
  return artifactCount <= PERCH_MAX ? "end" : null;
}

/**
 * A room's header band, like a wall: title, a meta line and actions, with Clew perched on its
 * bottom edge while the room is nearly empty. Warm paper by default; `tint` (any CSS colour)
 * paints it instead, for a pinned room, and drops the hairline under it.
 */
export function RoomBand({ title, meta, actions, perch, tint, children }: {
  title: ReactNode;
  meta: ReactNode;
  actions?: ReactNode;
  perch: Perch;
  tint?: string;
  children?: ReactNode;
}) {
  return (
    <header
      data-testid="room-band"
      data-perch={perch ?? undefined}
      style={tint ? ({ "--room-tint": tint } as CSSProperties) : undefined}
      className={cn(
        "relative shrink-0 bg-[var(--room-tint,var(--paper-band))] px-10 pt-[30px]",
        !tint && "shadow-[inset_0_-1px_0_var(--hairline)]",
        perch === "start" ? "pb-[76px]" : perch === "end" ? "pb-10" : "pb-[26px]",
      )}
    >
      <div className={cn("flex gap-4", perch ? "items-start" : "items-end")}>
        <div className="flex min-w-0 flex-col gap-2">
          {title}
          <div className="flex flex-wrap items-center gap-1.5 text-body text-ink-2">{meta}</div>
        </div>
        {actions ? <div className="ml-auto flex shrink-0 gap-1.5">{actions}</div> : null}
      </div>
      {children}
      {perch ? (
        <ClewPeek
          label="Clew the otter, peeking over the edge"
          className={cn("pointer-events-none absolute -bottom-[7px] w-[112px]", perch === "start" ? "left-10" : "right-24")}
        />
      ) : null}
    </header>
  );
}

/** A quiet button that sits on the band. */
export const bandButton =
  "inline-flex h-7 items-center gap-1.5 rounded-lg bg-on-band px-2.5 text-small font-medium whitespace-nowrap text-ink outline-none hover:bg-on-band-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink [&_svg]:size-3.5 [&_svg]:text-ink-2";

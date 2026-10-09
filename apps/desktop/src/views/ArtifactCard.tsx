import { memo, type KeyboardEvent } from "react";
import type { Artifact, Info } from "@alto-rooms/protocol-ts";
import { Maximize2 } from "lucide-react";
import { Dotted } from "@/components/Dotted";
import { artifactDragSource } from "@/lib/drag";
import { shortAge } from "@/lib/dates";
import { wantsNewTab } from "@/lib/nav";
import { ArtifactThumb } from "./ArtifactThumb";

export type ArtifactCardProps = {
  artifact: Artifact;
  info: Info;
  isNew: boolean;
  /** Opens the artifact: here, or in a new tab (⌘/middle click, or the expand button). Pass a stable function: cards are memoized. */
  onOpen: (artifact: Artifact, newTab: boolean) => void;
  /** The whole card drags onto sidebar rooms (inbox cards, when writable). */
  draggable?: boolean;
};

/** "New" in the thread colour, one of the few places red appears. */
export function NewMark() {
  return (
    <span role="img" aria-label="New artifact" className="inline-flex items-center gap-1.5 font-medium text-thread-deep">
      <span aria-hidden className="size-1.5 rounded-full bg-thread" />
      New
    </span>
  );
}

/**
 * One artifact on a sheet: the top of the page cropped to 16:10, then the title and a line with
 * "New", the agent that wrote it and how long ago. The card body is a focusable button:
 * click/Enter/Space opens the artifact in this tab (⌘ or a middle click: a new tab); the expand
 * button, shown on hover or focus, always opens a new tab.
 */
export const ArtifactCard = memo(function ArtifactCard({ artifact, info, isNew, onOpen: open, draggable = false }: ArtifactCardProps) {
  const onOpen = (newTab: boolean) => open(artifact, newTab);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpen(wantsNewTab(e));
    }
  };

  return (
    <div
      data-testid="artifact-card"
      {...(draggable ? artifactDragSource({ roomId: artifact.roomId, artifactId: artifact.id }) : {})}
      className="group/card relative min-w-0"
    >
      <div
        role="button"
        tabIndex={0}
        aria-label={artifact.title}
        onClick={(e) => onOpen(wantsNewTab(e))}
        onAuxClick={(e) => e.button === 1 && onOpen(true)}
        onKeyDown={onKeyDown}
        // Hover lifts the card a little; it never resizes it, which would reflow the grid.
        className="flex cursor-pointer flex-col rounded-xl bg-sheet px-1.5 pt-1.5 shadow-sheet outline-none transition-[translate,box-shadow] duration-150 ease-out group-hover/card:-translate-y-0.5 group-hover/card:shadow-lift focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink motion-reduce:transition-none"
      >
        <ArtifactThumb artifact={artifact} info={info} variant="card" className="rounded-lg" />
        <div className="min-w-0 px-2 pt-2.5 pb-3">
          <div data-testid="card-title" className="truncate text-body font-semibold text-ink">
            {artifact.title}
          </div>
          <p className="mt-1 flex h-[18px] items-center gap-1.5 text-small whitespace-nowrap text-ink-3">
            <Dotted parts={[isNew && <NewMark />, artifact.source.agent && <span className="truncate">{artifact.source.agent}</span>, shortAge(artifact.createdAt)]} />
          </p>
        </div>
      </div>
      <button
        type="button"
        aria-label="Open in new tab"
        onClick={() => onOpen(true)}
        className="absolute top-3 right-3 flex size-8 items-center justify-center rounded-lg bg-sheet text-ink opacity-0 shadow-float transition-opacity outline-none group-focus-within/card:opacity-100 group-hover/card:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
      >
        <Maximize2 size={15} aria-hidden />
      </button>
    </div>
  );
});

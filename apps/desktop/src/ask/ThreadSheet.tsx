import { useEffect, useRef, type RefObject } from "react";
import { ArrowDown } from "lucide-react";
import type { AskTurn } from "@alto-rooms/protocol-ts";
import { askAction, SelectionBar } from "@/selection/SelectionBar";
import { useTextSelection } from "@/selection/useTextSelection";
import type { Live } from "./asksStore";
import type { NoteTargetOf, TurnHeader } from "./askSubjects";
import { PendingTurn, Turn } from "./Turn";
import { ErrorText, TextButton } from "./ui";
import type { Pending } from "./useComposer";
import { useStickToBottom } from "./useStickToBottom";

/** Turns further back than this skip layout and paint while off screen: a long thread stays quick. */
const RECENT_TURNS = 4;

/** Said under the last question when earlier answers no longer fit in what goes along with it. */
function LeftOutNote({ count, onCompact }: { count: number; onCompact: () => void }) {
  return (
    <p className="mt-3 flex flex-wrap items-center gap-x-1 text-small text-ink-2">
      {count === 1 ? "1 earlier answer wasn't" : `${count} earlier answers weren't`} sent along: the conversation got long.
      <TextButton onClick={onCompact}>Summarize it</TextButton>
    </p>
  );
}

/**
 * Follows the thread: stuck to the bottom while an answer thinks or streams; when a whole answer
 * lands at once, its question goes to the top instead, so a long answer reads from its start.
 */
function useFollow(sheet: RefObject<HTMLDivElement | null>, turns: AskTurn[], live: Record<string, Live>, pending: boolean) {
  const running = turns.find((t) => t.status === "running");
  const streaming = running ? live[running.id] : undefined;
  /** The turn running as of the last commit. */
  const wasRunning = useRef<string | undefined>(undefined);
  /** Turns whose answer streamed in: the reader already followed it down. */
  const streamed = useRef(new Set<string>());
  if (running && streaming?.answer) streamed.current.add(running.id);
  const follow = useStickToBottom(sheet, [turns.length, turns.map((t) => t.status).join(), streaming?.answer.length, streaming?.activity, pending], () => {
    const id = wasRunning.current;
    if (!id || streamed.current.has(id) || turns.find((t) => t.id === id)?.status !== "done") return null;
    return Array.from(sheet.current?.querySelectorAll<HTMLElement>("[data-turn-id]") ?? []).find((el) => el.dataset.turnId === id) ?? null;
  });
  useEffect(() => {
    wasRunning.current = running?.id;
  }, [running?.id]);
  return follow;
}

/**
 * A thread above the ask bar: its turns, a question on its way, and an "Ask" button over text
 * selected in an answer (it becomes a quote).
 */
export function ThreadSheet({ turns, header, noteTarget, live, loadError, pending, onRetry, onCompact, onReload, onQuote }: {
  turns: AskTurn[];
  header: (t: AskTurn) => TurnHeader;
  /** Where "Save as note" files a finished answer; null shows no save button. Keep it stable: turns are memoized. */
  noteTarget: NoteTargetOf | null;
  live: Record<string, Live>;
  loadError: boolean;
  pending: Pending | null;
  onRetry: (t: AskTurn) => void;
  onCompact: () => void;
  onReload: () => void;
  onQuote: (text: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const { away, toBottom } = useFollow(sheet, turns, live, !!pending);
  const selection = useTextSelection(sheet, box, true);
  const last = turns.at(-1);
  const head = last ? header(last) : null;
  const leftOut = last && (last.kind ?? "question") === "question" ? last.leftOut : 0;

  return (
    <div ref={box} className="pointer-events-auto relative w-full max-w-[720px]">
      <div ref={sheet} className="max-h-[50vh] overflow-y-auto rounded-xl border border-hairline bg-sheet px-4 py-3 text-body shadow-float">
        {head ? <div className="mb-2 text-small text-ink-2" title={head.title}>{head.text}</div> : null}
        {loadError ? (
          <div>
            <ErrorText>Couldn't load the conversation</ErrorText>
            <TextButton onClick={onReload}>Try again</TextButton>
          </div>
        ) : null}
        <div className="space-y-4">
          {turns.map((t, i) => (
            <Turn key={t.id} t={t} live={live[t.id]} old={i < turns.length - RECENT_TURNS} noteTarget={noteTarget} onRetry={onRetry} />
          ))}
          {/* Until its turn shows up; a question that waits behind a running one shows in the queue instead. */}
          {pending && !turns.some((t) => t.status === "running") ? <PendingTurn pending={pending} /> : null}
        </div>
        {leftOut > 0 ? <LeftOutNote count={leftOut} onCompact={onCompact} /> : null}
      </div>
      {away ? (
        <button
          type="button"
          aria-label="Scroll to the latest"
          onClick={toBottom}
          className="absolute bottom-3 left-1/2 flex size-7 -translate-x-1/2 items-center justify-center rounded-full border border-hairline bg-sheet text-ink-2 shadow-sheet hover:text-ink focus-visible:outline-2 focus-visible:outline-ink"
        >
          <ArrowDown className="size-3.5" />
        </button>
      ) : null}
      {selection.picked ? (
        <SelectionBar
          rect={selection.picked.rect}
          actions={[
            askAction(() => {
              onQuote(selection.picked!.text);
              document.getSelection()?.removeAllRanges();
              selection.dismiss();
            }),
          ]}
        />
      ) : null}
    </div>
  );
}

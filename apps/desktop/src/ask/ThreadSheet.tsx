import { useEffect, useRef, useSyncExternalStore, type RefObject } from "react";
import { ArrowDown } from "lucide-react";
import type { AskScope, AskTurn } from "@alto-rooms/protocol-ts";
import { askAction, SelectionBar, type SelectionAction } from "@/selection/SelectionBar";
import { useTextSelection, type SelectionRect } from "@/selection/useTextSelection";
import { surfaceHub, type SurfaceMenu } from "@/surfaces/surfaceHub";
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

/** Where a plugin's menu goes: under the last line of its range, relative to `box`. */
function menuRect(menu: SurfaceMenu, box: HTMLElement): SelectionRect {
  const rects = menu.range.getClientRects();
  const r = rects.length ? rects[rects.length - 1] : menu.range.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  return { x: r.left - b.left, y: r.top - b.top, w: r.width, h: r.height };
}

/** A plugin's menu over one of its painted ranges in this sheet, until a click elsewhere or Esc. */
function useRangeMenu(sheet: RefObject<HTMLDivElement | null>): SurfaceMenu | null {
  const { menu } = useSyncExternalStore(surfaceHub.subscribe, surfaceHub.getSnapshot);
  const mine = menu && sheet.current?.contains(menu.range.startContainer) ? menu : null;
  useEffect(() => {
    if (!mine) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest("[data-selection-ask]")) surfaceHub.closeMenu();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") surfaceHub.closeMenu();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [mine]);
  return mine;
}

/**
 * A thread above the ask bar: its turns, a question on its way, and a bar over text selected in
 * an answer: "Ask" (it becomes a quote), then the buttons of the plugins that mark answers.
 */
export function ThreadSheet({ turns, scope, header, noteTarget, live, loadError, pending, onRetry, onCompact, onReload, onQuote }: {
  turns: AskTurn[];
  /** The thread's scope. Keep it stable: turns are memoized. */
  scope: AskScope;
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
  const selection = useTextSelection(sheet, box, true, surfaceHub.locate);
  const { actions: surfaceActions } = useSyncExternalStore(surfaceHub.subscribe, surfaceHub.getSnapshot);
  const menu = useRangeMenu(sheet);
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
            <Turn key={t.id} t={t} scope={scope} live={live[t.id]} old={i < turns.length - RECENT_TURNS} noteTarget={noteTarget} onRetry={onRetry} />
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
            ...(selection.picked.span
              ? surfaceActions.map(
                  (a): SelectionAction => ({
                    key: `${a.plugin}:${a.id}`,
                    title: a.title,
                    color: a.color,
                    run: () => {
                      surfaceHub.runAction(a.plugin, a.id, selection.picked!.span!);
                      document.getSelection()?.removeAllRanges();
                      selection.dismiss();
                    },
                  }),
                )
              : []),
          ]}
        />
      ) : null}
      {menu && box.current ? (
        <SelectionBar
          rect={menuRect(menu, box.current)}
          actions={menu.items.map((a): SelectionAction => ({ key: `${menu.plugin}:${a.id}`, title: a.title, color: a.color, run: () => surfaceHub.runMenu(a.id) }))}
        />
      ) : null}
    </div>
  );
}

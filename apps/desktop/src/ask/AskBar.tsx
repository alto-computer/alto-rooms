import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { Artifact, AskTurn } from "@alto-rooms/protocol-ts";
import { useAsks, useAsksStore, useReadOnly } from "@/data/hooks";
import type { AskDoc } from "./asksStore";
import { Composer } from "./Composer";
import { AgentChip, ModelPicker } from "./ModelPicker";
import { ThreadSheet } from "./ThreadSheet";
import { preloadAnswer } from "./Turn";
import { ErrorText } from "./ui";
import { useAskTarget } from "./useAskTarget";
import { useComposer } from "./useComposer";

/** Portaled out of the bar but still part of it: a click there doesn't fold the thread. */
const PART_OF_THE_BAR = "[data-slot=dropdown-menu-content], [data-slot=dialog-content], [data-slot=dialog-overlay], [data-selection-ask]";

/**
 * The ask bar under a doc (⌘J): the doc's thread, and the input that asks the agent that made the
 * doc about it. The thread folds on Esc or a click elsewhere, and unfolds when the input is focused.
 */
export function AskBar({ artifact }: { artifact: Artifact }) {
  const store = useAsksStore();
  const { open, threads, live } = useAsks();
  const readOnly = useReadOnly();
  const shown = open && !readOnly;
  const { roomId, id: artifactId, fileKey } = artifact;
  const doc: AskDoc = { roomId, artifactId, fileKey };
  const thread = threads[fileKey];
  const turns = thread?.turns ?? [];
  const running = turns.find((t) => t.status === "running");
  const { target, model, pick, modelFor } = useAskTarget(doc, shown);
  const composer = useComposer(doc, model);
  const [unfolded, setUnfolded] = useState(true);
  const [dragging, setDragging] = useState(false);
  /** What the live region says once an answer ends. */
  const [announce, setAnnounce] = useState("");
  const container = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => store.hold(fileKey), [store, fileKey]);
  // Fetch the Markdown renderer while the doc is read, so an answer never waits on it.
  useEffect(() => void preloadAnswer(), []);
  useLoadThread(fileKey, shown && !(thread?.loaded ?? false));
  useFocusRules({ open, shown, quoteCount: composer.quotes.length, runningId: running?.id, input, container, setUnfolded, setAnnounce });
  useFoldOnOutsideClick(container, shown, () => setUnfolded(false));

  // Stable for the memoized turns.
  const retryWith = useRef<(t: AskTurn) => void>(() => {});
  retryWith.current = (t: AskTurn) => composer.retry(t, modelFor(t));
  const retry = useCallback((t: AskTurn) => retryWith.current(t), []);

  if (!shown) return null;
  const showThread = unfolded && (turns.length > 0 || !!thread?.error || !!composer.pending);
  return (
    <div
      ref={container}
      className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center gap-3 px-4 pb-4"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        setDragging(false);
        if (e.dataTransfer.files.length === 0) return;
        e.preventDefault();
        if (composer.attachments.add(e.dataTransfer.files)) input.current?.focus();
      }}
    >
      {showThread ? (
        <ThreadSheet
          turns={turns}
          live={live}
          loadError={!!thread?.error}
          pending={composer.pending}
          onRetry={retry}
          onCompact={() => composer.runCommand("compact")}
          onReload={() => void store.load(fileKey)}
          onQuote={(text) => store.addQuote(fileKey, text)}
        />
      ) : null}
      {/* For screen readers: when an answer starts and when it lands. */}
      <div aria-live="polite" className="sr-only">{running ? "Waiting for the answer" : announce}</div>
      {composer.error ? <div className="pointer-events-auto"><ErrorText>{composer.error}</ErrorText></div> : null}
      <Composer
        composer={composer}
        inputRef={input}
        turns={turns}
        running={running}
        dragging={dragging}
        model={target ? <ModelPicker target={target} model={model} onChange={pick} /> : <AgentChip name={artifact.source.agent ?? "Default agent"} />}
        onStop={() => running && store.cancel(running.id)}
        onFold={() => setUnfolded(false)}
        onFocus={() => setUnfolded(true)}
      />
    </div>
  );
}

/** Loads the thread when it's needed and not loaded (an ask event from another client creates it unloaded). */
function useLoadThread(fileKey: string, needed: boolean) {
  const store = useAsksStore();
  const loading = useRef<string | null>(null);
  useEffect(() => {
    if (!needed || loading.current === fileKey) return;
    loading.current = fileKey;
    void store.load(fileKey).finally(() => {
      if (loading.current === fileKey) loading.current = null;
    });
  }, [needed, store, fileKey]);
}

/**
 * Where the caret goes, never stolen from the doc or another input:
 * - into the input when the user opens the bar (not on mount: doc tabs must not grab focus);
 * - into the input when a quote is added, ready for the question;
 * - back into the input when an answer ends, if focus was nowhere else or in the bar.
 */
function useFocusRules({ open, shown, quoteCount, runningId, input, container, setUnfolded, setAnnounce }: {
  open: boolean;
  shown: boolean;
  quoteCount: number;
  runningId: string | undefined;
  input: RefObject<HTMLTextAreaElement | null>;
  container: RefObject<HTMLDivElement | null>;
  setUnfolded: (v: boolean) => void;
  setAnnounce: (s: string) => void;
}) {
  const wasOpen = useRef(open);
  useEffect(() => {
    if (open && !wasOpen.current && shown) input.current?.focus();
    wasOpen.current = open;
  }, [open, shown, input]);

  const quotes = useRef(quoteCount);
  useEffect(() => {
    if (quoteCount > quotes.current && shown) {
      setUnfolded(true);
      input.current?.focus();
    }
    quotes.current = quoteCount;
  }, [quoteCount, shown, input, setUnfolded]);

  const wasRunning = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (wasRunning.current && !runningId && shown) {
      setAnnounce("Answer ready");
      const active = document.activeElement;
      if (!active || active === document.body || !!container.current?.contains(active)) input.current?.focus();
    }
    wasRunning.current = runningId;
  }, [runningId, shown, input, container, setAnnounce]);
}

/** A click outside the bar folds the thread, like Esc. A click in the doc iframe never reaches this document, so focus moving into an iframe counts too. */
function useFoldOnOutsideClick(container: RefObject<HTMLDivElement | null>, shown: boolean, fold: () => void) {
  const latest = useRef(fold);
  latest.current = fold;
  useEffect(() => {
    if (!shown) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!(e.target instanceof Element) || container.current?.contains(e.target)) return;
      if (!e.target.closest(PART_OF_THE_BAR)) latest.current();
    };
    const onBlur = () => {
      if (document.activeElement?.tagName === "IFRAME") latest.current();
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("blur", onBlur);
    };
  }, [container, shown]);
}

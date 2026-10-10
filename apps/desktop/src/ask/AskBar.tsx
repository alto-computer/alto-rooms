import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { AskScope, AskTurn } from "@alto-rooms/protocol-ts";
import { scopeKey } from "@alto-rooms/protocol-ts";
import { useAsks, useAsksStore, useReadOnly } from "@/data/hooks";
import { frameSubject, type AskSubject, type SubjectFraming } from "./askSubjects";
import { Composer } from "./Composer";
import { AgentChip, ModelPicker, ReadScopeHint } from "./ModelPicker";
import { ThreadSheet } from "./ThreadSheet";
import { preloadAnswer } from "./Turn";
import { ErrorText } from "./ui";
import { useAskTarget } from "./useAskTarget";
import { useComposer } from "./useComposer";

/** Portaled out of the bar but still part of it: a click there doesn't fold the thread. */
const PART_OF_THE_BAR = "[data-slot=dropdown-menu-content], [data-slot=dialog-content], [data-slot=dialog-overlay], [data-selection-ask]";

/**
 * The ask bar at the bottom of a doc, room or Journal tab (⌘J): the subject's thread, and the input that
 * asks about it. The thread folds on Esc or a click elsewhere, and unfolds when the input is focused.
 */
export function AskBar({ subject }: { subject: AskSubject }) {
  const framing = frameSubject(subject);
  // The pending question, images and error belong to one scope; a new subject in the same tab starts fresh.
  return <ScopedAskBar key={scopeKey(framing.scope)} framing={framing} />;
}

function ScopedAskBar({ framing }: { framing: SubjectFraming }) {
  const store = useAsksStore();
  const { open, threads, live } = useAsks();
  const readOnly = useReadOnly();
  const shown = open && !readOnly;
  const { scope } = framing;
  const key = scopeKey(scope);
  const thread = threads[key];
  const turns = thread?.turns ?? [];
  const running = turns.find((t) => t.status === "running");
  const { target, model, pick, modelFor } = useAskTarget(scope, shown);
  const note = framing.note?.(target);
  const composer = useComposer(scope, model);
  const [unfolded, setUnfolded] = useState(true);
  const [dragging, setDragging] = useState(false);
  /** What the live region says once an answer ends. */
  const [announce, setAnnounce] = useState("");
  const container = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => store.hold(scope), [store, key]);
  // Fetch the Markdown renderer while the doc is read, so an answer never waits on it.
  useEffect(() => void preloadAnswer(), []);
  useLoadThread(scope, shown && !(thread?.loaded ?? false));
  useFocusRules({ open, shown, quoteCount: composer.quotes.length, runningId: running?.id, input, container, setUnfolded, setAnnounce });
  useFoldOnOutsideClick(container, shown, () => setUnfolded(false));

  // Stable for the memoized turns.
  const retryWith = useRef<(t: AskTurn) => void>(() => {});
  retryWith.current = (t: AskTurn) => composer.retry(t, modelFor(t));
  const retry = useCallback((t: AskTurn) => retryWith.current(t), []);
  // The scope alone decides where answers are saved, and the bar remounts when it changes.
  const noteTarget = useState(() => framing.noteTarget)[0];

  if (!shown) return null;
  const showThread = unfolded && (turns.length > 0 || !!thread?.error || !!composer.pending);
  return (
    <div
      ref={container}
      className="pointer-events-none absolute inset-x-4 bottom-4 flex flex-col items-center gap-3 px-4 pb-4"
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
          header={framing.header}
          noteTarget={noteTarget}
          live={live}
          loadError={!!thread?.error}
          pending={composer.pending}
          onRetry={retry}
          onCompact={() => composer.runCommand("compact")}
          onReload={() => void store.load(scope)}
          onQuote={(text) => store.addQuote(scope, text)}
        />
      ) : null}
      {/* For screen readers: when an answer starts and when it lands. */}
      <div aria-live="polite" className="sr-only">{running ? "Waiting for the answer" : announce}</div>
      {composer.error ? <div className="pointer-events-auto"><ErrorText>{composer.error}</ErrorText></div> : null}
      <Composer
        composer={composer}
        inputRef={input}
        placeholder={framing.placeholder}
        turns={turns}
        running={running}
        dragging={dragging}
        model={
          <>
            <ReadScopeHint text={framing.hint(target)} />
            {target ? <ModelPicker target={target} model={model} onChange={pick} /> : <AgentChip name={framing.agent} />}
          </>
        }
        onStop={() => running && store.cancel(running.id)}
        onFold={() => setUnfolded(false)}
        onFocus={() => setUnfolded(true)}
      />
      {note ? <p className="pointer-events-auto -mt-1.5 rounded-full bg-sheet/90 px-2 text-caption text-ink-3">{note}</p> : null}
    </div>
  );
}

/** Loads the thread when it's needed and not loaded (an ask event from another client creates it unloaded). */
function useLoadThread(scope: AskScope, needed: boolean) {
  const store = useAsksStore();
  const key = scopeKey(scope);
  const loading = useRef<string | null>(null);
  // The scope object is rebuilt on every render; its key says when it really changed.
  useEffect(() => {
    if (!needed || loading.current === key) return;
    loading.current = key;
    void store.load(scope).finally(() => {
      if (loading.current === key) loading.current = null;
    });
  }, [needed, store, key]);
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

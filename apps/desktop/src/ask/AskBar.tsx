import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { X } from "lucide-react";
import type { Artifact, AskScope, AskTurn } from "@alto-rooms/protocol-ts";
import { scopeKey } from "@alto-rooms/protocol-ts";
import { PeekGlyph } from "@/components/PeekGlyph";
import { useAsks, useAsksStore, useReadOnly } from "@/data/hooks";
import { cn } from "@/lib/utils";
import { Composer } from "./Composer";
import { AgentChip, ModelPicker } from "./ModelPicker";
import { ThreadSheet } from "./ThreadSheet";
import { preloadAnswer } from "./Turn";
import { ErrorText } from "./ui";
import { useAskTarget } from "./useAskTarget";
import { useComposer } from "./useComposer";

/**
 * The ask bar (⌘J): the input that asks the agent that made the artifact about it, floating over
 * the bottom of the page. Once there is a thread, it docks in a column beside the page instead,
 * answers above the input, so nothing covers the page. Esc or the close button folds the column
 * back to the bar; focusing the input docks it again.
 */
export function AskBar({ artifact }: { artifact: Artifact }) {
  const store = useAsksStore();
  const { open, threads, live } = useAsks();
  const readOnly = useReadOnly();
  const shown = open && !readOnly;
  const scope: AskScope = { kind: "doc", fileKey: artifact.fileKey };
  const key = scopeKey(scope);
  const thread = threads[key];
  const turns = thread?.turns ?? [];
  const running = turns.find((t) => t.status === "running");
  const { target, model, pick, modelFor } = useAskTarget(scope, shown);
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

  // Stable for the memoized turns.
  const retryWith = useRef<(t: AskTurn) => void>(() => {});
  retryWith.current = (t: AskTurn) => composer.retry(t, modelFor(t));
  const retry = useCallback((t: AskTurn) => retryWith.current(t), []);

  if (!shown) return null;
  const docked = unfolded && (turns.length > 0 || !!thread?.error || !!composer.pending);
  return (
    <div
      ref={container}
      data-ask-docked={docked || undefined}
      className={cn(
        "flex flex-col items-center gap-3",
        docked ? "relative min-h-0 w-[392px] shrink-0 pt-1 pr-2 pl-4" : "pointer-events-none absolute inset-x-4 bottom-4 px-4 pb-4",
      )}
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
      {docked ? (
        <div className="flex h-8 w-full items-center gap-2 text-small text-ink-3">
          <PeekGlyph size={16} className="text-ink" />
          <b className="text-body font-semibold text-ink">Ask</b>
          about this artifact
          <button
            type="button"
            aria-label="Close answers"
            onClick={() => setUnfolded(false)}
            className="ml-auto grid size-6 place-items-center rounded-md text-ink-3 outline-none hover:bg-row-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-ink"
          >
            <X size={14} aria-hidden />
          </button>
        </div>
      ) : null}
      {docked ? (
        <ThreadSheet
          turns={turns}
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

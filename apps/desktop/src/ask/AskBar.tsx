import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, Square } from "lucide-react";
import type { Artifact, AskTarget, AskTurn } from "@alto-rooms/protocol-ts";
import { RoomsApiError } from "@alto-rooms/protocol-ts";
import { useAsks, useAsksStore, useReadOnly } from "@/data/hooks";
import { GENERIC_ERROR } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { AnswerMarkdown } from "./AnswerMarkdown";
import { loadModel, modelLabel, saveModel } from "./askModel";
import { CopyAnswerButton } from "./CopyAnswerButton";
import { AgentChip, ModelPicker } from "./ModelPicker";
import { ThinkingLine } from "./ThinkingLine";
import { useStickToBottom } from "./useStickToBottom";

const PLACEHOLDER = "Ask about this doc…";

function seconds(t: AskTurn): number | null {
  if (!t.endedAt) return null;
  return Math.max(0, Math.round((Date.parse(t.endedAt) - Date.parse(t.startedAt)) / 1000));
}

function header(t: AskTurn): string {
  const how = t.mode === "resume" ? "continuing the thread that made it" : "new conversation — couldn't find the thread that made this doc";
  return [t.agent, t.model ? modelLabel(t.model) : null, how].filter(Boolean).join(" · ");
}

/** Where an ask from this doc goes (null until roomsd answers), and the model picked for that agent. */
function useAskTarget(artifact: Artifact, shown: boolean) {
  const store = useAsksStore();
  const { roomId, id } = artifact;
  const key = `${roomId}/${id}`;
  // Keyed by doc, so a newly shown doc never sends the previous doc's model.
  const [state, setState] = useState<{ key: string; target: AskTarget | null; model: string | null } | null>(null);
  useEffect(() => {
    if (!shown) return;
    let live = true;
    void store.target({ roomId, artifactId: id }).then((target) => {
      if (live) setState({ key: `${roomId}/${id}`, target, model: target ? loadModel(target.agent, target.models) : null });
    });
    return () => {
      live = false;
    };
  }, [shown, store, roomId, id]);
  const current = state?.key === key ? state : null;
  const target = current?.target ?? null;
  const pick = (model: string | null) => {
    if (!target) return;
    saveModel(target.agent, model);
    setState({ key, target, model });
  };
  return { target, model: current?.model ?? null, pick };
}

function Turn({ t, onRetry }: { t: AskTurn; onRetry: () => void }) {
  const secs = seconds(t);
  return (
    <div className="space-y-2">
      <div className="ml-auto w-fit max-w-[80%] rounded-[10px] bg-[#f2f2f2] px-3 py-1.5 whitespace-pre-wrap">{t.question}</div>
      {t.status === "running" ? (
        <div className="flex items-center gap-2 text-[12.5px] text-ink-2">
          <ThinkingLine startedAt={t.startedAt} />
        </div>
      ) : (
        <>
          {t.answer ? <AnswerMarkdown text={t.answer} /> : null}
          {t.status === "cancelled" ? <div className="text-[12.5px] text-ink-2">Stopped</div> : null}
          {t.status === "failed" ? (
            <div className="text-[12.5px] whitespace-pre-wrap text-ink-2">
              {t.error}{" "}
              <button type="button" className="underline" onClick={onRetry}>Retry</button>
            </div>
          ) : null}
          <div className="flex items-center gap-2 text-[11.5px] text-ink-2">
            {secs !== null ? <span>{secs}s</span> : null}
            {t.answer ? <CopyAnswerButton text={t.answer} /> : null}
          </div>
        </>
      )}
    </div>
  );
}

/** The round ask bar under a doc (⌘J), with this doc's thread above it. Hidden until toggled. */
export function AskBar({ artifact }: { artifact: Artifact }) {
  const store = useAsksStore();
  const { open, threads } = useAsks();
  const readOnly = useReadOnly();
  const thread = threads[artifact.fileKey];
  const [draft, setDraft] = useState("");
  const [sheet, setSheet] = useState(true);
  const [sendError, setSendError] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  /** Set synchronously on send, so a second Enter before the turn shows up does nothing. */
  const sending = useRef(false);
  const loading = useRef<string | null>(null);
  const shown = open && !readOnly;
  const loaded = thread?.loaded ?? false;
  const { target, model, pick } = useAskTarget(artifact, shown);

  // An ask event from another client creates the thread unloaded: its older turns still need loading.
  useEffect(() => {
    if (!shown || loaded || loading.current === artifact.fileKey) return;
    const key = artifact.fileKey;
    loading.current = key;
    void store.load(key).finally(() => {
      if (loading.current === key) loading.current = null;
    });
  }, [shown, loaded, store, artifact.fileKey]);
  // Focus only when the user opens the bar (`open` false → true), never on mount or when roomsd
  // info arrives (read-only is assumed until then): the bar starts open, and doc tabs must not grab focus.
  const wasOpen = useRef(open);
  useEffect(() => {
    if (open && !wasOpen.current && shown) input.current?.focus();
    wasOpen.current = open;
  }, [open, shown]);
  const turns = thread?.turns ?? [];
  const showSheet = shown && sheet && (turns.length > 0 || !!thread?.error);
  useStickToBottom(sheetRef, [showSheet, loaded, turns.length, turns.map((t) => t.status).join()]);
  const running = turns.find((t) => t.status === "running");
  const runningId = running?.id;
  const wasRunning = useRef(false);
  // When the running turn finishes, the input is writable again: put the caret back in it, but
  // only if focus is nowhere else (body) or already in the bar. Never take it from the doc iframe
  // or another input.
  useEffect(() => {
    if (wasRunning.current && !runningId && shown) {
      const active = document.activeElement;
      const idle = !active || active === document.body || !!container.current?.contains(active);
      if (idle) input.current?.focus();
    }
    wasRunning.current = !!runningId;
  }, [runningId, shown]);

  // Outside click folds the sheet like Esc. Clicks in the doc iframe never reach this document,
  // so a window blur with focus moved into an iframe counts as one too.
  useEffect(() => {
    if (!shown) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!(e.target instanceof Element) || container.current?.contains(e.target)) return;
      // The model menu is portaled out of the bar but still belongs to it.
      if (!e.target.closest("[data-slot=dropdown-menu-content]")) setSheet(false);
    };
    const onBlur = () => {
      if (document.activeElement?.tagName === "IFRAME") setSheet(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("blur", onBlur);
    };
  }, [shown]);

  if (!shown) return null;
  const last = turns.at(-1);

  /** A retry keeps its turn's model while the agent still offers it. */
  const retryModel = (t: AskTurn) => (t.model && target?.models.includes(t.model) ? t.model : model);
  const send = async (question: string, withModel: string | null = model) => {
    const q = question.trim();
    if (!q || running || sending.current) return;
    sending.current = true;
    setSendError(null);
    try {
      await store.ask({ roomId: artifact.roomId, artifactId: artifact.id }, q, withModel);
      if (q === draft.trim()) setDraft("");
      setSheet(true);
    } catch (e) {
      setSendError(e instanceof RoomsApiError ? e.message : GENERIC_ERROR);
    } finally {
      sending.current = false;
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (running) store.cancel(running.id);
      else setSheet(false);
    } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(draft);
    }
  };

  return (
    <div ref={container} className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center gap-3 px-4 pb-4">
      {showSheet ? (
        <div ref={sheetRef} className="pointer-events-auto max-h-[50vh] w-full max-w-[560px] overflow-y-auto rounded-[14px] border border-[#e3e3e3] bg-white px-4 py-3 text-[13.5px] shadow-[0_8px_30px_rgba(0,0,0,0.08)]">
          {last ? (
            <div className="mb-2 text-[11.5px] text-ink-2">{header(last)}</div>
          ) : null}
          {thread?.error ? (
            <div className="text-[12.5px] text-ink-2">
              Couldn't load the conversation{" "}
              <button type="button" className="underline" onClick={() => void store.load(artifact.fileKey)}>Try again</button>
            </div>
          ) : null}
          <div className="space-y-4">
            {turns.map((t) => (
              <Turn key={t.id} t={t} onRetry={() => void send(t.question, retryModel(t))} />
            ))}
          </div>
        </div>
      ) : null}
      {sendError ? <div className="pointer-events-auto text-[12.5px] text-ink-2">{sendError}</div> : null}
      <div className="pointer-events-auto flex w-full max-w-[560px] items-center gap-2.5 rounded-full border border-[#dcdcdc] bg-white py-2 pr-2 pl-4 shadow-[0_4px_18px_rgba(0,0,0,0.08)] transition-[border-color,box-shadow] duration-150 focus-within:border-primary/70 focus-within:ring-4 focus-within:ring-primary/10">
        <textarea
          ref={input}
          rows={1}
          value={draft}
          readOnly={!!running}
          placeholder={PLACEHOLDER}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => setSheet(true)}
          className="max-h-32 flex-1 resize-none overflow-y-auto bg-transparent [scrollbar-width:none] [&::-webkit-scrollbar]:hidden text-[13.5px] outline-none placeholder:text-[#9a9a9a]"
        />
        {target ? <ModelPicker target={target} model={model} onChange={pick} /> : <AgentChip name={artifact.source.agent ?? "Default agent"} />}
        <button
          type="button"
          aria-label={running ? "Stop" : "Send"}
          disabled={!running && !draft.trim()}
          onClick={() => (running ? store.cancel(running.id) : void send(draft))}
          className={cn("flex size-[30px] items-center justify-center rounded-full bg-primary text-primary-foreground", !running && !draft.trim() && "opacity-40")}
        >
          {running ? <Square className="size-3 fill-current" /> : <ArrowUp className="size-4" />}
        </button>
      </div>
    </div>
  );
}

import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowUp, CircleAlert, Square } from "lucide-react";
import type { Artifact, AskTarget, AskTurn } from "@alto-rooms/protocol-ts";
import { RoomsApiError } from "@alto-rooms/protocol-ts";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useAsks, useAsksStore, useReadOnly } from "@/data/hooks";
import { GENERIC_ERROR } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { loadModel, modelLabel, saveModel } from "./askModel";
import { CopyAnswerButton } from "./CopyAnswerButton";
import { AgentChip, ModelPicker } from "./ModelPicker";
import { ThinkingLine } from "./ThinkingLine";
import { useStickToBottom } from "./useStickToBottom";

/** The Markdown chain is heavy and only needed once an answer arrives. */
const loadAnswerMarkdown = () => import("./AnswerMarkdown");
const AnswerMarkdown = lazy(() => loadAnswerMarkdown().then((m) => ({ default: m.AnswerMarkdown })));

/** Plain answer text with the Markdown view's typography, so the swap doesn't jump. */
function AnswerFallback({ text }: { text: string }) {
  return <div className="text-[13.5px] leading-[1.55] whitespace-pre-wrap">{text}</div>;
}

const PLACEHOLDER = "Ask about this doc…";
/** The input grows with its text up to this height (about 5 lines), then scrolls. */
const INPUT_MAX_PX = 128;
/** Taller than this is more than one line (the input is `leading-5`, 20px a line). */
const ONE_LINE_PX = 28;

function header(t: AskTurn): { text: string; title?: string } {
  const how = t.mode === "resume" ? "continuing the thread that made it" : "New conversation";
  const text = [t.agent, t.model ? modelLabel(t.model) : null, how].filter(Boolean).join(" · ");
  return t.mode === "resume" ? { text } : { text, title: "Couldn't find the thread that made this doc" };
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

/** Error copy in the app's muted red, with an icon so it reads as an error at a glance. */
function ErrorText({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 text-[12.5px] text-[#c13515]">
      <CircleAlert size={14} aria-hidden className="mt-[2px] shrink-0" />
      <span className="whitespace-pre-wrap">{children}</span>
    </p>
  );
}

/** A small text button with a full 28px hit area, pulled left so its label lines up with the text above. */
const TEXT_BUTTON = "-ml-2 inline-flex min-h-7 items-center rounded-md px-2 text-[12.5px] font-medium text-ink hover:bg-[#f2f2f2] focus-visible:outline-2 focus-visible:outline-ink";

function Turn({ t, onRetry }: { t: AskTurn; onRetry: () => void }) {
  return (
    <div data-turn-id={t.id} className="space-y-2">
      <div className="ml-auto w-fit max-w-[80%] rounded-[10px] bg-[#f2f2f2] px-3 py-1.5 whitespace-pre-wrap">{t.question}</div>
      {t.status === "running" ? (
        <div className="flex items-center gap-2 text-[12.5px] text-ink-2">
          <ThinkingLine />
        </div>
      ) : (
        <>
          {t.answer ? (
            <Suspense fallback={<AnswerFallback text={t.answer} />}>
              <AnswerMarkdown text={t.answer} />
            </Suspense>
          ) : null}
          {t.status === "cancelled" ? <div className="text-[12.5px] text-ink-2">Stopped</div> : null}
          {t.status === "failed" ? (
            <div>
              <ErrorText>{t.error || GENERIC_ERROR}</ErrorText>
              <button type="button" className={TEXT_BUTTON} onClick={onRetry}>Retry</button>
            </div>
          ) : null}
          {t.answer ? (
            <div className="-my-1.5 flex items-center gap-2 text-[11.5px] text-ink-2">
              <CopyAnswerButton text={t.answer} />
            </div>
          ) : null}
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
  const [multiline, setMultiline] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  /** Set synchronously on send, so a second Enter before the turn shows up does nothing. */
  const sending = useRef(false);
  useEffect(() => store.hold(artifact.fileKey), [store, artifact.fileKey]);
  // Fetch the markdown renderer while the doc is read, so an answer never waits on it.
  useEffect(() => void loadAnswerMarkdown(), []);
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
  // Grow with the draft up to INPUT_MAX_PX, and shrink back once it's sent.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, INPUT_MAX_PX)}px`;
    setMultiline(el.scrollHeight > ONE_LINE_PX);
  }, [draft, shown]);
  const turns = thread?.turns ?? [];
  const showSheet = shown && sheet && (turns.length > 0 || !!thread?.error);
  const running = turns.find((t) => t.status === "running");
  const runningId = running?.id;
  /** The turn that was running as of the last commit; cleared by the effect below once it ends. */
  const wasRunning = useRef<string | undefined>(undefined);
  // While thinking, stick to the bottom. When the answer lands, put its question at the top of the
  // sheet instead, so a long answer reads from its start rather than its end.
  useStickToBottom(sheetRef, [showSheet, loaded, turns.length, turns.map((t) => t.status).join()], () => {
    const id = wasRunning.current;
    if (!id || turns.find((t) => t.id === id)?.status !== "done") return null;
    return Array.from(sheetRef.current?.querySelectorAll<HTMLElement>("[data-turn-id]") ?? []).find((el) => el.dataset.turnId === id) ?? null;
  });
  // When the running turn finishes, put the caret back in the input, but only if focus is nowhere
  // else (body) or already in the bar. Never take it from the doc iframe or another input.
  useEffect(() => {
    if (wasRunning.current && !runningId && shown) {
      const active = document.activeElement;
      const idle = !active || active === document.body || !!container.current?.contains(active);
      if (idle) input.current?.focus();
    }
    wasRunning.current = runningId;
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
  const head = last ? header(last) : null;

  /** A retry keeps its turn's model while the agent still offers it. */
  const retryModel = (t: AskTurn) => (t.model && target?.models.includes(t.model) ? t.model : model);
  const send = async (question: string, withModel: string | null = model) => {
    const q = question.trim();
    // Typing ahead is fine while an answer runs; sending waits for it.
    if (!q || running || sending.current) return;
    sending.current = true;
    setSendError(null);
    try {
      await store.ask({ roomId: artifact.roomId, artifactId: artifact.id }, q, withModel);
      // Only clear what was sent: the next question may have been typed in the meantime.
      setDraft((d) => (d.trim() === q ? "" : d));
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
          {head ? (
            <div className="mb-2 text-[11.5px] text-ink-2" title={head.title}>{head.text}</div>
          ) : null}
          {thread?.error ? (
            <div>
              <ErrorText>Couldn't load the conversation</ErrorText>
              <button type="button" className={TEXT_BUTTON} onClick={() => void store.load(artifact.fileKey)}>Try again</button>
            </div>
          ) : null}
          <div className="space-y-4">
            {turns.map((t) => (
              <Turn key={t.id} t={t} onRetry={() => void send(t.question, retryModel(t))} />
            ))}
          </div>
        </div>
      ) : null}
      {sendError ? <div className="pointer-events-auto"><ErrorText>{sendError}</ErrorText></div> : null}
      <div
        className={cn(
          "pointer-events-auto flex w-full max-w-[560px] gap-2.5 border border-[#dcdcdc] bg-white py-2 pr-2 pl-4 shadow-[0_4px_18px_rgba(0,0,0,0.08)] transition-[border-color,box-shadow] duration-150 focus-within:border-ink/60 focus-within:ring-4 focus-within:ring-ink/5",
          // A full pill only suits one line; taller, round the corners less and keep the buttons at the bottom.
          multiline ? "items-end rounded-[20px]" : "items-center rounded-full",
        )}
      >
        <textarea
          ref={input}
          rows={1}
          value={draft}
          placeholder={PLACEHOLDER}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => setSheet(true)}
          className="max-h-32 flex-1 resize-none overflow-y-auto bg-transparent [scrollbar-width:none] [&::-webkit-scrollbar]:hidden text-[13.5px] leading-5 outline-none placeholder:text-[#9a9a9a]"
        />
        {target ? <ModelPicker target={target} model={model} onChange={pick} /> : <AgentChip name={artifact.source.agent ?? "Default agent"} />}
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={running ? "Stop" : "Send"}
                disabled={!running && !draft.trim()}
                onClick={() => (running ? store.cancel(running.id) : void send(draft))}
                className={cn("flex size-[30px] shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground focus-visible:outline-2 focus-visible:outline-ink", !running && !draft.trim() && "opacity-40")}
              >
                {running ? <Square className="size-3 fill-current" /> : <ArrowUp className="size-4" />}
              </button>
            </TooltipTrigger>
            {/* Esc in the input stops it too, as in Claude Code: say so where the mouse goes. */}
            {running ? <TooltipContent side="top">Stop (Esc)</TooltipContent> : null}
          </Tooltip>
        </TooltipProvider>
      </div>
    </div>
  );
}

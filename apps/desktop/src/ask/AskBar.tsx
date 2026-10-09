import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowUp, CircleAlert, ImagePlus, Quote, Square, X } from "lucide-react";
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
import { withQuotes, type Live } from "./asksStore";
import { SelectionAsk, type SelectionRect } from "./SelectionAsk";
import { AttachmentStrip, IMAGE_TYPES, TurnImages, useAttachments } from "./attachments";

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

/** Leading `> ` blocks of a question are the quotes it was asked about. */
export function splitQuotes(question: string): { quotes: string[]; text: string } {
  const parts = question.split("\n\n");
  const quotes: string[] = [];
  while (parts.length > 1 && parts[0].split("\n").every((l) => l.startsWith(">"))) {
    quotes.push(parts.shift()!.split("\n").map((l) => l.replace(/^> ?/, "")).join("\n"));
  }
  return { quotes, text: parts.join("\n\n") };
}

/** The question on the right; quoted text above it, muted and cut to three lines. */
function QuestionBubble({ text }: { text: string }) {
  const { quotes, text: asked } = splitQuotes(text);
  return (
    <div className="ml-auto w-fit max-w-[80%] rounded-[10px] bg-[#f2f2f2] px-3 py-1.5">
      {quotes.map((q, i) => (
        <div key={i} className="mb-1 line-clamp-3 border-l-2 border-[#d0d0d0] pl-2 text-[12.5px] whitespace-pre-wrap text-ink-2">{q}</div>
      ))}
      <div className="whitespace-pre-wrap">{asked}</div>
    </div>
  );
}

/** Quotes waiting for the next question, as in Claude: a quote mark, the start of the text, × to drop it. */
function QuoteChips({ quotes, onRemove }: { quotes: string[]; onRemove: (i: number) => void }) {
  if (quotes.length === 0) return null;
  return (
    <ul aria-label="Quoted text" className="flex flex-wrap gap-2 pt-1">
      {quotes.map((q, i) => (
        <li key={i} title={q} className="flex h-9 max-w-[260px] items-center gap-2 rounded-lg border border-[#e3e3e3] bg-[#fafafa] pr-1 pl-2.5 text-[12.5px]">
          <Quote className="size-3.5 shrink-0 fill-current text-ink-2" aria-hidden />
          <span className="min-w-0 truncate">{q.replace(/\s+/g, " ")}</span>
          <button type="button" aria-label="Remove quote" onClick={() => onRemove(i)} className="flex size-6 shrink-0 items-center justify-center rounded-md text-ink-2 hover:bg-[#ededed] hover:text-ink focus-visible:outline-2 focus-visible:outline-ink">
            <X className="size-3" />
          </button>
        </li>
      ))}
    </ul>
  );
}

function Turn({ t, live, onRetry }: { t: AskTurn; live?: Live; onRetry: () => void }) {
  return (
    <div data-turn-id={t.id} className="space-y-2">
      <TurnImages ids={t.images ?? []} />
      <QuestionBubble text={t.question} />
      {t.status === "running" ? (
        <>
          {/* The answer so far, as the agent streams it; the line under it says what it's doing. */}
          {live?.answer ? (
            <Suspense fallback={<AnswerFallback text={live.answer} />}>
              <AnswerMarkdown text={live.answer} />
            </Suspense>
          ) : null}
          <div className="flex min-w-0 items-center gap-2 text-[12.5px] text-ink-2">
            <ThinkingLine label={live?.activity ?? undefined} />
          </div>
        </>
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
  const { open, threads, live, quotes: allQuotes } = useAsks();
  const readOnly = useReadOnly();
  const thread = threads[artifact.fileKey];
  const [draft, setDraft] = useState("");
  const [sheet, setSheet] = useState(true);
  const [sendError, setSendError] = useState<string | null>(null);
  const [multiline, setMultiline] = useState(false);
  const [dragging, setDragging] = useState(false);
  const attachments = useAttachments((m) => setSendError(m));
  const filePicker = useRef<HTMLInputElement>(null);
  const quotes = allQuotes[artifact.fileKey] ?? [];
  /** Text selected in an answer, with where it is in the bar's box. */
  const [picked, setPicked] = useState<{ text: string; rect: SelectionRect } | null>(null);
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
  // A new quote (from the doc or an answer) puts the caret in the input, ready for the question.
  const quoteCount = useRef(quotes.length);
  useEffect(() => {
    if (quotes.length > quoteCount.current && shown) {
      setSheet(true);
      input.current?.focus();
    }
    quoteCount.current = quotes.length;
  }, [quotes.length, shown]);
  // Selecting text in an answer offers "Ask" over it; any other selection change hides it.
  useEffect(() => {
    if (!shown) return;
    const onSelection = () => {
      const s = document.getSelection();
      const sheetEl = sheetRef.current;
      const box = container.current?.getBoundingClientRect();
      if (!s || s.isCollapsed || !sheetEl || !box || !s.anchorNode || !sheetEl.contains(s.anchorNode) || !sheetEl.contains(s.focusNode)) {
        setPicked(null);
        return;
      }
      const text = s.toString().trim();
      if (!text) return setPicked(null);
      const r = s.getRangeAt(0).getBoundingClientRect();
      setPicked({ text, rect: { x: r.left - box.left, y: r.top - box.top, w: r.width, h: r.height } });
    };
    // On release, not while dragging: the button shouldn't chase the pointer.
    const onUp = () => setTimeout(onSelection, 0);
    const onChange = () => {
      if (document.getSelection()?.isCollapsed) setPicked(null);
    };
    document.addEventListener("mouseup", onUp);
    document.addEventListener("keyup", onUp);
    document.addEventListener("selectionchange", onChange);
    return () => {
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("keyup", onUp);
      document.removeEventListener("selectionchange", onChange);
    };
  }, [shown]);
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
  const streaming = runningId ? live[runningId] : undefined;
  /** Turns whose answer streamed in: the reader already followed it, so it isn't jumped back to its start. */
  const streamed = useRef(new Set<string>());
  if (runningId && streaming?.answer) streamed.current.add(runningId);
  // While thinking or streaming, stick to the bottom. When a whole answer lands at once, put its
  // question at the top of the sheet instead, so a long answer reads from its start rather than its end.
  useStickToBottom(sheetRef, [showSheet, loaded, turns.length, turns.map((t) => t.status).join(), streaming?.answer.length, streaming?.activity], () => {
    const id = wasRunning.current;
    if (!id || streamed.current.has(id) || turns.find((t) => t.id === id)?.status !== "done") return null;
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
      // The model menu and the image viewer are portaled out of the bar but still belong to it.
      if (!e.target.closest("[data-slot=dropdown-menu-content], [data-slot=dialog-content], [data-slot=dialog-overlay], [data-selection-ask]")) setSheet(false);
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
  /** The draft's images, ready to go: null while one is still uploading or one failed. */
  const readyImages = () => (attachments.uploading || attachments.failed ? null : attachments.items);
  const send = async (question: string, withModel: string | null = model, images: string[] | null = null) => {
    const q = question.trim();
    // Typing ahead is fine while an answer runs; sending waits for it.
    if (!q || running || sending.current) return;
    const picked = images ? null : readyImages();
    if (!images && !picked) {
      setSendError(attachments.failed ? "Remove the images that couldn't be attached" : "Wait for the images to finish uploading");
      return;
    }
    sending.current = true;
    setSendError(null);
    // A retry resends its question as it was; a new one carries the quotes waiting above the input.
    const quoted = images ? [] : quotes;
    try {
      await store.ask({ roomId: artifact.roomId, artifactId: artifact.id }, withQuotes(quoted, q), withModel, images ?? picked!.map((a) => a.id!));
      // Only clear what was sent: the next question may have been typed in the meantime.
      setDraft((d) => (d.trim() === q ? "" : d));
      if (picked) attachments.clear(picked.map((a) => a.key));
      if (quoted.length) store.clearQuotes(artifact.fileKey, quoted);
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
        if (attachments.add(e.dataTransfer.files)) input.current?.focus();
      }}
    >
      {showSheet ? (
        <div ref={sheetRef} className="pointer-events-auto max-h-[50vh] w-full max-w-[720px] overflow-y-auto rounded-[14px] border border-[#e3e3e3] bg-white px-4 py-3 text-[13.5px] shadow-[0_8px_30px_rgba(0,0,0,0.08)]">
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
              <Turn key={t.id} t={t} live={live[t.id]} onRetry={() => void send(t.question, retryModel(t), t.images ?? [])} />
            ))}
          </div>
        </div>
      ) : null}
      {picked ? (
        <SelectionAsk
          rect={picked.rect}
          onAsk={() => {
            store.addQuote(artifact.fileKey, picked.text);
            document.getSelection()?.removeAllRanges();
            setPicked(null);
          }}
        />
      ) : null}
      {sendError ? <div className="pointer-events-auto"><ErrorText>{sendError}</ErrorText></div> : null}
      <div
        className={cn(
          "pointer-events-auto flex w-full max-w-[720px] flex-col border border-[#dcdcdc] bg-white py-2 pr-2 pl-4 shadow-[0_4px_18px_rgba(0,0,0,0.08)] transition-[border-color,box-shadow] duration-150 focus-within:border-ink/60 focus-within:ring-4 focus-within:ring-ink/5",
          // A full pill only suits one line; taller, round the corners less and keep the buttons at the bottom.
          multiline || attachments.items.length > 0 || quotes.length > 0 ? "rounded-[20px]" : "rounded-full",
          dragging && "border-ink/60 ring-4 ring-ink/10",
        )}
      >
        <QuoteChips quotes={quotes} onRemove={(i) => store.removeQuote(artifact.fileKey, i)} />
        <AttachmentStrip items={attachments.items} onRemove={attachments.remove} />
        <div className={cn("flex gap-2.5", multiline ? "items-end" : "items-center")}>
        <textarea
          ref={input}
          rows={1}
          value={draft}
          placeholder={PLACEHOLDER}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => setSheet(true)}
          onPaste={(e) => {
            if (attachments.add(e.clipboardData.files)) e.preventDefault();
          }}
          className="max-h-32 flex-1 resize-none overflow-y-auto bg-transparent [scrollbar-width:none] [&::-webkit-scrollbar]:hidden text-[13.5px] leading-5 outline-none placeholder:text-[#9a9a9a]"
        />
        <input
          ref={filePicker}
          type="file"
          accept={IMAGE_TYPES.join(",")}
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) attachments.add(e.target.files);
            e.target.value = "";
            input.current?.focus();
          }}
        />
        <button
          type="button"
          aria-label="Attach images"
          onClick={() => filePicker.current?.click()}
          className="flex size-7 shrink-0 items-center justify-center rounded-full text-ink-2 hover:bg-[#f2f2f2] hover:text-ink focus-visible:outline-2 focus-visible:outline-ink"
        >
          <ImagePlus className="size-4" />
        </button>
        {target ? <ModelPicker target={target} model={model} onChange={pick} /> : <AgentChip name={artifact.source.agent ?? "Default agent"} />}
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={running ? "Stop" : "Send"}
                disabled={!running && (!draft.trim() || attachments.uploading)}
                onClick={() => (running ? store.cancel(running.id) : void send(draft))}
                className={cn("flex size-[30px] shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground focus-visible:outline-2 focus-visible:outline-ink", !running && (!draft.trim() || attachments.uploading) && "opacity-40")}
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
    </div>
  );
}

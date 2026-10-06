import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import Markdown, { type Components } from "react-markdown";
import { ArrowUp } from "lucide-react";
import type { Artifact, AskTurn } from "@alto-rooms/protocol-ts";
import { RoomsApiError } from "@alto-rooms/protocol-ts";
import { useAsks, useAsksStore, useReadOnly } from "@/data/hooks";
import { GENERIC_ERROR } from "@/lib/errors";
import { cn } from "@/lib/utils";

const PLACEHOLDER = "이 문서에 대해 묻기…";

/** Agent output may echo untrusted content: never render a link or an image, only their text. */
const MARKDOWN_COMPONENTS: Components = {
  a: ({ href, children }) => (
    <>
      {children}
      {href && /^https?:\/\//i.test(href) ? <span className="text-ink-2"> ({href})</span> : null}
    </>
  ),
  img: ({ alt }) => <>{alt ?? ""}</>,
};

function seconds(t: AskTurn): number | null {
  if (!t.endedAt) return null;
  return Math.max(0, Math.round((Date.parse(t.endedAt) - Date.parse(t.startedAt)) / 1000));
}

/** Seconds since `startedAt`, ticking every second while mounted. */
function useElapsed(startedAt: string): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);
  return Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
}

/** Codex-style waiting line: a shimmer sweeping over the text, then the elapsed seconds. */
function Thinking({ t }: { t: AskTurn }) {
  const secs = useElapsed(t.startedAt);
  return (
    <>
      <span className="animate-shimmer bg-linear-to-r from-ink-2 via-[#c9c9c9] to-ink-2 bg-[length:200%_100%] bg-clip-text text-transparent motion-reduce:animate-none motion-reduce:text-ink-2">
        생각하는 중
      </span>
      <span className="text-ink-3">({secs}초)</span>
    </>
  );
}

function Turn({ t, onRetry, onStop }: { t: AskTurn; onRetry: () => void; onStop: () => void }) {
  const secs = seconds(t);
  return (
    <div className="space-y-2">
      <div className="ml-auto w-fit max-w-[80%] rounded-[10px] bg-[#f2f2f2] px-3 py-1.5 whitespace-pre-wrap">{t.question}</div>
      {t.status === "running" ? (
        <div className="flex items-center gap-2 text-[12.5px] text-ink-2">
          <Thinking t={t} />
          <button type="button" className="ml-auto underline" onClick={onStop}>멈추기</button>
        </div>
      ) : (
        <>
          {t.answer ? (
            <div className="text-[13.5px] leading-[1.55] [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1 [&_pre]:overflow-x-auto [&_ul]:list-disc [&_ul]:pl-5">
              <Markdown components={MARKDOWN_COMPONENTS}>{t.answer}</Markdown>
            </div>
          ) : null}
          {t.status === "cancelled" ? <div className="text-[12.5px] text-ink-2">멈췄어요</div> : null}
          {t.status === "failed" ? (
            <div className="text-[12.5px] whitespace-pre-wrap text-ink-2">
              {t.error}{" "}
              <button type="button" className="underline" onClick={onRetry}>다시 묻기</button>
            </div>
          ) : null}
          <div className="flex gap-2 text-[11.5px] text-ink-2">
            {secs !== null ? <span>{secs}초</span> : null}
            {t.answer ? (
              <button type="button" className="underline" onClick={() => void navigator.clipboard?.writeText(t.answer)}>복사</button>
            ) : null}
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
  const bottom = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  /** Set synchronously on send, so a second Enter before the turn shows up does nothing. */
  const sending = useRef(false);
  const loading = useRef<string | null>(null);
  const shown = open && !readOnly;
  const loaded = thread?.loaded ?? false;

  // An ask event from another client creates the thread unloaded: its older turns still need loading.
  useEffect(() => {
    if (!shown || loaded || loading.current === artifact.fileKey) return;
    const key = artifact.fileKey;
    loading.current = key;
    void store.load(key).finally(() => {
      if (loading.current === key) loading.current = null;
    });
  }, [shown, loaded, store, artifact.fileKey]);
  useEffect(() => {
    if (shown) input.current?.focus();
  }, [shown]);
  const turns = thread?.turns ?? [];
  useEffect(() => {
    bottom.current?.scrollIntoView?.({ block: "end" });
  }, [turns.length, turns.at(-1)?.status]);
  const running = turns.find((t) => t.status === "running");
  const runningId = running?.id;
  const wasRunning = useRef(false);
  // When the running turn finishes, the input is writable again: put the caret back in it.
  useEffect(() => {
    if (wasRunning.current && !runningId && shown) input.current?.focus();
    wasRunning.current = !!runningId;
  }, [runningId, shown]);

  // Outside click folds the sheet like Esc. Clicks in the doc iframe never reach this document,
  // so a window blur with focus moved into an iframe counts as one too.
  useEffect(() => {
    if (!shown) return;
    const onPointerDown = (e: PointerEvent) => {
      if (container.current && e.target instanceof Node && !container.current.contains(e.target)) setSheet(false);
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

  const send = async (question: string) => {
    const q = question.trim();
    if (!q || running || sending.current) return;
    sending.current = true;
    setSendError(null);
    try {
      await store.ask({ roomId: artifact.roomId, artifactId: artifact.id }, q);
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
      setSheet(false);
    } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(draft);
    }
  };

  const showSheet = sheet && (turns.length > 0 || thread?.error);
  return (
    <div ref={container} className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center gap-3 px-4 pb-4">
      {showSheet ? (
        <div className="pointer-events-auto max-h-[50vh] w-full max-w-[560px] overflow-y-auto rounded-[14px] border border-[#e3e3e3] bg-white px-4 py-3 text-[13.5px] shadow-[0_8px_30px_rgba(0,0,0,0.08)]">
          {last ? (
            <div className="mb-2 text-[11.5px] text-ink-2">
              {last.agent} · {last.mode === "resume" ? "만든 대화에 이어서" : "새 대화"}
            </div>
          ) : null}
          {thread?.error ? (
            <div className="text-[12.5px] text-ink-2">
              대화를 불러오지 못했어요{" "}
              <button type="button" className="underline" onClick={() => void store.load(artifact.fileKey)}>다시 시도</button>
            </div>
          ) : null}
          <div className="space-y-4">
            {turns.map((t) => (
              <Turn key={t.id} t={t} onRetry={() => void send(t.question)} onStop={() => store.cancel(t.id)} />
            ))}
          </div>
          <div ref={bottom} />
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
          className="max-h-32 flex-1 resize-none bg-transparent text-[13.5px] outline-none placeholder:text-[#9a9a9a]"
        />
        <span className="rounded-full bg-[#f2f2f2] px-2 py-0.5 text-[11.5px] text-ink-2">{artifact.source.agent ?? "기본 에이전트"}</span>
        <button
          type="button"
          aria-label="보내기"
          disabled={!!running || !draft.trim()}
          onClick={() => void send(draft)}
          className={cn("flex size-[30px] items-center justify-center rounded-full bg-primary text-primary-foreground", (running || !draft.trim()) && "opacity-40")}
        >
          <ArrowUp className="size-4" />
        </button>
      </div>
    </div>
  );
}

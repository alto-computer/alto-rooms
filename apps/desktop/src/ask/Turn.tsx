import { lazy, memo, Suspense, useState } from "react";
import type { AskScope, AskTurn } from "@alto-rooms/protocol-ts";
import { GENERIC_ERROR } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { TextSurface } from "@/surfaces/TextSurface";
import type { Live } from "./asksStore";
import type { NoteTargetOf } from "./askSubjects";
import { TurnImages } from "./attachments";
import { CopyAnswerButton } from "./CopyAnswerButton";
import { splitQuotes } from "./quotes";
import { SaveAsNote } from "./SaveAsNote";
import { ThinkingLine } from "./ThinkingLine";
import { ErrorText, TextButton } from "./ui";
import type { Pending } from "./useComposer";

/** The Markdown chain is heavy and only needed once an answer arrives; call this to fetch it early. */
export const preloadAnswer = () => import("./AnswerMarkdown");
const AnswerMarkdown = lazy(() => preloadAnswer().then((m) => ({ default: m.AnswerMarkdown })));

/** An answer as Markdown. Until the renderer loads, plain text in the same typography, so the swap doesn't jump. */
function Answer({ text }: { text: string }) {
  return (
    <Suspense fallback={<div data-answer-pending className="text-body leading-[1.55] whitespace-pre-wrap">{text}</div>}>
      <AnswerMarkdown text={text} />
    </Suspense>
  );
}

/** The question on the right; quoted text above it, muted and cut to three lines. */
function QuestionBubble({ text }: { text: string }) {
  const { quotes, text: asked } = splitQuotes(text);
  return (
    <div className="ml-auto w-fit max-w-[80%] rounded-xl bg-surface px-3 py-1.5">
      {quotes.map((q, i) => (
        <div key={i} className="mb-1 line-clamp-3 border-l-2 border-hairline-strong pl-2 text-small whitespace-pre-wrap text-ink-2">{q}</div>
      ))}
      <div className="whitespace-pre-wrap">{asked}</div>
    </div>
  );
}

function Waiting({ label }: { label?: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-small text-ink-2">
      <ThinkingLine label={label} />
    </div>
  );
}

function Failure({ t, onRetry }: { t: AskTurn; onRetry: (t: AskTurn) => void }) {
  return (
    <div>
      <ErrorText>{t.error || GENERIC_ERROR}</ErrorText>
      <TextButton onClick={() => onRetry(t)}>Retry</TextButton>
    </div>
  );
}

/** A thin rule with a label in the middle, between turns. */
function Divider({ children }: { children: string }) {
  return (
    <div role="separator" aria-label={children} className="flex items-center gap-3 text-small text-ink-2 before:h-px before:flex-1 before:bg-hairline after:h-px after:flex-1 after:bg-hairline">
      {children}
    </div>
  );
}

/**
 * A question and its answer: streaming in with what the agent is doing, then whole, stopped, or
 * failed with Retry. A finished answer is a host text surface plugins can read and mark.
 */
function QuestionTurn({ t, scope, live, noteTarget, onRetry }: { t: AskTurn; scope: AskScope; live?: Live; noteTarget: NoteTargetOf | null; onRetry: (t: AskTurn) => void }) {
  const running = t.status === "running";
  const answer = running ? live?.answer : t.answer;
  return (
    <>
      <TurnImages ids={t.images ?? []} />
      <QuestionBubble text={t.question} />
      {answer && t.status === "done" ? (
        <TextSurface id={{ kind: "answer", scope, turnId: t.id }}>
          <Answer text={answer} />
        </TextSurface>
      ) : answer ? (
        <Answer text={answer} />
      ) : null}
      {running ? <Waiting label={live?.activity ?? undefined} /> : null}
      {t.status === "cancelled" ? <div className="text-small text-ink-2">Stopped</div> : null}
      {t.status === "failed" ? <Failure t={t} onRetry={onRetry} /> : null}
      {!running && t.answer ? (
        <div className="-my-1.5 flex flex-wrap items-center gap-x-1 text-small text-ink-2">
          <CopyAnswerButton text={t.answer} />
          {t.status === "done" && noteTarget ? <SaveAsNote question={t.question} answer={t.answer} target={noteTarget} /> : null}
        </div>
      ) : null}
    </>
  );
}

/** `/compact`: what the agent is doing while it writes the summary, then a divider with the summary a click away. */
function CompactTurn({ t, live, onRetry }: { t: AskTurn; live?: Live; onRetry: (t: AskTurn) => void }) {
  const [open, setOpen] = useState(false);
  if (t.status === "running") return <Waiting label={live?.activity ?? "Summarizing the conversation"} />;
  if (t.status === "cancelled") return <div className="text-small text-ink-2">Stopped summarizing</div>;
  if (t.status === "failed") return <Failure t={t} onRetry={onRetry} />;
  return (
    <>
      <Divider>Conversation summarized</Divider>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="-ml-2 inline-flex min-h-7 items-center rounded-md px-2 text-small text-ink-2 hover:bg-surface hover:text-ink focus-visible:outline-2 focus-visible:outline-ink"
      >
        {open ? "Hide summary" : "Show summary"}
      </button>
      {open ? <div className="rounded-lg bg-surface px-3 py-2"><Answer text={t.answer} /></div> : null}
    </>
  );
}

/**
 * One turn of a thread: a question, a `/compact`, or a `/new` (a divider: nothing above it is
 * sent along anymore). Memoized: progress re-renders the thread ten times a second, and only the
 * running turn changes. An `old` turn skips layout and paint while off screen.
 */
export const Turn = memo(function Turn({ t, scope, live, old, noteTarget, onRetry }: {
  t: AskTurn;
  /** The thread's scope. Keep it stable: a new object re-renders every turn. */
  scope: AskScope;
  live?: Live;
  old: boolean;
  noteTarget: NoteTargetOf | null;
  onRetry: (t: AskTurn) => void;
}) {
  const kind = t.kind ?? "question";
  return (
    <div data-turn-id={t.id} className={cn("space-y-2", old && "[contain-intrinsic-size:auto_160px] [content-visibility:auto]")}>
      {kind === "clear" ? <Divider>New conversation</Divider> : null}
      {kind === "compact" ? <CompactTurn t={t} live={live} onRetry={onRetry} /> : null}
      {kind === "question" ? <QuestionTurn t={t} scope={scope} live={live} noteTarget={noteTarget} onRetry={onRetry} /> : null}
    </div>
  );
});

/** A question roomsd hasn't answered for yet, shown the moment it's sent. */
export function PendingTurn({ pending }: { pending: Pending }) {
  return (
    <div className="space-y-2" data-pending>
      <TurnImages ids={pending.images} />
      <QuestionBubble text={pending.question} />
      <Waiting />
    </div>
  );
}

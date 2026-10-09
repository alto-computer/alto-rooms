import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { ArrowUp, CornerDownRight, ImagePlus, Pencil, Quote, Send, Square, X } from "lucide-react";
import type { AskTurn } from "@alto-rooms/protocol-ts";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Queued } from "./asksStore";
import { AttachmentStrip, IMAGE_TYPES } from "./attachments";
import { matchCommands, type Command } from "./commands";
import { splitQuotes } from "./quotes";
import { ICON_BUTTON } from "./ui";
import type { ComposerState } from "./useComposer";

/** The input grows with its text up to this height (about 5 lines), then scrolls. */
const INPUT_MAX_PX = 128;
/** Taller than this is more than one line (the input is `leading-5`, 20px a line). */
const ONE_LINE_PX = 28;

/** The commands while a slash word is typed; ↑↓ pick, Enter or Tab runs, a click runs. */
function SlashMenu({ items, active, onPick, onHover }: { items: Command[]; active: number; onPick: (c: Command) => void; onHover: (i: number) => void }) {
  if (items.length === 0) return null;
  return (
    <ul role="listbox" aria-label="Commands" className="pt-1 pb-1.5">
      {items.map((c, i) => (
        <li
          key={c.name}
          role="option"
          aria-selected={i === active}
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => onHover(i)}
          onClick={() => onPick(c)}
          className={cn("-ml-2 flex cursor-default items-baseline gap-3 rounded-md px-2 py-1 text-[12.5px]", i === active && "bg-[#f2f2f2]")}
        >
          <span className="w-[72px] shrink-0 font-mono text-ink">/{c.name}</span>
          <span className="truncate text-ink-2">{c.hint}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Questions waiting behind the running answer, as in Codex: each goes out when the answer before
 * it ends. Edit takes one back into the input; Send now stops the answer and sends it.
 */
function QueueList({ items, running, onEdit, onSendNow, onRemove }: {
  items: Queued[];
  running: boolean;
  onEdit: (q: Queued) => void;
  onSendNow: (q: Queued) => void;
  onRemove: (q: Queued) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="pt-1 pb-1.5">
      <div className="mb-1 text-[11.5px] text-ink-2">{running ? "Sends after this answer" : "Queued"}</div>
      <ul aria-label="Queued questions" className="space-y-1">
        {items.map((q) => (
          <li key={q.id} className="flex items-start gap-1.5 text-[12.5px]">
            <CornerDownRight className="mt-[3px] size-3.5 shrink-0 text-ink-3" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="line-clamp-2 whitespace-pre-wrap">{splitQuotes(q.text).text}</div>
              {q.images.length ? <div className="text-[11.5px] text-ink-2">{q.images.length === 1 ? "1 image" : `${q.images.length} images`}</div> : null}
              {q.error ? <div className="text-[11.5px] text-[#c13515]">{q.error}</div> : null}
            </div>
            <button type="button" aria-label="Edit queued question" onClick={() => onEdit(q)} className={ICON_BUTTON}><Pencil className="size-3" /></button>
            <button type="button" aria-label="Send now" onClick={() => onSendNow(q)} className={ICON_BUTTON}><Send className="size-3" /></button>
            <button type="button" aria-label="Remove queued question" onClick={() => onRemove(q)} className={ICON_BUTTON}><X className="size-3" /></button>
          </li>
        ))}
      </ul>
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
          <button type="button" aria-label="Remove quote" onClick={() => onRemove(i)} className={ICON_BUTTON}>
            <X className="size-3" />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Send; while an answer runs, Stop, or Queue once something is typed. */
function SendButton({ running, hasDraft, busy, onSend, onStop }: { running: boolean; hasDraft: boolean; busy: boolean; onSend: () => void; onStop: () => void }) {
  const stopping = running && !hasDraft;
  const disabled = !stopping && (!hasDraft || busy);
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={stopping ? "Stop" : running ? "Queue" : "Send"}
            disabled={disabled}
            onClick={stopping ? onStop : onSend}
            className={cn("flex size-[30px] shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground focus-visible:outline-2 focus-visible:outline-ink", disabled && "opacity-40")}
          >
            {stopping ? <Square className="size-3 fill-current" /> : <ArrowUp className="size-4" />}
          </button>
        </TooltipTrigger>
        {/* Esc in the input stops it too, as in Claude Code: say so where the mouse goes. */}
        {stopping ? <TooltipContent side="top">Stop (Esc)</TooltipContent> : null}
        {running && !stopping ? <TooltipContent side="top">Queue (Enter) · Send now (⌘Enter)</TooltipContent> : null}
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * The round input at the bottom of a tab, with what goes out with the next question above the text: the
 * slash menu, queued questions, quotes and images.
 *
 * Keys, as in Claude Code and Codex: Enter sends (queues while an answer runs), ⌘Enter stops the
 * answer and sends now, Tab queues, Esc stops the answer (or folds the thread), ↑ in an empty
 * input recalls the last queued or asked question.
 */
export function Composer({ composer: c, inputRef, placeholder, turns, running, dragging, model, onStop, onFold, onFocus }: {
  composer: ComposerState;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  placeholder: string;
  turns: AskTurn[];
  running: AskTurn | undefined;
  dragging: boolean;
  /** The agent and model picker. */
  model: ReactNode;
  onStop: () => void;
  onFold: () => void;
  onFocus: () => void;
}) {
  const filePicker = useRef<HTMLInputElement>(null);
  const [multiline, setMultiline] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  const commands = matchCommands(c.draft);
  const active = Math.min(menuIndex, Math.max(0, commands.length - 1));
  const pick = (cmd: Command) => {
    setMenuIndex(0);
    c.runCommand(cmd.kind);
  };

  // Grow with the draft up to INPUT_MAX_PX, and shrink back once it's sent.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, INPUT_MAX_PX)}px`;
    setMultiline(el.scrollHeight > ONE_LINE_PX);
  }, [c.draft, inputRef]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (commands.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setMenuIndex((active + (e.key === "ArrowDown" ? 1 : commands.length - 1)) % commands.length);
      } else if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        e.preventDefault();
        pick(commands[active]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        c.setDraft("");
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (running) onStop();
      else onFold();
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void c.submit((e.metaKey || e.ctrlKey) && !!running);
    } else if (e.key === "Tab" && !e.shiftKey && running && c.draft.trim()) {
      e.preventDefault();
      void c.submit();
    } else if (e.key === "ArrowUp" && !c.draft && c.recall(turns)) {
      e.preventDefault();
    }
  };

  const tall = multiline || c.attachments.items.length > 0 || c.quotes.length > 0 || c.queue.length > 0 || commands.length > 0;
  return (
    <div
      className={cn(
        "pointer-events-auto flex w-full max-w-[720px] flex-col border border-[#dcdcdc] bg-white py-2 pr-2 pl-4 shadow-[0_4px_18px_rgba(0,0,0,0.08)] transition-[border-color,box-shadow] duration-150 focus-within:border-ink/60 focus-within:ring-4 focus-within:ring-ink/5",
        // A full pill only suits one line; taller, round the corners less and keep the buttons at the bottom.
        tall ? "rounded-[20px]" : "rounded-full",
        dragging && "border-ink/60 ring-4 ring-ink/10",
      )}
    >
      <SlashMenu items={commands} active={active} onPick={pick} onHover={setMenuIndex} />
      <QueueList
        items={c.queue}
        running={!!running}
        onEdit={(q) => {
          c.edit(q);
          inputRef.current?.focus();
        }}
        onSendNow={c.sendNow}
        onRemove={c.unqueue}
      />
      <QuoteChips quotes={c.quotes} onRemove={c.removeQuote} />
      <AttachmentStrip items={c.attachments.items} onRemove={c.attachments.remove} />
      <div className={cn("flex gap-2.5", multiline ? "items-end" : "items-center")}>
        <textarea
          ref={inputRef}
          rows={1}
          value={c.draft}
          placeholder={placeholder}
          onChange={(e) => c.setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={onFocus}
          onPaste={(e) => {
            if (c.attachments.add(e.clipboardData.files)) e.preventDefault();
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
            if (e.target.files) c.attachments.add(e.target.files);
            e.target.value = "";
            inputRef.current?.focus();
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
        {model}
        <SendButton running={!!running} hasDraft={!!c.draft.trim()} busy={c.attachments.uploading} onSend={() => void c.submit()} onStop={onStop} />
      </div>
    </div>
  );
}

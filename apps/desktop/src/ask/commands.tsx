import { useState } from "react";
import type { AskKind, AskTurn } from "@alto-rooms/protocol-ts";
import { cn } from "@/lib/utils";
import { ThinkingLine } from "./ThinkingLine";

export type Command = { name: string; kind: Exclude<AskKind, "question">; hint: string };

/** What the ask bar does itself. Rooms never compacts: `/compact` asks the agent for the summary. */
export const COMMANDS: Command[] = [
  { name: "new", kind: "clear", hint: "Start a new conversation" },
  { name: "clear", kind: "clear", hint: "Start a new conversation" },
  { name: "compact", kind: "compact", hint: "Summarize the conversation so far, and send that instead" },
];

/** The commands a draft like "/co" could be; none once it has a space or isn't a slash word. */
export function matchCommands(draft: string): Command[] {
  const m = /^\/([a-z]*)$/i.exec(draft);
  if (!m) return [];
  const typed = m[1].toLowerCase();
  return COMMANDS.filter((c) => c.name.startsWith(typed));
}

/** The command a draft is exactly ("/new", "/compact "), if any. */
export function exactCommand(draft: string): Command | undefined {
  const t = draft.trim().toLowerCase();
  return COMMANDS.find((c) => `/${c.name}` === t);
}

/** The commands above the input while a slash word is typed; ↑↓ pick, Enter or Tab runs, a click runs. */
export function SlashMenu({ items, active, onPick, onHover }: { items: Command[]; active: number; onPick: (c: Command) => void; onHover: (i: number) => void }) {
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

/** A thin rule with a label in the middle, between turns. */
function Divider({ children }: { children: string }) {
  return (
    <div role="separator" aria-label={children} className="flex items-center gap-3 text-[11.5px] text-ink-2 before:h-px before:flex-1 before:bg-[#e8e8e8] after:h-px after:flex-1 after:bg-[#e8e8e8]">
      {children}
    </div>
  );
}

/**
 * `/new` is a divider: nothing above it is sent along anymore. `/compact` is one too once the
 * agent's summary is in, with the summary a click away; while the agent writes it, it says so.
 */
export function CommandTurn({ t, activity, renderAnswer, renderFailure }: {
  t: AskTurn;
  activity?: string | null;
  renderAnswer: (text: string) => React.ReactNode;
  renderFailure: () => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (t.kind === "clear") return <div data-turn-id={t.id}><Divider>New conversation</Divider></div>;
  return (
    <div data-turn-id={t.id} className="space-y-2">
      {t.status === "running" ? (
        <div className="flex min-w-0 items-center gap-2 text-[12.5px] text-ink-2"><ThinkingLine label={activity ?? "Summarizing the conversation"} /></div>
      ) : t.status === "done" ? (
        <>
          <Divider>Conversation summarized</Divider>
          <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="-ml-2 inline-flex min-h-7 items-center rounded-md px-2 text-[12.5px] text-ink-2 hover:bg-[#f2f2f2] hover:text-ink focus-visible:outline-2 focus-visible:outline-ink">
            {open ? "Hide summary" : "Show summary"}
          </button>
          {open ? <div className="rounded-lg bg-[#fafafa] px-3 py-2">{renderAnswer(t.answer)}</div> : null}
        </>
      ) : t.status === "cancelled" ? (
        <div className="text-[12.5px] text-ink-2">Stopped summarizing</div>
      ) : (
        renderFailure()
      )}
    </div>
  );
}

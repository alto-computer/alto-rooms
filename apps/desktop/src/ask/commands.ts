import type { AskKind } from "@alto-rooms/protocol-ts";

export type CommandKind = Exclude<AskKind, "question">;
export type Command = { name: string; kind: CommandKind; hint: string };

/** What the ask bar does itself. Rooms never compacts: `/compact` asks the agent for the summary. */
export const COMMANDS: Command[] = [
  { name: "new", kind: "clear", hint: "Start a new conversation" },
  { name: "clear", kind: "clear", hint: "Start a new conversation" },
  { name: "compact", kind: "compact", hint: "Summarize the conversation so far, and send that instead" },
];

/** How a command reads in the queue and the thread. */
export const commandText = (kind: CommandKind) => (kind === "clear" ? "/new" : "/compact");

/** The commands a draft like "/co" could become; none once it has a space or isn't one slash word. */
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

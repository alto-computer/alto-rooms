import type { Agent } from "@alto-rooms/protocol-ts";
import { cn } from "@/lib/utils";

/** Each agent's mark on the 16px icon grid: Claude Code a spark, Codex a terminal, Aside a window with its side panel. */
const MARKS: Record<Agent, string[]> = {
  "claude-code": ["M8 2.5v11M2.5 8h11M4.1 4.1l7.8 7.8M11.9 4.1l-7.8 7.8"],
  codex: ["M4.5 3h7A2.25 2.25 0 0 1 13.75 5.25v5.5A2.25 2.25 0 0 1 11.5 13h-7A2.25 2.25 0 0 1 2.25 10.75v-5.5A2.25 2.25 0 0 1 4.5 3Z", "m5.25 6.5 2 1.5-2 1.5M8.75 10h2"],
  aside: ["M4.25 3h7.5A2 2 0 0 1 13.75 5v6a2 2 0 0 1-2 2h-7.5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z", "M2.25 5.75h11.5M9.75 5.75V13"],
};

/** A small stroked mark for the agent a conversation ran in; ink is `currentColor`. */
export function AgentMark({ agent, className }: { agent: Agent; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("size-3.5 shrink-0", className)}
    >
      {MARKS[agent].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

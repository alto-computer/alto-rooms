import type { Agent } from "@alto-rooms/protocol-ts";

/** Every agent Rooms reads conversations from, by the name the UI gives it. */
export const AGENT_NAMES: Record<Agent, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  aside: "Aside",
};

export const isAgent = (s: unknown): s is Agent => typeof s === "string" && Object.hasOwn(AGENT_NAMES, s);

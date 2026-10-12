import type { Agent } from "@alto-rooms/protocol-ts";

/** Every agent Rooms reads sessions from, by the name the UI gives it. */
export const AGENT_NAMES: Record<Agent, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  aside: "Aside",
};

export const isAgent = (s: unknown): s is Agent => typeof s === "string" && Object.hasOwn(AGENT_NAMES, s);

/** roomsd's `SessionId` rule for the id an agent gave a session. It never starts with `-`, so it never reads as a flag. */
export const isSessionId = (v: unknown): v is string => typeof v === "string" && /^(?!-)[A-Za-z0-9_-]{1,128}$/.test(v);

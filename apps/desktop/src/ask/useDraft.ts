import { useEffect, useState } from "react";
import type { AskScope } from "@alto-rooms/protocol-ts";
import { scopeKey } from "@alto-rooms/protocol-ts";

const PREFIX = "alto-rooms.askDraft.";

/** An artifact keeps the key drafts were saved under before scopes, so what was typed then comes back. */
const storageKey = (scope: AskScope) => `${PREFIX}${scope.kind === "artifact" ? scope.fileKey : scopeKey(scope)}`;

/** Where a session's draft was saved before sessions had their name (`conversation:<agent>:<id>`). */
const legacyKey = (scope: AskScope) => (scope.kind === "session" ? `${PREFIX}conversation:${scope.agent}:${scope.id}` : null);

/** The scope's draft. One saved under the scope's old key moves to its key the first time it is read. */
function load(scope: AskScope): string {
  try {
    const key = storageKey(scope);
    const text = localStorage.getItem(key);
    const old = legacyKey(scope);
    if (text !== null || old === null) return text ?? "";
    const moved = localStorage.getItem(old);
    if (moved === null) return "";
    localStorage.setItem(key, moved);
    localStorage.removeItem(old);
    return moved;
  } catch {
    return "";
  }
}

function save(key: string, text: string): void {
  try {
    if (text) localStorage.setItem(key, text);
    else localStorage.removeItem(key);
  } catch {
    // storage unavailable: the draft lasts while the bar shows this scope
  }
}

/** Puts `text` back as a scope's draft unless one was typed since, even when no bar shows that scope any more. */
export function restoreDraft(scope: AskScope, text: string): void {
  if (!load(scope)) save(storageKey(scope), text);
}

type SetDraft = (next: string | ((current: string) => string)) => void;

/** The unsent question typed in a scope: kept per scope, across tabs and restarts. */
export function useDraft(scope: AskScope): [string, SetDraft] {
  const key = storageKey(scope);
  const [state, setState] = useState(() => ({ key, text: load(scope) }));
  // Another scope in the same bar brings back its own draft.
  if (state.key !== key) setState({ key, text: load(scope) });
  useEffect(() => save(state.key, state.text), [state]);
  const setDraft: SetDraft = (next) =>
    setState((s) => ({ key: s.key, text: typeof next === "function" ? next(s.text) : next }));
  return [state.key === key ? state.text : "", setDraft];
}

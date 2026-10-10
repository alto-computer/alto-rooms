import { useEffect, useState } from "react";
import type { AskScope } from "@alto-rooms/protocol-ts";
import { scopeKey } from "@alto-rooms/protocol-ts";

/** A doc keeps the key drafts were saved under before scopes, so what was typed then comes back. */
const storageKey = (scope: AskScope) => `alto-rooms.askDraft.${scope.kind === "doc" ? scope.fileKey : scopeKey(scope)}`;

function load(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
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
  const key = storageKey(scope);
  if (!load(key)) save(key, text);
}

type SetDraft = (next: string | ((current: string) => string)) => void;

/** The unsent question typed in a scope: kept per scope, across tabs and restarts. */
export function useDraft(scope: AskScope): [string, SetDraft] {
  const key = storageKey(scope);
  const [state, setState] = useState(() => ({ key, text: load(key) }));
  // Another scope in the same bar brings back its own draft.
  if (state.key !== key) setState({ key, text: load(key) });
  useEffect(() => save(state.key, state.text), [state]);
  const setDraft: SetDraft = (next) =>
    setState((s) => ({ key: s.key, text: typeof next === "function" ? next(s.text) : next }));
  return [state.key === key ? state.text : "", setDraft];
}

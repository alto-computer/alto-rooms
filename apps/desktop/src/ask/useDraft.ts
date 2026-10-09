import { useEffect, useState } from "react";

const storageKey = (fileKey: string) => `alto-rooms.askDraft.${fileKey}`;

function load(fileKey: string): string {
  try {
    return localStorage.getItem(storageKey(fileKey)) ?? "";
  } catch {
    return "";
  }
}

function save(fileKey: string, text: string): void {
  try {
    if (text) localStorage.setItem(storageKey(fileKey), text);
    else localStorage.removeItem(storageKey(fileKey));
  } catch {
    // storage unavailable: the draft lasts while the bar shows this doc
  }
}

type SetDraft = (next: string | ((current: string) => string)) => void;

/** The unsent question typed under a doc: kept per doc, across tabs and restarts. */
export function useDraft(fileKey: string): [string, SetDraft] {
  const [state, setState] = useState(() => ({ fileKey, text: load(fileKey) }));
  // Another doc in the same bar brings back its own draft.
  if (state.fileKey !== fileKey) setState({ fileKey, text: load(fileKey) });
  useEffect(() => save(state.fileKey, state.text), [state]);
  const setDraft: SetDraft = (next) =>
    setState((s) => ({ fileKey: s.fileKey, text: typeof next === "function" ? next(s.text) : next }));
  return [state.fileKey === fileKey ? state.text : "", setDraft];
}

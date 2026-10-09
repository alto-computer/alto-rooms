import { useId, useState, type FormEvent, type ReactNode } from "react";
import { count } from "@/lib/dates";
import { ago, openKeyConsole, sortClearKey, sortSetKey, sortUndoLast, type SortState } from "@/lib/sort";
import { useSortState } from "@/lib/useSortState";
import { PRIMARY_BUTTON, ROW_BUTTON, Row, Section } from "./settingsUi";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const MASK = "••••••••••••";

/** Settings › Auto-sort: the TypeSafe key and the last run. Nothing outside the app (no sorter there). */
export function AutoSortSettings() {
  const [state, refresh] = useSortState();
  if (!state) return null;
  return (
    <Section
      section="auto-sort"
      title="Auto-sort"
      footnote="Artifacts named like a room move on their own. With a key, TypeSafe picks a room for the rest from each one's title, its path in the repo and its first 2,000 characters."
    >
      <KeyRow state={state} refresh={refresh} />
      <RunRow state={state} />
    </Section>
  );
}

function KeyRow({ state, refresh }: { state: SortState; refresh: () => Promise<void> }) {
  const { keySource, keyRejected } = state;
  // A refused Keychain key opens straight to the field that replaces it.
  const [editing, setEditing] = useState(keySource === "keychain" && keyRejected);
  const [note, setNote] = useState<string | null>(null);
  const reason = useId();

  const saved = async () => {
    setEditing(false);
    setNote("Key saved. Sorting the inbox now.");
    await refresh();
  };
  const remove = async () => {
    try {
      await sortClearKey();
      setNote("Key removed. Artifacts named like a room still move on their own.");
    } catch (e) {
      setNote(errorText(e));
    }
    setEditing(false);
    await refresh();
  };

  if (keySource === "none" || editing) {
    return (
      <Row
        label="TypeSafe key"
        detail={
          <>
            {keyRejected ? <span className="block text-error">TypeSafe stopped accepting this key.</span> : null}
            {keySource === "none" ? "Not set. " : null}
            <button type="button" onClick={() => void openKeyConsole()} className="text-ink underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none">
              Get a key
            </button>
            {note ? <Note>{note}</Note> : null}
          </>
        }
      >
        <KeyForm onSaved={saved} onCancel={keySource === "none" ? undefined : () => setEditing(false)} />
      </Row>
    );
  }

  const env = keySource === "env";
  return (
    <Row
      label="TypeSafe key"
      detail={
        <>
          <span className="font-mono tracking-[.08em]">{MASK}</span>
          {env ? " · From TYPESAFE_API_KEY" : " · In your Keychain"}
          {keyRejected ? <span className="block text-error">{env ? "TypeSafe refused TYPESAFE_API_KEY. Only artifacts named like a room move." : "TypeSafe stopped accepting this key."}</span> : null}
          {env ? (
            <span id={reason} className="block">
              Set in the app's environment, so it can only be changed there.
            </span>
          ) : null}
          {note ? <Note>{note}</Note> : null}
        </>
      }
    >
      <div className="flex gap-1.5">
        {env ? null : (
          <button type="button" className={ROW_BUTTON} onClick={() => setEditing(true)}>
            Change
          </button>
        )}
        <button type="button" className={ROW_BUTTON} disabled={env} aria-describedby={env ? reason : undefined} onClick={() => void remove()}>
          Remove
        </button>
      </div>
    </Row>
  );
}

function KeyForm({ onSaved, onCancel }: { onSaved: () => Promise<void>; onCancel?: () => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await sortSetKey(key);
      setKey("");
      await onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex w-[300px] shrink-0 flex-col gap-1.5">
      <div className="flex gap-1.5">
        <input
          type="password"
          aria-label="TypeSafe API key"
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="Paste a key"
          className="h-7 min-w-0 flex-1 rounded-lg bg-surface px-2.5 font-mono text-small text-ink shadow-[inset_0_0_0_1px_var(--hairline)] outline-none placeholder:font-sans placeholder:text-ink-3 focus-visible:shadow-[inset_0_0_0_1px_var(--ink)]"
        />
        <button type="submit" className={PRIMARY_BUTTON} disabled={busy || !key.trim()}>
          {busy ? "Checking…" : "Save"}
        </button>
        {onCancel ? (
          <button type="button" className={ROW_BUTTON} onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-small text-error">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function RunRow({ state }: { state: SortState }) {
  const [note, setNote] = useState<string | null>(null);
  const s = state.status;
  if (!s) {
    return state.keySource === "none" ? null : <Row label="Last sort" detail="The first sort runs within a minute." />;
  }
  const undo = async () => {
    try {
      const lines = await sortUndoLast();
      const back = lines.filter((l) => l.startsWith("back to inbox")).length;
      setNote(back ? `Moved ${count(back, "artifact")} back. They stay in the inbox from now on.` : "Nothing to move back.");
    } catch (e) {
      setNote(errorText(e) === "nothing to undo" ? "Nothing to undo yet." : errorText(e));
    }
  };
  return (
    <Row
      label="Last sort"
      detail={
        <>
          {ago(s.lastRunAt)} · {s.movedToday} moved today, {s.keptToday} left in the inbox
          {note ? <Note>{note}</Note> : null}
        </>
      }
    >
      <button type="button" className={ROW_BUTTON} onClick={() => void undo()}>
        Undo last sort
      </button>
    </Row>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <span role="status" className="block text-ink">
      {children}
    </span>
  );
}

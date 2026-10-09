import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ago, openKeyConsole, sortClearKey, sortSetKey, sortState, sortUndoLast, type SortState } from "@/lib/sort";

const DISMISSED = "alto-rooms.sortbar.dismissed";
const POLL_MS = 20_000;

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(v: boolean) {
  try {
    if (v) localStorage.setItem(DISMISSED, "1");
    else localStorage.removeItem(DISMISSED);
  } catch {
    /* per-viewer convenience only */
  }
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Auto-sort above the inbox (spec rooms-sort §4): without a key, a panel to add a TypeSafe key
 * (or, once dismissed, one small button); with a key, one status line with undo. Renders
 * nothing outside the app (no sorter there).
 */
export function SortBar() {
  const [state, setState] = useState<SortState | null>(null);
  const [dismissed, setDismissed] = useState(readDismissed);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await sortState());
    } catch {
      setState(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  if (!state) return null;

  if (state.keySource === "none" || (state.keyRejected && state.keySource === "keychain")) {
    if (dismissed && !state.keyRejected) {
      return (
        <div data-testid="sort-bar">
          <Button variant="ghost" size="sm" className="-ml-2.5 text-ink-2" onClick={() => { writeDismissed(false); setDismissed(false); }}>
            <Sparkles aria-hidden /> Auto-sort the inbox
          </Button>
        </div>
      );
    }
    return (
      <KeyPanel
        rejected={state.keyRejected}
        onSaved={async () => {
          setNote("Key saved. Sorting the inbox now.");
          await refresh();
        }}
        onDismiss={() => {
          writeDismissed(true);
          setDismissed(true);
        }}
      />
    );
  }

  const s = state.status;
  return (
    <div data-testid="sort-bar" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-body text-ink-2">
      <span className="flex items-center gap-1.5 text-ink">
        <Sparkles size={15} aria-hidden /> Auto-sort is on
      </span>
      {state.keyRejected ? (
        <span className="text-error">TypeSafe refused TYPESAFE_API_KEY. Only docs named like a room move.</span>
      ) : s ? (
        <span>
          {s.movedToday} moved today, {s.keptToday} left here · {ago(s.lastRunAt)}
        </span>
      ) : (
        <span>First sort runs within a minute</span>
      )}
      {state.keySource === "env" ? <span>Using TYPESAFE_API_KEY</span> : null}
      <span className="flex gap-1">
        <Button
          variant="ghost"
          size="xs"
          onClick={async () => {
            try {
              const lines = await sortUndoLast();
              const back = lines.filter((l) => l.startsWith("back to inbox")).length;
              setNote(back ? `Moved ${back} doc${back === 1 ? "" : "s"} back. They stay here from now on.` : "Nothing to move back.");
            } catch (e) {
              setNote(errorText(e) === "nothing to undo" ? "Nothing to undo yet." : errorText(e));
            }
          }}
        >
          Undo last sort
        </Button>
        {state.keySource === "keychain" ? (
          <Button
            variant="ghost"
            size="xs"
            onClick={async () => {
              await sortClearKey();
              setNote("Key removed. Docs named like a room still move on their own.");
              await refresh();
            }}
          >
            Remove key
          </Button>
        ) : null}
      </span>
      {note ? <span className="basis-full text-ink">{note}</span> : null}
    </div>
  );
}

function KeyPanel({ rejected, onSaved, onDismiss }: { rejected: boolean; onSaved: () => Promise<void>; onDismiss: () => void }) {
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
    <section data-testid="sort-bar" aria-labelledby="sort-title" className="flex max-w-[680px] flex-col gap-2 rounded-xl border border-hairline bg-background px-5 py-4">
      <h2 id="sort-title" className="flex items-center gap-1.5 text-lead font-medium text-ink">
        <Sparkles size={16} aria-hidden /> {rejected ? "TypeSafe stopped accepting your key" : "Sort the inbox automatically"}
      </h2>
      <p className="text-body text-ink-2">
        Docs from a repo with a room of the same name already move on their own. Add a TypeSafe key and the rest go to the room that fits, or to a new
        room named after their repo once three of them are waiting.
      </p>
      <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
        <label htmlFor="sort-key" className="sr-only">
          TypeSafe API key
        </label>
        <input
          id="sort-key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="TypeSafe API key"
          className="h-8 min-w-0 flex-1 basis-[240px] rounded-md border border-hairline bg-surface px-2.5 font-mono text-body text-ink outline-none focus-visible:border-ink"
        />
        <Button type="submit" size="sm" disabled={busy || !key.trim()}>
          {busy ? "Checking…" : "Turn on"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => void openKeyConsole()}>
          Get a key
        </Button>
        {!rejected ? (
          <Button type="button" variant="ghost" size="sm" className="text-ink-2" onClick={onDismiss}>
            Not now
          </Button>
        ) : null}
      </form>
      {error ? (
        <p role="alert" className="text-body text-error">
          {error}
        </p>
      ) : null}
      <p className="text-body text-ink-3">
        Each doc's title, its path inside the repo and its first 2,000 characters go to TypeSafe. A doc moves only when the answer is at least 70% sure.
        The key stays in your Keychain.
      </p>
    </section>
  );
}

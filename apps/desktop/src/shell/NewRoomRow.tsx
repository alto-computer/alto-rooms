import { useEffect, useId, useRef, useState } from "react";
import { CircleAlert, Folder } from "lucide-react";
import { useClient, useViewerStore } from "@/data/hooks";
import { errorCopy } from "@/lib/errors";
import { pickFolder } from "@/lib/native";

/**
 * The inline "new room" row at the top of the room list. Enter creates the
 * room and opens its tab right away (the list itself updates from SSE);
 * Escape cancels. Below it, "Link a folder…" links an existing folder.
 */
export function NewRoomRow({ onDone }: { onDone: () => void }) {
  const client = useClient();
  const viewer = useViewerStore();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const live = useRef(true);
  const inputId = useId();
  const errorId = useId();

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    if (!busy) inputRef.current?.focus();
  }, [busy]);

  /** Runs a write that yields the new room (or null when the user backed out) and opens it. */
  const run = async (write: () => Promise<{ id: string } | null>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const room = await write();
      if (!live.current || !room) return;
      viewer.navigate({ kind: "room", roomId: room.id });
      onDone();
    } catch (e) {
      if (live.current) setError(errorCopy(e));
    } finally {
      if (live.current) setBusy(false);
    }
  };

  const create = () => {
    const next = name.trim();
    if (next) void run(() => client.createRoom(next));
  };

  const link = () =>
    void run(async () => {
      const path = await pickFolder();
      return path ? client.linkFolder(path) : null;
    });

  return (
    <li className="flex flex-col gap-1">
      <div className="flex min-h-9 items-center gap-2.5 rounded-lg bg-white px-2.5 text-[15px] shadow-[0_0_0_2px_#222]">
        <Folder size={17} strokeWidth={1.75} aria-hidden className="shrink-0" />
        <label htmlFor={inputId} className="sr-only">
          New room name
        </label>
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          value={name}
          disabled={busy}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter") {
              e.preventDefault();
              create();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onDone();
            }
          }}
          className="min-w-0 flex-1 bg-transparent outline-none disabled:opacity-60"
        />
        <span aria-hidden className="shrink-0 text-[12px] text-ink-3">
          ↵
        </span>
      </div>
      {error ? (
        <p id={errorId} role="alert" className="flex items-center gap-1.5 px-2.5 pt-1 text-[13px] text-[#c13515]">
          <CircleAlert size={14} aria-hidden className="shrink-0" />
          {error}
        </p>
      ) : null}
      <button
        type="button"
        onClick={link}
        disabled={busy}
        className="self-start rounded-lg px-2.5 py-1.5 text-[14px] text-ink-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-ink disabled:opacity-60"
      >
        Link a folder…
      </button>
    </li>
  );
}

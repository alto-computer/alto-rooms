import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { CircleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { errorCopy } from "@/lib/errors";

export type EditableTitleProps = {
  value: string;
  /** Called with the trimmed new value. Reject to stay in edit mode; the error's copy is shown. */
  onSave: (next: string) => Promise<void>;
  /** Called when editing ends without a save (Escape, or an empty/unchanged value). */
  onCancel?: () => void;
  /** Called after a successful save. */
  onSaved?: () => void;
  /** Applied to both the heading and the input, so the type matches. */
  className?: string;
  inputClassName?: string;
  ariaLabel: string;
  hint?: string;
  /** Start in edit mode (the sidebar row mounts it on double-click). */
  defaultEditing?: boolean;
  /** Read-only: plain text, never editable. */
  readOnly?: boolean;
  /** Maps a rejected save to its copy (default: `errorCopy`). */
  copyError?: (e: unknown) => string;
};

/**
 * Shared inline editor. Click enters edit mode; Enter or blur saves; Escape
 * cancels. While saving the input is disabled; a rejected save keeps the
 * input open with the mapped spec §3 copy below it.
 */
export function EditableTitle({
  value,
  onSave,
  onCancel,
  onSaved,
  className,
  inputClassName,
  ariaLabel,
  hint,
  defaultEditing = false,
  readOnly = false,
  copyError = errorCopy,
}: EditableTitleProps) {
  const [editing, setEditing] = useState(defaultEditing && !readOnly);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const savingRef = useRef(false);
  // Set once editing ends, so a late blur from the unmounting input can't save.
  const closed = useRef(false);
  const failedDraft = useRef<string | null>(null);
  const live = useRef(true);
  const errorId = useId();
  const hintId = useId();

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    if (editing && !saving) {
      inputRef.current?.focus();
    }
  }, [editing, saving]);

  if (readOnly && editing) setEditing(false);

  const start = () => {
    if (readOnly) return;
    setDraft(value);
    setError(null);
    failedDraft.current = null;
    closed.current = false;
    setEditing(true);
  };

  const cancel = () => {
    closed.current = true;
    setEditing(false);
    setError(null);
    failedDraft.current = null;
    onCancel?.();
  };

  const save = async (viaBlur: boolean) => {
    if (savingRef.current || closed.current) return;
    const next = draft.trim();
    if (!next || next === value) {
      cancel();
      return;
    }
    // Clicking away from a value that just failed gives up instead of failing again.
    if (viaBlur && failedDraft.current === draft) {
      cancel();
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await onSave(next);
      if (!live.current) return;
      failedDraft.current = null;
      closed.current = true;
      setEditing(false);
      onSaved?.();
    } catch (e) {
      if (!live.current) return;
      failedDraft.current = draft;
      setError(copyError(e));
    } finally {
      savingRef.current = false;
      if (live.current) setSaving(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return; // Korean IME: Enter commits the syllable first
    if (e.key === "Enter") {
      e.preventDefault();
      void save(false);
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  };

  if (!editing) {
    if (readOnly) return <h1 className={className}>{value}</h1>;
    return (
      <h1
        className={cn("cursor-text", className)}
        tabIndex={0}
        onClick={start}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            start();
          }
        }}
      >
        {value}
      </h1>
    );
  }

  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(" ") || undefined;

  return (
    <div className="flex min-w-0 flex-col">
      <input
        ref={inputRef}
        type="text"
        aria-label={ariaLabel}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        value={draft}
        disabled={saving}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => void save(true)}
        className={cn(className, "min-w-0 bg-white outline-none disabled:opacity-60", inputClassName)}
      />
      {error ? (
        <p id={errorId} role="alert" className="mt-1.5 flex items-center gap-1.5 text-[14px] text-[#c13515]">
          <CircleAlert size={16} aria-hidden />
          {error}
        </p>
      ) : null}
      {hint ? (
        <p id={hintId} className="mt-1.5 text-[14px] text-ink-3">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

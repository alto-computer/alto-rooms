import { useEffect, useRef, useState, type FormEvent } from "react";
import { NotebookPen } from "lucide-react";
import { useClient, useRoomsStore, useViewerStore } from "@/data/hooks";
import { GENERIC_ERROR, noteNameErrorCopy } from "@/lib/errors";
import { createUnderFreeName, freeNoteNames, MAX_QUESTION_NAME, noteNameFromQuestion, noteNameLength } from "@/lib/notes";
import type { NoteTargetOf } from "./askSubjects";
import { splitQuotes } from "./quotes";
import { ErrorText, TextButton } from "./ui";

/** Most names tried before giving up. */
const MAX_TRIES = 50;

/** A saved answer: the line naming where it came from, the question as a heading, then the answer. */
export function answerNoteBody(source: string | null, question: string, answer: string): string {
  const heading = `## ${splitQuotes(question).text.replace(/\s+/g, " ").trim()}`;
  return [...(source ? [source, ""] : []), heading, "", answer].join("\n");
}

type Step =
  | { kind: "closed" }
  | { kind: "naming"; name: string; error: string | null }
  | { kind: "saving"; name: string }
  | { kind: "saved"; date: string; fileName: string };

const ICON_BUTTON =
  "inline-flex size-7 items-center justify-center rounded-md text-ink-2 hover:bg-surface hover:text-ink focus-visible:outline-2 focus-visible:outline-ink";

/** "Save as note" beside Copy: asks for a name (the question's, editable), saves into the Journal, then links to the note. */
export function SaveAsNote({ question, answer, target }: { question: string; answer: string; target: NoteTargetOf }) {
  const client = useClient();
  const rooms = useRoomsStore();
  const viewer = useViewerStore();
  const [step, setStep] = useState<Step>({ kind: "closed" });

  if (step.kind === "closed") {
    return (
      <button
        type="button"
        aria-label="Save as note"
        title="Save as note"
        className={ICON_BUTTON}
        onClick={() => setStep({ kind: "naming", name: noteNameFromQuestion(question), error: null })}
      >
        <NotebookPen size={14} />
      </button>
    );
  }

  if (step.kind === "saved") {
    return (
      <span role="status" className="flex items-center gap-2 pl-1">
        Saved to Journal
        <TextButton onClick={() => viewer.open({ kind: "note", date: step.date, name: step.fileName })}>Open note</TextButton>
      </span>
    );
  }

  const save = async (name: string) => {
    setStep({ kind: "saving", name });
    const { date, source } = target(new Date(), rooms.getState().rooms);
    const listed = rooms.getState().days[date]?.notes ?? [];
    try {
      const body = answerNoteBody(source, question, answer);
      const fileName = await createUnderFreeName(freeNoteNames(name.trim(), listed, MAX_TRIES), (file) => client.createNote(date, file, body));
      setStep(fileName ? { kind: "saved", date, fileName } : { kind: "naming", name, error: GENERIC_ERROR });
    } catch (e) {
      setStep({ kind: "naming", name, error: noteNameErrorCopy(e) });
    }
  };

  return (
    <NameForm
      name={step.name}
      error={step.kind === "naming" ? step.error : null}
      saving={step.kind === "saving"}
      onChange={(name) => setStep({ kind: "naming", name, error: null })}
      onSave={(name) => void save(name)}
      onCancel={() => setStep({ kind: "closed" })}
    />
  );
}

function NameForm({ name, error, saving, onChange, onSave, onCancel }: {
  name: string;
  error: string | null;
  saving: boolean;
  onChange: (name: string) => void;
  onSave: (name: string) => void;
  onCancel: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.select(), []);
  const tooLong = noteNameLength(name) > MAX_QUESTION_NAME;
  const canSave = !saving && !tooLong && !!name.trim();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (canSave) onSave(name);
  };
  const shown = error ?? (tooLong ? `Names can be up to ${MAX_QUESTION_NAME} characters` : null);
  return (
    <form onSubmit={submit} className="flex basis-full flex-wrap items-center gap-2 py-1">
      <input
        ref={input}
        aria-label="Note name"
        value={name}
        readOnly={saving}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.nativeEvent.isComposing) e.preventDefault();
          if (e.key === "Escape") onCancel();
        }}
        className="h-7 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-small text-ink outline-none focus:border-ink"
      />
      <button
        type="submit"
        disabled={!canSave}
        aria-busy={saving || undefined}
        className="inline-flex h-7 items-center rounded-md bg-ink px-2.5 text-small font-medium text-pane disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
      >
        Save
      </button>
      <TextButton onClick={onCancel}>Cancel</TextButton>
      {shown ? <div className="basis-full"><ErrorText>{shown}</ErrorText></div> : null}
    </form>
  );
}

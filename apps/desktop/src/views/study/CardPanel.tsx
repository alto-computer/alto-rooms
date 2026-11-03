import { useEffect } from "react";
import { EditorContent, useEditorState, type Editor } from "@tiptap/react";
import { X } from "lucide-react";
import { useCanvas, useCardEditor, type WrittenKind } from "./canvasNodes";

/** The first line with words in it, as the panel's heading. */
const firstLine = (editor: Editor) =>
  editor
    .getText({ blockSeparator: "\n" })
    .split("\n")
    .find((l) => l.trim())
    ?.trim() ?? "";

/**
 * A card opened beside the canvas: the same markdown, edited as a page with room to read. It edits the
 * card itself, live, and saves with the canvas.
 */
export function CardPanel({ id, kind, body, onClose }: { id: string; kind: WrittenKind; body: string; onClose: () => void }) {
  const { readOnly } = useCanvas();
  const editor = useCardEditor(id, kind, body, kind === "ink" ? "Card" : "Text");
  const heading = useEditorState({ editor, selector: ({ editor }) => firstLine(editor) });
  useEffect(() => {
    if (readOnly) return;
    const frame = requestAnimationFrame(() => !editor.isDestroyed && editor.commands.focus("end"));
    return () => cancelAnimationFrame(frame);
    // Once, when the panel opens: a publish that freezes the canvas later moves no caret.
  }, [editor]);
  return (
    <aside className="st-panel" aria-label="Opened card">
      <header className="st-phead">
        <h2 className={heading ? "st-ptitle" : "st-ptitle st-untitled"}>{heading || "Untitled"}</h2>
        <button type="button" className="st-pclose" aria-label="Close" title="Close" onClick={onClose}>
          <X size={16} strokeWidth={1.6} aria-hidden />
        </button>
      </header>
      <div className="st-pscroll">
        <EditorContent editor={editor} className="st-ppage" />
      </div>
    </aside>
  );
}

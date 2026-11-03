import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { StudyCardKind } from "@alto-rooms/protocol-ts";
import {
  BaseEdge,
  Handle,
  NodeResizeControl,
  Position,
  ResizeControlVariant,
  useInternalNode,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { EditorContent, useEditor, type Editor, type JSONContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { Placeholder } from "@tiptap/extensions";
import { Maximize2 } from "lucide-react";

export type CardData = { body: string };
export type CardNode = Node<CardData, StudyCardKind>;

/** The kinds written in markdown, which open in the side panel. */
export type WrittenKind = Extract<StudyCardKind, "ink" | "text">;
export const isWritten = (kind: StudyCardKind | undefined): kind is WrittenKind => kind === "ink" || kind === "text";

/** What a node, and the side panel, need from their canvas. */
export type Canvas = {
  readOnly: boolean;
  /** The node just added, which takes the caret. */
  fresh: string | null;
  /** The card open in the side panel. */
  opened: string | null;
  open: (id: string) => void;
  setBody: (id: string, body: string) => void;
  /** Shows a card's markdown in one more editor (the card's own, or the panel's); returns the detach. */
  attach: (id: string, editor: Editor) => () => void;
  /** One of a card's editors was typed in: the others follow, and from now on its body is read from them. */
  typed: (id: string, editor: Editor) => void;
  /** What a card's editors show now, for one more to start from; null when none is attached. */
  live: (id: string) => JSONContent | null;
};
export const CanvasContext = createContext<Canvas | null>(null);
export const useCanvas = () => useContext(CanvasContext)!;

const EXTENSIONS = [
  StarterKit,
  Markdown,
  // Shown by study.css on an empty editor only, and only while it can be written in.
  Placeholder.configure({ placeholder: ({ node }) => (node.type.name === "heading" ? `Heading ${node.attrs.level as number}` : "Text") }),
];

/** An empty ink card starts on a heading, its title line. */
const TITLE_LINE = "<h1></h1>";

/**
 * A TipTap editor on one card's markdown. A card can have two (on the canvas and in the side panel);
 * typing in either shows in the other at once.
 */
export function useCardEditor(id: string, kind: WrittenKind, body: string, label: string): Editor {
  const { readOnly, attach, typed, live } = useCanvas();
  const onType = useRef(typed);
  onType.current = typed;
  const [start] = useState(() => {
    const now = live(id);
    if (now) return { content: now, contentType: "json" as const };
    if (body === "" && kind === "ink" && !readOnly) return { content: TITLE_LINE, contentType: "html" as const };
    return { content: body, contentType: "markdown" as const };
  });
  const editor = useEditor({
    extensions: EXTENSIONS,
    ...start,
    injectCSS: false,
    editable: !readOnly,
    shouldRerenderOnTransaction: false,
    editorProps: { attributes: { class: "nodrag nowheel nopan nokey", "aria-label": label } },
    onUpdate: ({ editor }) => onType.current(id, editor),
  });
  useEffect(() => attach(id, editor), [attach, editor, id]);
  useEffect(() => editor.setEditable(!readOnly, false), [editor, readOnly]);
  // A body replaced from outside (the canvas reloaded) goes into the editor; typing never changes data.body.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    editor.commands.setContent(body, { contentType: "markdown", emitUpdate: false });
  }, [editor, body]);
  return editor;
}

/** A card's markdown as saved: the empty title line TipTap keeps is not part of what was written. */
export const markdownOf = (editor: Editor) => (editor.isEmpty ? "" : editor.getMarkdown().trimEnd());

/**
 * Puts the caret in a node just added, once React Flow shows it: a new node stays hidden until it is
 * measured, and a hidden element can't take focus (WebKit measures later than Chromium).
 */
function useFocusWhenShown(id: string, focusNow: () => void) {
  const focus = useRef(focusNow);
  focus.current = focusNow;
  const { fresh } = useCanvas();
  const shown = !!useInternalNode(id)?.measured.width;
  const done = useRef(false);
  useEffect(() => {
    if (fresh !== id || !shown || done.current) return;
    done.current = true;
    const frame = requestAnimationFrame(() => focus.current());
    return () => cancelAnimationFrame(frame);
  }, [fresh, id, shown]);
}

/** The right edge of a card or a text, dragged to change its width. */
function WidthResizer() {
  const { readOnly } = useCanvas();
  if (readOnly) return null;
  return <NodeResizeControl position="right" variant={ResizeControlVariant.Line} resizeDirection="horizontal" minWidth={160} maxWidth={960} className="st-rz" />;
}

/** Opens a card in the side panel; shown while the card is hovered. */
function OpenButton({ id }: { id: string }) {
  const { open } = useCanvas();
  return (
    <button type="button" className="st-openbtn nodrag nopan" aria-label="Open" title="Open" onClick={() => open(id)}>
      <Maximize2 size={12} strokeWidth={1.6} aria-hidden />
    </button>
  );
}

/** An ink card: markdown typed in place. The frame drags the card; the text inside never does. */
function InkCard({ id, data, width }: NodeProps<CardNode>) {
  const { opened } = useCanvas();
  const editor = useCardEditor(id, "ink", data.body, "Card");
  useFocusWhenShown(id, () => !editor.isDestroyed && editor.commands.focus("end"));
  return (
    <div className={opened === id ? "st-card st-opened" : "st-card"} style={{ width }} data-testid="ink-card">
      <WidthResizer />
      <Handle type="source" position={Position.Left} id="l" />
      <EditorContent editor={editor} />
      <OpenButton id={id} />
      <Handle type="source" position={Position.Right} id="r" />
    </div>
  );
}

/** Text written straight on the canvas: the same markdown as a card, with no paper under it. */
function TextCard({ id, data, width }: NodeProps<CardNode>) {
  const { opened } = useCanvas();
  const editor = useCardEditor(id, "text", data.body, "Text");
  useFocusWhenShown(id, () => !editor.isDestroyed && editor.commands.focus("end"));
  return (
    <div className={opened === id ? "st-text st-opened" : "st-text"} style={{ width }} data-testid="text-node">
      <WidthResizer />
      <Handle type="source" position={Position.Left} id="l" />
      <EditorContent editor={editor} />
      <OpenButton id={id} />
      <Handle type="source" position={Position.Right} id="r" />
    </div>
  );
}

/** A question card: one line, a heavy border. */
function QuestionCard({ id, data, width }: NodeProps<CardNode>) {
  const { readOnly, setBody } = useCanvas();
  const input = useRef<HTMLInputElement>(null);
  useFocusWhenShown(id, () => input.current?.focus());
  return (
    <div className="st-card st-q" style={{ width }} data-testid="question-card">
      <WidthResizer />
      <Handle type="source" position={Position.Left} id="l" />
      <b aria-hidden>?</b>
      <input
        className="nodrag nopan nokey"
        aria-label="Question"
        value={data.body}
        readOnly={readOnly}
        ref={input}
        onChange={(e) => setBody(id, e.target.value.replace(/\n/g, " "))}
      />
      <Handle type="source" position={Position.Right} id="r" />
    </div>
  );
}

/**
 * A section: a titled frame behind the cards. It drags by its title bar and carries what lies inside
 * it (the canvas works that out when a drag starts); the rest of the frame lets clicks through to the sheet.
 */
function SectionFrame({ id, data, width, height }: NodeProps<CardNode>) {
  const { readOnly, setBody } = useCanvas();
  const input = useRef<HTMLInputElement>(null);
  useFocusWhenShown(id, () => input.current?.focus());
  return (
    <div className="st-sec" style={{ width, height }} data-testid="section">
      <div className="st-secbar">
        <label className="st-secname">
          <span aria-hidden>{data.body || (readOnly ? "" : "Section")}</span>
          <input
            className="nodrag nopan nokey"
            aria-label="Section title"
            placeholder={readOnly ? "" : "Section"}
            maxLength={120}
            value={data.body}
            readOnly={readOnly}
            ref={input}
            onChange={(e) => setBody(id, e.target.value)}
          />
        </label>
      </div>
      {readOnly ? null : <NodeResizeControl position="bottom-right" minWidth={240} minHeight={140} className="st-secrz" />}
    </div>
  );
}

/** The line between two cards, from the facing sides of each, wherever their handles are. */
function Thread({ id, source, target, markerEnd, style }: EdgeProps) {
  const a = useInternalNode(source);
  const b = useInternalNode(target);
  if (!a || !b) return null;
  const box = (n: NonNullable<typeof a>) => {
    const { x, y } = n.internals.positionAbsolute;
    return { x, y, w: n.measured.width ?? 0, h: n.measured.height ?? 0 };
  };
  const A = box(a);
  const B = box(b);
  const [ax, ay, bx, by] = [A.x + A.w / 2, A.y + A.h / 2, B.x + B.w / 2, B.y + B.h / 2];
  // Side to side, unless one card sits mostly above the other: then bottom to top.
  const across = Math.abs(bx - ax) - (A.w + B.w) / 4 > Math.abs(by - ay) - (A.h + B.h) / 4;
  let path: string;
  if (across) {
    const [sx, ex] = ax <= bx ? [A.x + A.w, B.x] : [A.x, B.x + B.w];
    const mx = (sx + ex) / 2;
    path = `M${sx} ${ay} C ${mx} ${ay}, ${mx} ${by}, ${ex} ${by}`;
  } else {
    const [sy, ey] = ay <= by ? [A.y + A.h, B.y] : [A.y, B.y + B.h];
    const my = (sy + ey) / 2;
    path = `M${ax} ${sy} C ${ax} ${my}, ${bx} ${my}, ${bx} ${ey}`;
  }
  return <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} interactionWidth={14} />;
}

export const NODE_TYPES: Record<StudyCardKind, (props: NodeProps<CardNode>) => ReactNode> = {
  ink: InkCard,
  text: TextCard,
  question: QuestionCard,
  section: SectionFrame,
};
export const EDGE_TYPES = { thread: Thread };

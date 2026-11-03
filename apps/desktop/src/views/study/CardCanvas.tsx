import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import type { RoomsEvent, StudyCard, StudyCardKind, StudyEdge } from "@alto-rooms/protocol-ts";
import {
  ConnectionMode,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
  type XYPosition,
} from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import type { Editor } from "@tiptap/react";
import { useRoomsStore } from "@/data/hooks";
import { errorCopy } from "@/lib/errors";
import { CanvasContext, EDGE_TYPES, isWritten, markdownOf, NODE_TYPES, type Canvas, type CardNode } from "./canvasNodes";
import { CardPanel } from "./CardPanel";
import { newId } from "./study";

/** Edits wait this long for the next one before the canvas is saved. */
export const SAVE_DELAY_MS = 600;
/** A new node's width, and the height the tools centre it by; a section keeps its height as its frame's. */
const SIZE: Record<StudyCardKind, { width: number; height: number }> = {
  ink: { width: 280, height: 120 },
  text: { width: 280, height: 40 },
  question: { width: 240, height: 44 },
  section: { width: 560, height: 360 },
};
/** Sections lie behind every card, a selected section too (selecting lifts a node by 1000). */
const SECTION_Z = -1001;

/** What a canvas holds and saves whole: a volume's or a day book's title, cards and lines. */
export type CanvasContent = { title: string; cards: StudyCard[]; edges: StudyEdge[] };

/** What a page's own header actions can do with its canvas. */
export type CanvasControls = {
  add: (kind: StudyCardKind) => void;
  /** Saves a pending change now; resolves once every save so far has landed. */
  flush: () => Promise<unknown>;
  /** The last save failed, so roomsd may not hold what the screen shows. */
  unsaved: () => boolean;
  showError: (e: unknown) => void;
};

/** Writes from elsewhere (an agent, another window): which signals are about this canvas, and what it holds now (null leaves it). */
export type CanvasFollow = {
  about: (type: RoomsEvent["type"], e: RoomsEvent) => boolean;
  load: () => Promise<CanvasContent | null>;
};

const toNode = (c: StudyCard): CardNode =>
  c.kind === "section"
    ? { id: c.id, type: c.kind, position: { x: c.x, y: c.y }, width: c.width, height: c.height ?? SIZE.section.height, zIndex: SECTION_Z, dragHandle: ".st-secbar", data: { body: c.body } }
    : { id: c.id, type: c.kind, position: { x: c.x, y: c.y }, width: c.width, data: { body: c.body } };
const toEdge = (e: StudyEdge): Edge => ({ id: e.id, source: e.source, target: e.target, type: "thread" });
/** Content as a save sends it, to tell whether an edit changed anything. */
const bodyOf = (c: CanvasContent): CanvasContent => ({
  title: c.title,
  cards: c.cards.map(({ id, kind, x, y, width, body, height }) => ({ id, kind, x, y, width, body, ...(height === undefined ? {} : { height }) })),
  edges: c.edges.map(({ id, source, target }) => ({ id, source, target })),
});

type CardCanvasProps = {
  /** As loaded; later changes come from the user or from `follow`. */
  content: CanvasContent;
  readOnly: boolean;
  save: (content: CanvasContent) => Promise<unknown>;
  /** Null when nobody else can write it. */
  follow: CanvasFollow | null;
  /** What the header shows before the title: the way back, a version. */
  lead: ReactNode;
  titleLabel: string;
  /** The page's header actions, after any save error. */
  acts: (controls: CanvasControls) => ReactNode;
  /** The ask bar, over the sheet's foot. */
  bar: ReactNode;
};

/**
 * Cards on a dotted sheet, saved whole a moment after each edit, with the page's own header above and
 * an opened card's page beside. A Study volume and a day book are both this canvas.
 */
export function CardCanvas(props: CardCanvasProps) {
  return (
    <ReactFlowProvider>
      <Sheet {...props} />
    </ReactFlowProvider>
  );
}

/** The tools a page puts in its header for an editable canvas. */
export function CanvasTools({ add }: { add: CanvasControls["add"] }) {
  const tools: [StudyCardKind, string][] = [
    ["ink", "+ Card"],
    ["text", "+ Text"],
    ["section", "+ Section"],
    ["question", "+ ?"],
  ];
  return tools.map(([kind, label]) => (
    <button key={kind} type="button" onClick={() => add(kind)}>
      {label}
    </button>
  ));
}

/** Where a node lies on the canvas, with the size it shows at (a card grows with its text). */
const boxOf = (n: CardNode) => ({ x: n.position.x, y: n.position.y, w: n.width ?? n.measured?.width ?? 0, h: n.height ?? n.measured?.height ?? 0 });

/** The nodes lying wholly inside a section's frame, where they are now. */
function insideOf(section: CardNode, nodes: CardNode[]): Map<string, XYPosition> {
  const s = boxOf(section);
  const inside = new Map<string, XYPosition>();
  for (const n of nodes) {
    const b = boxOf(n);
    if (n.id !== section.id && b.x >= s.x && b.y >= s.y && b.x + b.w <= s.x + s.w && b.y + b.h <= s.y + s.h) inside.set(n.id, n.position);
  }
  return inside;
}

/** A drag that carries what lay inside the dragged sections: where `lead` started, and each carried node. */
type Carry = { lead: string; from: XYPosition; carried: Map<string, XYPosition> };

function Sheet({ content, readOnly, save: write, follow, lead, titleLabel, acts, bar }: CardCanvasProps) {
  const rooms = useRoomsStore();
  const flow = useReactFlow();
  const [initial] = useState(content);
  const [nodes, setNodes, onNodesChangeBase] = useNodesState<CardNode>(initial.cards.map(toNode));
  const [edges, setEdges, onEdgesChangeBase] = useEdgesState<Edge>(initial.edges.map(toEdge));
  const [title, setTitle] = useState(initial.title);
  const [fresh, setFresh] = useState<string | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The save reads the latest of everything, whenever it fires.
  const latest = useRef({ nodes, edges, title });
  latest.current = { nodes, edges, title };
  const writeRef = useRef(write);
  writeRef.current = write;
  const followRef = useRef(follow);
  followRef.current = follow;
  /** Each written card's editors: on the canvas, and in the side panel while it is open. */
  const editors = useRef(new Map<string, Set<Editor>>());
  /** Cards typed in. The others keep their stored markdown byte for byte (TipTap would normalize it, and drop what it can't show). */
  const dirty = useRef(new Set<string>());
  const inflight = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const payload = useCallback((): CanvasContent => {
    const { nodes, edges, title } = latest.current;
    const typedBody = (id: string) => {
      if (!dirty.current.has(id)) return undefined;
      const [editor] = editors.current.get(id) ?? [];
      return editor && !editor.isDestroyed ? markdownOf(editor) : undefined;
    };
    const cards: StudyCard[] = nodes.map((n) => {
      const kind = n.type ?? "ink";
      return {
        id: n.id,
        kind,
        x: Math.round(n.position.x),
        y: Math.round(n.position.y),
        width: Math.round(n.width ?? SIZE[kind].width),
        body: typedBody(n.id) ?? n.data.body,
        ...(kind === "section" ? { height: Math.round(n.height ?? SIZE.section.height) } : {}),
      };
    });
    const ids = new Set(cards.map((c) => c.id));
    // An edge never outlives either of its cards, whatever order React Flow reported the removals in.
    const kept = edges.filter((e) => ids.has(e.source) && ids.has(e.target)).map((e) => ({ id: e.id, source: e.source, target: e.target }));
    return { title, cards, edges: kept };
  }, []);

  // What roomsd holds: a save that would write the same again is skipped (a click on a card reports a "move").
  const saved = useRef<string | null>(null);
  const save = useCallback((): Promise<unknown> => {
    const body = payload();
    const json = JSON.stringify(body);
    if (json === (saved.current ??= JSON.stringify(bodyOf(initial)))) return queue.current;
    saved.current = json;
    inflight.current++;
    queue.current = queue.current
      .then(() => writeRef.current(body))
      .then(
        () => setError(null),
        (e: unknown) => {
          // Unknown on disk now, unless a later save has taken over.
          if (saved.current === json) saved.current = "";
          setError(errorCopy(e));
        },
      )
      .finally(() => inflight.current--);
    return queue.current;
  }, [payload, initial]);

  /** Saves a pending change now; resolves once every save so far has landed. */
  const flush = useCallback((): Promise<unknown> => {
    // A failed save is tried again too, so leaving never drops it silently.
    if (timer.current === null && saved.current !== "") return queue.current;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    return save();
  }, [save]);

  const changed = useCallback(() => {
    if (readOnly) return;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void save();
    }, SAVE_DELAY_MS);
  }, [readOnly, save]);

  // Someone else wrote this canvas: show theirs, unless an edit of ours is still on its way, in which
  // case ours lands last and wins.
  const following = follow !== null;
  useEffect(() => {
    if (!following) return;
    return rooms.onSignal((type, e) => {
      const f = followRef.current;
      if (!f?.about(type, e)) return;
      const busy = () => timer.current !== null || inflight.current > 0;
      if (busy()) return;
      f.load().then(
        (c) => {
          if (!c || busy()) return;
          const json = JSON.stringify(bodyOf(c));
          if (json === (saved.current ?? JSON.stringify(bodyOf(initial)))) return;
          saved.current = json;
          dirty.current.clear();
          setNodes(c.cards.map(toNode));
          setEdges(c.edges.map(toEdge));
          setTitle(c.title);
        },
        (err: unknown) => console.warn("rooms: could not reload the canvas", err),
      );
    });
  }, [following, rooms, initial, setNodes, setEdges]);

  // Leaving the tab or the window saves what is pending at once.
  useEffect(() => {
    const now = () => void flush();
    window.addEventListener("blur", now);
    document.addEventListener("visibilitychange", now);
    return () => {
      window.removeEventListener("blur", now);
      document.removeEventListener("visibilitychange", now);
      void flush();
    };
  }, [flush]);

  // Dragging a section carries what lay wholly inside it when the drag started; nothing records it.
  const carry = useRef<Carry | null>(null);
  const onNodeDragStart = (_: unknown, node: CardNode, dragged: CardNode[]) => {
    const moving = new Set(dragged.map((n) => n.id));
    const carried = new Map<string, XYPosition>();
    for (const s of dragged) {
      if (s.type !== "section") continue;
      for (const [id, at] of insideOf(s, latest.current.nodes)) if (!moving.has(id)) carried.set(id, at);
    }
    carry.current = carried.size ? { lead: node.id, from: node.position, carried } : null;
  };
  const onNodeDragStop = () => {
    carry.current = null;
  };

  const onNodesChange = (changes: NodeChange<CardNode>[]) => {
    const c = carry.current;
    const moved = c && changes.find((ch) => ch.type === "position" && ch.id === c.lead && ch.position);
    if (c && moved?.type === "position" && moved.position) {
      const [dx, dy] = [moved.position.x - c.from.x, moved.position.y - c.from.y];
      const along = [...c.carried].map(([id, at]): NodeChange<CardNode> => ({ type: "position", id, position: { x: at.x + dx, y: at.y + dy }, dragging: moved.dragging }));
      changes = [...changes, ...along];
    }
    onNodesChangeBase(changes);
    // A resize reports `resizing`; React Flow measuring a node reports none and changes nothing saved.
    if (changes.some((ch) => ch.type === "position" || ch.type === "remove" || ch.type === "add" || (ch.type === "dimensions" && ch.resizing !== undefined))) changed();
  };
  const onEdgesChange = (changes: EdgeChange[]) => {
    onEdgesChangeBase(changes);
    if (changes.some((c) => c.type === "remove" || c.type === "add")) changed();
  };
  const onConnect = (c: Connection) => {
    if (c.source === c.target) return;
    setEdges((es) =>
      es.some((e) => (e.source === c.source && e.target === c.target) || (e.source === c.target && e.target === c.source))
        ? es
        : [...es, { id: newId(), source: c.source, target: c.target, type: "thread" }],
    );
    changed();
  };

  const add = (kind: StudyCardKind, at: XYPosition) => {
    const id = newId();
    const { width, height } = SIZE[kind];
    const card: StudyCard = { id, kind, x: Math.round(at.x), y: Math.round(at.y), width, body: "", ...(kind === "section" ? { height } : {}) };
    setNodes((ns) => [...ns.map((n) => (n.selected ? { ...n, selected: false } : n)), toNode(card)]);
    setFresh(id);
    changed();
  };
  const sheetRef = useRef<HTMLDivElement>(null);
  /** Where the tools put a new node: centred on the sheet, stepped so ones added in a row don't stack. */
  const middle = (kind: StudyCardKind) => {
    const r = sheetRef.current?.getBoundingClientRect();
    const step = (latest.current.nodes.length % 6) * 24;
    const mid = flow.screenToFlowPosition({ x: r ? r.left + r.width / 2 : 400, y: r ? r.top + r.height / 2 : 300 });
    return { x: mid.x - SIZE[kind].width / 2 + step, y: mid.y - SIZE[kind].height / 2 + step };
  };
  const onDoubleClick = (e: MouseEvent) => {
    if (readOnly || !(e.target instanceof Element) || !e.target.classList.contains("react-flow__pane")) return;
    const p = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    add("ink", { x: p.x - 20, y: p.y - 20 });
  };
  // A card's frame, outside its text, opens it beside the canvas.
  const onNodeDoubleClick = (e: MouseEvent, node: CardNode) => {
    if (isWritten(node.type) && !(e.target instanceof Element && e.target.closest(".ProseMirror"))) setOpened(node.id);
  };

  const controls: CanvasControls = {
    add: (kind) => add(kind, middle(kind)),
    flush,
    unsaved: () => saved.current === "",
    showError: (e) => setError(errorCopy(e)),
  };

  const attach = useCallback((id: string, editor: Editor) => {
    const set = editors.current.get(id) ?? new Set();
    editors.current.set(id, set.add(editor));
    return () => {
      set.delete(editor);
      if (set.size === 0) editors.current.delete(id);
    };
  }, []);
  // Stable apart from what it names, so typing in one card never re-renders the others.
  const canvas = useMemo<Canvas>(
    () => ({
      readOnly,
      fresh,
      opened,
      open: setOpened,
      setBody: (id, body) => {
        setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { body } } : n)));
        changed();
      },
      attach,
      typed: (id, from) => {
        dirty.current.add(id);
        for (const other of editors.current.get(id) ?? []) {
          if (other === from || other.isDestroyed) continue;
          other.chain().setMeta("addToHistory", false).setContent(from.getJSON(), { emitUpdate: false }).run();
        }
        changed();
      },
      live: (id) => {
        const [editor] = editors.current.get(id) ?? [];
        return editor && !editor.isDestroyed ? editor.getJSON() : null;
      },
    }),
    [readOnly, fresh, opened, changed, setNodes, attach],
  );

  // The opened card, while it is still on the canvas.
  const open = nodes.find((n) => n.id === opened);
  const openKind = open?.type;
  const close = useCallback(() => setOpened(null), []);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!opened) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || !(e.target instanceof Node)) return;
      const t = e.target;
      // Esc on the canvas or in the panel; the ask bar keeps its own.
      if (t !== document.body && !(wrap.current?.contains(t) && !(t instanceof Element && t.closest("[data-ask-bar]")))) return;
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [opened, close]);

  return (
    <div ref={wrap} className={readOnly ? "flex min-h-0 flex-1 flex-col st-readonly" : "flex min-h-0 flex-1 flex-col"}>
      <header className="st-vbar">
        {lead}
        <input
          className="st-title"
          aria-label={titleLabel}
          placeholder={readOnly ? "" : titleLabel}
          maxLength={200}
          value={title}
          readOnly={readOnly}
          onChange={(e) => {
            setTitle(e.target.value);
            changed();
          }}
          onBlur={() => void flush()}
        />
        <div className="st-acts">
          {error ? (
            <span role="alert" className="text-error">
              {error}
            </span>
          ) : null}
          {acts(controls)}
        </div>
      </header>
      <CanvasContext.Provider value={canvas}>
        <div className="st-stage">
          {/* Relative, with the sheet ending above the bottom, for the ask bar: it stays over the sheet, beside any panel. */}
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            <div ref={sheetRef} className="st-sheet" onDoubleClick={onDoubleClick}>
              <ReactFlow<CardNode, Edge>
                nodes={nodes}
                edges={edges}
                nodeTypes={NODE_TYPES}
                edgeTypes={EDGE_TYPES}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                onNodeDragStart={onNodeDragStart}
                onNodeDragStop={onNodeDragStop}
                onNodeDoubleClick={onNodeDoubleClick}
                connectionMode={ConnectionMode.Loose}
                nodesDraggable={!readOnly}
                nodesConnectable={!readOnly}
                elementsSelectable={!readOnly}
                edgesFocusable={!readOnly}
                deleteKeyCode={readOnly ? null : ["Backspace", "Delete"]}
                zoomOnDoubleClick={false}
                panOnScroll
                minZoom={0.3}
                maxZoom={1.6}
                fitView={initial.cards.length > 0}
                fitViewOptions={{ maxZoom: 1, padding: 0.2 }}
                defaultViewport={{ x: 40, y: 40, zoom: 1 }}
                proOptions={{ hideAttribution: true }}
              />
            </div>
            {bar}
          </div>
          {open && isWritten(openKind) ? <CardPanel key={open.id} id={open.id} kind={openKind} body={open.data.body} onClose={close} /> : null}
        </div>
      </CanvasContext.Provider>
    </div>
  );
}

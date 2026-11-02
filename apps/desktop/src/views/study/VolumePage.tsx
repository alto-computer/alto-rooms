import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { StudyCard, StudyCardKind, StudyEdge, StudyVolume } from "@alto-rooms/protocol-ts";
import {
  BaseEdge,
  ConnectionMode,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useInternalNode,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { useClient, useReadOnly, useRoomsStore, useStudy, useStudyStore, useViewerStore } from "@/data/hooks";
import { errorCopy } from "@/lib/errors";
import { dottedDate, newId, versionOf } from "./study";
import { useStudyGo } from "./StudyNav";

/** Edits wait this long for the next one before the volume is saved. */
export const SAVE_DELAY_MS = 600;
const WIDTH: Record<StudyCardKind, number> = { ink: 280, question: 240 };

type CardData = { body: string };
type CardNode = Node<CardData, StudyCardKind>;

/** What a card needs from its canvas. */
type Canvas = {
  readOnly: boolean;
  /** The card just added, which takes the caret. */
  fresh: string | null;
  changed: () => void;
  /** An ink card was typed in: from now on its body is read from its editor. */
  edited: (id: string) => void;
  /** An ink card's live body, read at save time; null when the card unmounts. */
  register: (id: string, read: (() => string) | null) => void;
  setBody: (id: string, body: string) => void;
};
const CanvasContext = createContext<Canvas | null>(null);
const useCanvas = () => useContext(CanvasContext)!;

const toNode = (c: StudyCard): CardNode => ({ id: c.id, type: c.kind, position: { x: c.x, y: c.y }, width: c.width, data: { body: c.body } });
const toEdge = (e: StudyEdge): Edge => ({ id: e.id, source: e.source, target: e.target, type: "thread" });
/** A volume as a save sends it, to tell whether an edit changed anything. */
const volumeBody = (v: StudyVolume) => ({
  title: v.title,
  cards: v.cards.map(({ id, kind, x, y, width, body }) => ({ id, kind, x, y, width, body })),
  edges: v.edges.map(({ id, source, target }) => ({ id, source, target })),
});

/** 판: a volume's cards on a dotted sheet. A draft saves itself; a published volume only reads. */
export function VolumePage({ roomId, number }: { roomId: string; number: number }) {
  const client = useClient();
  const [volume, setVolume] = useState<StudyVolume | "missing" | null>(null);
  useEffect(() => {
    let live = true;
    client.studyVolume(roomId, number).then(
      (v) => live && setVolume(v),
      (e: unknown) => {
        console.warn("rooms: could not load the volume", e);
        if (live) setVolume("missing");
      },
    );
    return () => {
      live = false;
    };
  }, [client, roomId, number]);

  if (volume === null) return null;
  if (volume === "missing") return <p className="st-lede st-sub p-16">없는 판이에요</p>;
  return (
    <ReactFlowProvider>
      <Sheet roomId={roomId} volume={volume} />
    </ReactFlowProvider>
  );
}

function Sheet({ roomId, volume }: { roomId: string; volume: StudyVolume }) {
  const client = useClient();
  const store = useStudyStore();
  const viewer = useViewerStore();
  const go = useStudyGo();
  const rooms = useRoomsStore();
  const appReadOnly = useReadOnly();
  const room = useStudy().rooms?.find((r) => r.id === roomId);
  const flow = useReactFlow();

  const [nodes, setNodes, onNodesChangeBase] = useNodesState<CardNode>(volume.cards.map(toNode));
  const [edges, setEdges, onEdgesChangeBase] = useEdgesState<Edge>(volume.edges.map(toEdge));
  const [title, setTitle] = useState(volume.title);
  const [fresh, setFresh] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const frozen = volume.status === "published" || appReadOnly;
  // Nothing changes while a publish is under way: an edit then would land on the frozen volume.
  const readOnly = frozen || publishing;

  // The save reads the latest of everything, whenever it fires.
  const latest = useRef({ nodes, edges, title });
  latest.current = { nodes, edges, title };
  const readers = useRef(new Map<string, () => string>());
  /** Ink cards typed in. The others keep their stored markdown byte for byte (TipTap would normalize it, and drop what it can't show). */
  const dirty = useRef(new Set<string>());
  const inflight = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const payload = useCallback(() => {
    const { nodes, edges, title } = latest.current;
    const cards: StudyCard[] = nodes.map((n) => ({
      id: n.id,
      kind: n.type ?? "ink",
      x: Math.round(n.position.x),
      y: Math.round(n.position.y),
      width: Math.round(n.width ?? WIDTH[n.type ?? "ink"]),
      body: (dirty.current.has(n.id) ? readers.current.get(n.id)?.() : undefined) ?? n.data.body,
    }));
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
    if (json === (saved.current ??= JSON.stringify(volumeBody(volume)))) return queue.current;
    saved.current = json;
    inflight.current++;
    queue.current = queue.current
      .then(() => client.saveStudyVolume(roomId, volume.number, body))
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
  }, [client, payload, roomId, volume]);

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

  // Someone else wrote this draft (an agent, another window): show theirs, unless an edit of ours is
  // still on its way, in which case ours lands last and wins.
  useEffect(() => {
    if (frozen) return;
    return rooms.onSignal((type, e) => {
      if (type !== "resync" && !(e.type === "study.changed" && e.roomId === roomId)) return;
      const busy = () => timer.current !== null || inflight.current > 0;
      if (busy()) return;
      client.studyVolume(roomId, volume.number).then(
        (v) => {
          const json = JSON.stringify(volumeBody(v));
          if (busy() || v.status !== "draft" || json === (saved.current ?? JSON.stringify(volumeBody(volume)))) return;
          saved.current = json;
          dirty.current.clear();
          setNodes(v.cards.map(toNode));
          setEdges(v.edges.map(toEdge));
          setTitle(v.title);
        },
        (err: unknown) => console.warn("rooms: could not reload the volume", err),
      );
    });
  }, [frozen, rooms, client, roomId, volume, setNodes, setEdges]);

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

  const onNodesChange = (changes: NodeChange<CardNode>[]) => {
    onNodesChangeBase(changes);
    if (changes.some((c) => c.type === "position" || c.type === "remove" || c.type === "add")) changed();
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

  const add = (kind: StudyCardKind, at: { x: number; y: number }) => {
    const id = newId();
    const card: StudyCard = { id, kind, x: Math.round(at.x), y: Math.round(at.y), width: WIDTH[kind], body: "" };
    setNodes((ns) => [...ns.map((n) => (n.selected ? { ...n, selected: false } : n)), toNode(card)]);
    setFresh(id);
    changed();
  };
  const sheetRef = useRef<HTMLDivElement>(null);
  /** Where the toolbar puts a new card: the middle of the sheet, stepped so cards added in a row don't stack. */
  const middle = () => {
    const r = sheetRef.current?.getBoundingClientRect();
    const step = (latest.current.nodes.length % 6) * 24;
    return flow.screenToFlowPosition({ x: (r ? r.left + r.width / 2 : 400) - 140 + step, y: (r ? r.top + r.height / 2 : 300) - 60 + step });
  };
  const onDoubleClick = (e: MouseEvent) => {
    if (readOnly || !(e.target instanceof Element) || !e.target.classList.contains("react-flow__pane")) return;
    const p = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    add("ink", { x: p.x - 20, y: p.y - 20 });
  };

  const publish = async () => {
    setPublishing(true);
    try {
      await flush();
      // Publish only what roomsd holds: a save that just failed leaves the error showing instead.
      if (saved.current === "") throw new Error("unsaved");
      const summary = await client.publishStudyRoom(roomId);
      void store.refresh();
      const draft = summary.volumes.at(-1);
      if (draft) viewer.navigate({ kind: "study", page: "volume", roomId, number: draft.number });
    } catch (e) {
      if (saved.current !== "") setError(errorCopy(e));
      setPublishing(false);
      setConfirming(false);
    }
  };

  // Stable, so typing in one card never re-renders the others.
  const canvas = useMemo<Canvas>(
    () => ({
      readOnly,
      fresh,
      changed,
      edited: (id) => {
        dirty.current.add(id);
        changed();
      },
      register: (id, read) => {
        if (read) readers.current.set(id, read);
        else readers.current.delete(id);
      },
      setBody: (id, body) => {
        setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { body } } : n)));
        changed();
      },
    }),
    [readOnly, fresh, changed, setNodes],
  );

  const version = `v${versionOf(volume.number)}`;
  return (
    // Relative, with the sheet ending above the bottom, for the ask bar the volume will get.
    <div className={readOnly ? "relative flex min-h-0 flex-1 flex-col st-readonly" : "relative flex min-h-0 flex-1 flex-col"}>
      <header className="st-vbar">
        <button type="button" className="st-backlink" onClick={(e) => go({ page: "room", roomId }, e)}>
          ← {room?.name ?? "서재"}
        </button>
        <span className="st-ver">{version}</span>
        <input
          className="st-title"
          aria-label="부제"
          placeholder={readOnly ? "" : "부제"}
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
          {volume.status === "published" ? (
            <span className="st-date">{dottedDate(volume.publishedAt)}</span>
          ) : frozen ? null : confirming ? (
            <>
              <span>{version}을 발행하면 고칠 수 없어요</span>
              <button type="button" onClick={() => setConfirming(false)} disabled={publishing}>
                취소
              </button>
              <button type="button" className="st-pub" onClick={() => void publish()} disabled={publishing}>
                발행하기
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={() => add("ink", middle())}>
                + 카드
              </button>
              <button type="button" onClick={() => add("question", middle())}>
                + ?
              </button>
              <button type="button" className="st-pub" onClick={() => setConfirming(true)}>
                발행
              </button>
            </>
          )}
        </div>
      </header>
      <div ref={sheetRef} className="st-sheet" onDoubleClick={onDoubleClick}>
        <CanvasContext.Provider value={canvas}>
          <ReactFlow<CardNode, Edge>
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
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
            fitView={volume.cards.length > 0}
            fitViewOptions={{ maxZoom: 1, padding: 0.2 }}
            defaultViewport={{ x: 40, y: 40, zoom: 1 }}
            proOptions={{ hideAttribution: true }}
          />
        </CanvasContext.Provider>
      </div>
    </div>
  );
}

/**
 * Puts the caret in a card just added, once React Flow shows it: a new node stays hidden until it is
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

/** An ink card: markdown typed in place. The frame drags the card; the text inside never does. */
function InkCard({ id, data, width }: NodeProps<CardNode>) {
  const { readOnly, edited, register } = useCanvas();
  const onEdit = useRef(edited);
  onEdit.current = edited;
  const editor = useEditor({
    extensions: [StarterKit, Markdown],
    content: data.body,
    contentType: "markdown",
    injectCSS: false,
    editable: !readOnly,
    shouldRerenderOnTransaction: false,
    editorProps: { attributes: { class: "nodrag nowheel nopan nokey", "aria-label": "카드" } },
    onUpdate: () => onEdit.current(id),
  });
  useEffect(() => {
    // The empty paragraph TipTap keeps after the last block is not part of what was written.
    register(id, () => editor.getMarkdown().trimEnd());
    return () => register(id, null);
  }, [editor, id, register]);
  useEffect(() => editor.setEditable(!readOnly, false), [editor, readOnly]);
  // A body replaced from outside (the volume reloaded) goes into the editor; typing never changes data.body.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    editor.commands.setContent(data.body, { contentType: "markdown", emitUpdate: false });
  }, [editor, data.body]);
  useFocusWhenShown(id, () => !editor.isDestroyed && editor.commands.focus("end"));
  return (
    <div className="st-card" style={{ width }} data-testid="ink-card">
      <Handle type="source" position={Position.Left} id="l" />
      <EditorContent editor={editor} />
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
      <Handle type="source" position={Position.Left} id="l" />
      <b aria-hidden>?</b>
      <input
        className="nodrag nopan nokey"
        aria-label="질문"
        value={data.body}
        readOnly={readOnly}
        ref={input}
        onChange={(e) => setBody(id, e.target.value.replace(/\n/g, " "))}
      />
      <Handle type="source" position={Position.Right} id="r" />
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

const NODE_TYPES = { ink: InkCard, question: QuestionCard };
const EDGE_TYPES = { thread: Thread };

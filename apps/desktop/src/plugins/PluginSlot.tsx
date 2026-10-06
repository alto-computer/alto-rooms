/*
 * The places plugins can appear. The shell only puts a <PluginSlot> where a
 * slot belongs; which plugins show, the side panel's toggle, open state and
 * width, and the frames themselves are all decided here.
 */
import type { Artifact } from "@alto-rooms/protocol-ts";
import { Pencil, X } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { usePlugins, usePluginsStore, useRooms, useViewer, useViewerStore } from "@/data/hooks";
import { cn } from "@/lib/utils";
import { CLOSE_CAP_MS, PluginFrame, type PluginFrameHandle } from "./PluginFrame";
import type { HostPlugin, PluginsStore } from "./pluginsStore";

type Props =
  { slot: "artifact.sidePanel"; context: { artifact: Artifact } } | { slot: "tab"; pluginId: string; context: Record<string, never> };

export function PluginSlot(props: Props) {
  return props.slot === "tab" ? <PluginTab pluginId={props.pluginId} /> : <SidePanel artifact={props.context.artifact} />;
}

function Message({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 items-center justify-center p-12 text-center text-[17px] text-ink-2">{children}</div>;
}

/**
 * The plugin a slot was running, kept on screen while it closes after it may no
 * longer run (new permissions, broken manifest, turned off): its frame gets
 * beforeClose, then goes. A deleted plugin has nothing left to save and goes at once.
 */
function useRetiring(store: PluginsStore, list: HostPlugin[], showing: HostPlugin | undefined, live = true) {
  const last = useRef<string | null>(null);
  const [closed, setClosed] = useState<string | null>(null);
  useEffect(() => {
    if (showing) {
      last.current = showing.id;
      setClosed(null);
    } else if (!live) {
      // No frame is mounted, so there is nothing left to close.
      last.current = null;
    }
  }, [showing, live]);
  const prev = live && !showing && last.current ? list.find((p) => p.id === last.current) : undefined;
  const retiring = prev && !store.usable(prev) && closed !== prev.id ? prev : undefined;
  const done = () => {
    if (!retiring) return;
    last.current = null;
    setClosed(retiring.id);
  };
  return { retiring, done };
}

function PluginTab({ pluginId }: { pluginId: string }) {
  const { list, loaded } = usePlugins();
  const store = usePluginsStore();
  const { info } = useRooms();
  const p = list.find((x) => x.id === pluginId && x.slots.tab);
  const usable = p && store.usable(p) ? p : undefined;
  const { retiring, done } = useRetiring(store, list, usable);
  if (!loaded || !info) return <div className="flex-1" />;
  const running = usable ?? retiring;
  if (running) {
    return (
      <div className="flex min-h-0 flex-1">
        <PluginFrame plugin={running} info={info} context={{ slot: "tab" }} active={running === usable} onClosed={done} />
      </div>
    );
  }
  if (!p) return <Message>Missing plugin</Message>;
  if (p.status !== "ok" || !p.compatible) return <Message>This plugin can't load</Message>;
  return <Message>This plugin is off</Message>;
}

const MIN_WIDTH = 240;
const MAX_WIDTH = 1200;

function SidePanel({ artifact }: { artifact: Artifact }) {
  const { list } = usePlugins();
  const store = usePluginsStore();
  const { info } = useRooms();
  const { pluginPanel: panel } = useViewer();
  const viewer = useViewerStore();
  const frame = useRef<PluginFrameHandle>(null);
  const closing = useRef(false);
  const panelElement = useRef<HTMLElement>(null);
  const cancelResize = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelResize.current?.(), [panel.open]);

  const candidates = list.filter((p) => p.slots.artifactSidePanel && store.usable(p));
  const usable = candidates.find((p) => p.id === panel.pluginId) ?? candidates[0];
  const { retiring, done } = useRetiring(store, list, panel.open ? usable : undefined, panel.open);
  const current = usable ?? retiring;
  if (!current || !info) return null;
  const title = current.slots.artifactSidePanel!.title;

  if (!panel.open) {
    return (
      <button
        type="button"
        aria-label={`Open ${title}`}
        onClick={() => viewer.setPluginPanel({ open: true, pluginId: current.id })}
        className="absolute top-3 right-3 z-10 flex h-8 items-center gap-1.5 rounded-lg border border-[#ddd] bg-white/95 px-2.5 text-[13px] text-ink shadow-float hover:bg-white focus-visible:outline-2 focus-visible:outline-ink"
      >
        <Pencil size={14} aria-hidden />
        {title}
      </button>
    );
  }

  const close = async () => {
    if (closing.current) return;
    closing.current = true;
    await frame.current?.beforeClose(CLOSE_CAP_MS);
    closing.current = false;
    viewer.setPluginPanel({ open: false });
  };

  const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    cancelResize.current?.();
    const handle = e.currentTarget;
    const element = panelElement.current!;
    const pointerId = e.pointerId;
    const startX = e.clientX;
    const startWidth = panel.width;
    let width = startWidth;
    let raf = 0;
    let ended = false;
    const previousSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    const measure = (x: number) => Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + startX - x)));
    const apply = () => {
      raf = 0;
      element.style.width = `${width}px`;
    };
    const finish = (commit: boolean) => {
      if (ended) return;
      ended = true;
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", abort);
      handle.removeEventListener("lostpointercapture", cancel);
      document.body.style.userSelect = previousSelect;
      cancelResize.current = null;
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      element.style.width = `${commit ? width : startWidth}px`;
      if (commit && width !== startWidth) viewer.setPluginPanel({ width });
    };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      width = measure(ev.clientX);
      raf ||= requestAnimationFrame(apply);
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      width = measure(ev.clientX);
      finish(true);
    };
    const cancel = (ev: PointerEvent) => { if (ev.pointerId === pointerId) finish(false); };
    const abort = () => finish(false);
    handle.setPointerCapture(pointerId);
    cancelResize.current = abort;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", abort);
    handle.addEventListener("lostpointercapture", cancel);
  };

  return (
    <aside ref={panelElement} aria-label={title} className="relative flex shrink-0 flex-col border-l border-[#ddd] bg-white" style={{ width: panel.width }}>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        onPointerDown={startResize}
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none"
      />
      <header className="flex h-10 shrink-0 items-center gap-1 border-b border-[#ddd] px-2 text-[13px]">
        {candidates.length > 1 ? (
          <div role="tablist" aria-label="Panel plugins" className="flex min-w-0 gap-1">
            {candidates.map((p) => (
              <button
                key={p.id}
                type="button"
                role="tab"
                aria-selected={p.id === current.id}
                onClick={() => viewer.setPluginPanel({ pluginId: p.id })}
                className={cn("truncate rounded-md px-2 py-1", p.id === current.id ? "bg-[#f2f2f2] text-ink" : "text-ink-2 hover:text-ink")}
              >
                {p.slots.artifactSidePanel!.title}
              </button>
            ))}
          </div>
        ) : (
          <span className="truncate px-1 font-medium text-ink">{title}</span>
        )}
        <button
          type="button"
          aria-label={`Close ${title}`}
          onClick={() => void close()}
          className="ml-auto grid size-7 place-items-center rounded-md text-ink-2 hover:bg-[#f2f2f2] hover:text-ink focus-visible:outline-2 focus-visible:outline-ink"
        >
          <X size={15} aria-hidden />
        </button>
      </header>
      <PluginFrame
        key={current.id}
        ref={frame}
        plugin={current}
        info={info}
        active={current === usable}
        onClosed={done}
        context={{
          slot: "artifact.sidePanel",
          artifact: {
            roomId: artifact.roomId,
            artifactId: artifact.id,
            fileKey: artifact.fileKey,
            title: artifact.title,
            createdAt: artifact.createdAt,
          },
        }}
      />
    </aside>
  );
}

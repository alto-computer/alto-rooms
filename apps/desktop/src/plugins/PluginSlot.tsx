/*
 * The places plugins can appear. The shell only puts a <PluginSlot> where a
 * slot belongs; which plugins show, the side panel's toggle, open state and
 * width, and the frames themselves are all decided here.
 */
import type { Artifact } from "@alto-rooms/protocol-ts";
import { Pencil, X } from "lucide-react";
import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { usePlugins, usePluginsStore, useRooms, useViewer, useViewerStore } from "@/data/hooks";
import { cn } from "@/lib/utils";
import { CLOSE_CAP_MS, PluginFrame, type PluginFrameHandle } from "./PluginFrame";

type Props =
  { slot: "artifact.sidePanel"; context: { artifact: Artifact } } | { slot: "tab"; pluginId: string; context: Record<string, never> };

export function PluginSlot(props: Props) {
  return props.slot === "tab" ? <PluginTab pluginId={props.pluginId} /> : <SidePanel artifact={props.context.artifact} />;
}

function Message({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 items-center justify-center p-12 text-center text-[17px] text-ink-2">{children}</div>;
}

function PluginTab({ pluginId }: { pluginId: string }) {
  const { list, loaded } = usePlugins();
  const store = usePluginsStore();
  const { info } = useRooms();
  if (!loaded || !info) return <div className="flex-1" />;
  const p = list.find((x) => x.id === pluginId && x.slots.tab);
  if (!p) return <Message>Missing plugin</Message>;
  if (p.status !== "ok" || !p.compatible) return <Message>This plugin can't load</Message>;
  if (!store.usable(p)) return <Message>This plugin is off</Message>;
  return (
    <div className="flex min-h-0 flex-1">
      <PluginFrame plugin={p} info={info} context={{ slot: "tab" }} />
    </div>
  );
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

  const candidates = list.filter((p) => p.slots.artifactSidePanel && store.usable(p));
  const current = candidates.find((p) => p.id === panel.pluginId) ?? candidates[0];
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
    const startX = e.clientX;
    const startWidth = panel.width;
    const move = (ev: PointerEvent) => {
      const w = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + (startX - ev.clientX)));
      viewer.setPluginPanel({ width: w });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <aside aria-label={title} className="relative flex shrink-0 flex-col border-l border-[#ddd] bg-white" style={{ width: panel.width }}>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        onPointerDown={startResize}
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize"
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

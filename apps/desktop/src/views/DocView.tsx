import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { Artifact, Info, Room } from "@alto-rooms/protocol-ts";
import { BookOpen, ChevronRight, Folder, Inbox } from "lucide-react";
import { useArtifacts, useAsksStore, useClient, useInfo, usePlugins, useReadOnly, useRoomList, useScopeError, useViewerStore } from "@/data/hooks";
import { dimsInDark, useFrameTone } from "@/lib/docTone";
import { INBOX_ID } from "@/lib/drag";
import { GENERIC_ERROR } from "@/lib/errors";
import { wantsNewTab } from "@/lib/nav";
import { cn } from "@/lib/utils";
import { PluginSlot, SidePanelOpener } from "@/plugins/PluginSlot";
import { contentKey } from "@/plugins/pluginsStore";
import { ToolbarGroup } from "@/components/ToolbarGroup";
import { useTabVisible } from "@/shell/currentTab";
import { AskBar } from "@/ask/AskBar";
import { readSelectionMessage, SelectionAsk, type SelectionRect } from "@/ask/SelectionAsk";
import { DocSkeleton } from "./DocSkeleton";
import { ShareMenu } from "./ShareMenu";

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 items-center justify-center bg-pane p-12 text-center text-heading text-ink-2">{children}</div>;
}

/** Where the artifact lives › its title. The room opens on click (the Journal's day has no room tab). */
function Breadcrumb({ artifact, room, info }: { artifact: Artifact; room: Room | undefined; info: Info }) {
  const viewer = useViewerStore();
  const journal = artifact.roomId === info.journalRoomId;
  const inbox = artifact.roomId === INBOX_ID;
  const Mark = journal ? BookOpen : inbox ? Inbox : Folder;
  const name = journal ? "Journal" : inbox ? "Inbox" : (room?.name ?? "Room");
  const place = (
    <>
      <Mark size={14} className="shrink-0 text-ink-3" aria-hidden />
      <span className="truncate">{name}</span>
    </>
  );
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-[7px] text-body whitespace-nowrap text-ink-2">
      {journal ? (
        <span className="flex min-w-0 items-center gap-[7px]">{place}</span>
      ) : (
        <button
          type="button"
          onClick={(e) => viewer.go({ kind: "room", roomId: artifact.roomId }, wantsNewTab(e))}
          className="-mx-1.5 flex min-w-0 items-center gap-[7px] rounded-md px-1.5 py-0.5 outline-none hover:bg-row-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-ink"
        >
          {place}
        </button>
      )}
      <ChevronRight size={12} className="shrink-0 text-ink-3" aria-hidden />
      <span aria-current="page" className="truncate font-semibold text-ink">
        {artifact.title}
      </span>
    </nav>
  );
}

/**
 * A doc tab: a toolbar (breadcrumb, Share, the plugin opener) over one artifact on a sheet, in a
 * sandboxed iframe from the files origin. In dark mode the page is dimmed unless it reported a
 * dark background itself. Ask answers dock in a column beside it. Watches the artifact's room so
 * a removal shows the "gone" copy.
 */
export function DocView({ roomId, artifactId }: { roomId: string; artifactId: string }) {
  const info = useInfo();
  const rooms = useRoomList();
  const client = useClient();
  const [loaded, setLoaded] = useState(false);
  const artifacts = useArtifacts(roomId);
  const loadError = useScopeError(`room:${roomId}`);
  const visible = useTabVisible();
  const frame = useRef<HTMLIFrameElement>(null);
  const selection = useDocSelection(frame);
  const tone = useFrameTone(frame);
  const asks = useAsksStore();
  const readOnly = useReadOnly();
  const plugins = usePlugins();

  // The store forgets a removed room's artifacts; its documents are gone too.
  const roomGone = info !== null && roomId !== info.journalRoomId && !rooms.some((r) => r.id === roomId);
  if (roomGone) return <Centered>This artifact is gone</Centered>;
  if (artifacts === undefined) {
    return loadError ? <Centered>{GENERIC_ERROR}</Centered> : <div className="flex-1 bg-pane" />;
  }
  const artifact = artifacts.find((a) => a.id === artifactId);
  if (!artifact) return <Centered>This artifact is gone</Centered>;
  if (!info) return <div className="flex-1 bg-pane" />;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-pane">
      <header className="flex h-[52px] shrink-0 items-center gap-3 pr-4 pl-5">
        <Breadcrumb artifact={artifact} room={rooms.find((r) => r.id === roomId)} info={info} />
        <ToolbarGroup label="Artifact actions">
          <ShareMenu artifact={artifact} />
          {visible ? <SidePanelOpener /> : null}
        </ToolbarGroup>
      </header>
      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1 px-4 pb-4">
          <div className="relative min-w-0 flex-1 overflow-hidden rounded-xl bg-white shadow-sheet">
            {/* No allow-same-origin: a doc is agent-written HTML and must never reach the app. What
                it shares comes out by postMessage only: the selection and tone bridge roomsd splices in, and
                the content scripts of the plugins the user turned on, which the doc variant adds. */}
            <iframe
              title={artifact.title}
              ref={frame}
              src={client.fileUrl(info, artifact, { contentKey: contentKey(plugins.list) })}
              sandbox="allow-scripts allow-popups"
              onLoad={() => setLoaded(true)}
              className={cn(
                "absolute inset-0 size-full border-0 bg-white transition-opacity duration-300 ease-out motion-reduce:transition-none",
                loaded ? "opacity-100" : "opacity-0",
                dimsInDark(tone) && "[filter:var(--doc-filter)]",
              )}
            />
            {loaded ? null : <DocSkeleton />}
            {selection.current && !readOnly ? (
              <SelectionAsk
                rect={selection.current.rect}
                onAsk={() => {
                  asks.addQuote({ kind: "doc", fileKey: artifact.fileKey }, selection.current!.text);
                  selection.dismiss();
                }}
              />
            ) : null}
          </div>
          <AskBar artifact={artifact} />
        </div>
        {/* A plugin frame treats a hidden tab as closed (its effects end), so it only lives in the visible one. */}
        {visible ? <PluginSlot slot="artifact.sidePanel" context={{ artifact }} /> : null}
      </div>
    </div>
  );
}

/** Text selected in the doc frame, as its selection bridge reports it; `dismiss` hides the button until the next selection. */
function useDocSelection(frame: RefObject<HTMLIFrameElement | null>) {
  const [current, setCurrent] = useState<{ text: string; rect: SelectionRect } | null>(null);
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      // Only this tab's own frame: other docs and plugins post messages too.
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const m = readSelectionMessage(e.data);
      if (m) setCurrent(m.text && m.rect ? { text: m.text, rect: m.rect } : null);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [frame]);
  return { current, dismiss: () => setCurrent(null) };
}

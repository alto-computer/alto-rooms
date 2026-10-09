import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { scopeKey } from "@alto-rooms/protocol-ts";
import { useArtifacts, useAsksStore, useClient, useInfo, useReadOnly, useRoomList, useScopeError } from "@/data/hooks";
import { GENERIC_ERROR } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { PluginSlot, SidePanelOpener } from "@/plugins/PluginSlot";
import { ToolbarGroup } from "@/components/ToolbarGroup";
import { useTabVisible } from "@/shell/currentTab";
import { AskBar } from "@/ask/AskBar";
import { readSelectionMessage, SelectionAsk, type SelectionRect } from "@/ask/SelectionAsk";
import { DocSkeleton } from "./DocSkeleton";
import { ShareMenu } from "./ShareMenu";

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 items-center justify-center bg-white p-12 text-center text-[17px] text-ink-2">{children}</div>;
}

/**
 * A doc tab: one artifact, full size, in a sandboxed iframe from the files
 * origin. Watches the artifact's room so a removal shows the "gone" copy.
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
  const asks = useAsksStore();
  const readOnly = useReadOnly();

  // The store forgets a removed room's artifacts; its documents are gone too.
  const roomGone = info !== null && roomId !== info.journalRoomId && !rooms.some((r) => r.id === roomId);
  if (roomGone) return <Centered>This doc is gone</Centered>;
  if (artifacts === undefined) {
    return loadError ? <Centered>{GENERIC_ERROR}</Centered> : <div className="flex-1 bg-white" />;
  }
  const artifact = artifacts.find((a) => a.id === artifactId);
  if (!artifact) return <Centered>This doc is gone</Centered>;
  if (!info) return <div className="flex-1 bg-white" />;

  return (
    <div className="relative flex min-h-0 flex-1 bg-white">
      <div className="relative min-w-0 flex-1">
        {/* No allow-same-origin: a doc is agent-written HTML and must never reach the app. What
            it shares comes out by postMessage only: the selection bridge roomsd appends. */}
        <iframe
          title={artifact.title}
          ref={frame}
          src={client.fileUrl(info, artifact)}
          sandbox="allow-scripts allow-popups"
          onLoad={() => setLoaded(true)}
          className={cn("absolute inset-0 size-full border-0 bg-white transition-opacity duration-300 ease-out motion-reduce:transition-none", loaded ? "opacity-100" : "opacity-0")}
        />
        {loaded ? null : <DocSkeleton />}
        {selection.current && !readOnly ? (
          <SelectionAsk
            rect={selection.current.rect}
            onAsk={() => {
              asks.addQuote(scopeKey({ kind: "doc", fileKey: artifact.fileKey }), selection.current!.text);
              selection.dismiss();
            }}
          />
        ) : null}
        <AskBar artifact={artifact} />
        <ToolbarGroup label="Document actions">
          <ShareMenu artifact={artifact} />
          {visible ? <SidePanelOpener /> : null}
        </ToolbarGroup>
      </div>
      {/* A plugin frame treats a hidden tab as closed (its effects end), so it only lives in the visible one. */}
      {visible ? <PluginSlot slot="artifact.sidePanel" context={{ artifact }} /> : null}
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

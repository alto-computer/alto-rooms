import { useState, type ReactNode } from "react";
import { useArtifacts, useClient, useRooms, useScopeError } from "@/data/hooks";
import { GENERIC_ERROR } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { PluginSlot } from "@/plugins/PluginSlot";
import { AskBar } from "@/ask/AskBar";
import { DocSkeleton } from "./DocSkeleton";

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 items-center justify-center bg-white p-12 text-center text-[17px] text-ink-2">{children}</div>;
}

/**
 * A doc tab: one artifact, full size, in a sandboxed iframe from the files
 * origin. Watches the artifact's room so a removal shows the "gone" copy.
 */
export function DocView({ roomId, artifactId }: { roomId: string; artifactId: string }) {
  const { info, rooms } = useRooms();
  const client = useClient();
  const [loaded, setLoaded] = useState(false);
  const artifacts = useArtifacts(roomId);
  const loadError = useScopeError(`room:${roomId}`);

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
        <iframe
          title={artifact.title}
          src={client.fileUrl(info, artifact)}
          sandbox="allow-scripts allow-popups"
          onLoad={() => setLoaded(true)}
          className={cn("absolute inset-0 size-full border-0 bg-white transition-opacity duration-300 ease-out motion-reduce:transition-none", loaded ? "opacity-100" : "opacity-0")}
        />
        {loaded ? null : <DocSkeleton />}
        <AskBar artifact={artifact} />
      </div>
      <PluginSlot slot="artifact.sidePanel" context={{ artifact }} />
    </div>
  );
}

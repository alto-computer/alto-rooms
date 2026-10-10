/*
 * The hidden frame of each plugin that holds `surfaces.text`: its manifest's background page,
 * loaded like a tab or panel frame (same origin, sandbox and bridge), kept off screen for as long
 * as the plugin is on. It hears every host text surface through the surface hub and answers with
 * paint and buttons; the hub trusts only messages from this frame's window.
 */
import { useEffect, useRef } from "react";
import { useInfo, usePlugins } from "@/data/hooks";
import { surfaceHub } from "@/surfaces/surfaceHub";
import { PluginFrame, type PluginFrameHandle } from "./PluginFrame";
import { surfacePlugins, type HostPlugin } from "./pluginsStore";

export function BackgroundFrames() {
  const { list } = usePlugins();
  const info = useInfo();
  if (!info) return null;
  return (
    <div hidden data-background-frames>
      {surfacePlugins(list).map((p) => (
        <BackgroundFrame key={p.id} plugin={p} />
      ))}
    </div>
  );
}

function BackgroundFrame({ plugin }: { plugin: HostPlugin }) {
  const info = useInfo()!;
  const frame = useRef<PluginFrameHandle>(null);
  useEffect(() => {
    const seat = surfaceHub.register(plugin.id, (m) => frame.current?.window()?.postMessage(m, "*"));
    const onMessage = (e: MessageEvent) => {
      const win = frame.current?.window();
      if (win && e.source === win) seat.receive(e.data);
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      seat.dispose();
    };
  }, [plugin.id]);
  return <PluginFrame ref={frame} plugin={{ ...plugin, entry: plugin.background! }} info={info} context={{ slot: "background" }} />;
}

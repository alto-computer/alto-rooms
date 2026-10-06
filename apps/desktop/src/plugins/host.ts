/*
 * Live plugin frames, so the app can ask every open plugin to save before it
 * quits. At most one frame per plugin is mounted at a time (only the active
 * tab is), so the registry is keyed by nothing more than the frame itself.
 */
export type LiveFrame = { pluginId: string; beforeClose(capMs: number): Promise<void> };

const frames = new Set<LiveFrame>();

export function registerFrame(f: LiveFrame): () => void {
  frames.add(f);
  return () => void frames.delete(f);
}

/** Sends beforeClose to every open frame and resolves when all ack or `capMs` passes. */
export async function flushAllPlugins(capMs: number): Promise<void> {
  await Promise.allSettled([...frames].map((f) => f.beforeClose(capMs)));
}

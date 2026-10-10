/*
 * Live plugin frames, so the app can ask every open plugin to save before it
 * quits. A plugin has at most one slot frame mounted at a time (only the active
 * tab is) and one background frame, so the registry is a set of the frames themselves.
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

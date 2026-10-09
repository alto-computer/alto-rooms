/*
 * Plugin data writes made through the app (a plugin frame's bridge or a
 * document's content channel), so other frames of the same plugin can hear
 * about them. `from` is the writer's window: it gets no echo of its own write.
 */

export type PluginDataChange = { pluginId: string; path: string; from: MessageEventSource | null };
type Listener = (c: PluginDataChange) => void;

const listeners = new Set<Listener>();

export const pluginDataBus = {
  publish(c: PluginDataChange): void {
    for (const l of [...listeners]) l(c);
  },
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
};

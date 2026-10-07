/*
 * The plugin list as the app sees it: roomsd's list plus whether this app
 * version can run each plugin. Lists again when roomsd says plugins changed or
 * the event stream resyncs. Also remembers which enable cards were dismissed
 * ("Not now") for the life of this app run.
 */
import type { PluginInfo, RoomsEvent } from "@alto-rooms/protocol-ts";

export type HostPlugin = PluginInfo & { compatible: boolean };
export type PluginsState = { list: HostPlugin[]; dismissed: ReadonlySet<string>; loaded: boolean };

type Client = {
  listPlugins(): Promise<PluginInfo[]>;
  setPluginEnabled(id: string, enabled: boolean, permissions?: string[]): Promise<PluginInfo>;
};
type Signals = { onSignal(fn: (type: RoomsEvent["type"], e: RoomsEvent) => void): () => void };

const core = (v: string) => v.split(/[-+]/)[0].split(".").map(Number);

/** `app >= min`, comparing the semver cores. */
export function compatible(app: string, min: string): boolean {
  const [a, m] = [core(app), core(min)];
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (m[i] ?? 0)) return (a[i] ?? 0) > (m[i] ?? 0);
  }
  return true;
}

export class PluginsStore {
  private state: PluginsState = { list: [], dismissed: new Set(), loaded: false };
  private listeners = new Set<() => void>();
  private stopSignals: (() => void) | null = null;
  private gen = 0;

  constructor(
    private readonly client: Client | undefined,
    private readonly rooms: Signals,
    private readonly appVersion: string,
  ) {}

  getState = (): PluginsState => this.state;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };

  start(): void {
    if (this.stopSignals || !this.client) return;
    this.stopSignals = this.rooms.onSignal((type) => {
      if (type === "plugins.changed" || type === "resync") void this.refresh();
    });
    void this.refresh();
  }

  stop(): void {
    this.stopSignals?.();
    this.stopSignals = null;
  }

  async refresh(): Promise<void> {
    if (!this.client) return;
    const gen = ++this.gen;
    try {
      const list = await this.client.listPlugins();
      if (gen !== this.gen) return;
      this.set({ list: list.map((p) => ({ ...p, compatible: compatible(this.appVersion, p.minAppVersion) })), loaded: true });
    } catch (e) {
      console.warn("rooms: could not list plugins", e);
    }
  }

  /** On: grant `permissions` (what the user was shown). Off: stop it, keeping its approval. */
  async setEnabled(id: string, enabled: boolean, permissions?: string[]): Promise<void> {
    if (!this.client) return;
    await this.client.setPluginEnabled(id, enabled, permissions);
    await this.refresh();
  }

  /** Valid, runnable here, turned on, and every declared permission granted. */
  usable(p: HostPlugin): boolean {
    return p.status === "ok" && p.compatible && p.enabled && !p.needsApproval;
  }

  /** The plugin the enable card asks about next (by id), or null. */
  nextToApprove(): HostPlugin | null {
    const waiting = this.state.list.filter((p) => p.status === "ok" && p.compatible && p.needsApproval && !this.state.dismissed.has(p.id));
    return waiting.sort((a, b) => (a.id < b.id ? -1 : 1))[0] ?? null;
  }

  /** "Not now": stop asking about `id` until the app restarts. */
  dismiss(id: string): void {
    this.set({ dismissed: new Set([...this.state.dismissed, id]) });
  }

  private set(p: Partial<PluginsState>) {
    this.state = { ...this.state, ...p };
    for (const l of [...this.listeners]) l();
  }
}

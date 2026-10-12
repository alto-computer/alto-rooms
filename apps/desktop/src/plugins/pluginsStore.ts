/*
 * The plugin list as the app sees it: roomsd's list plus whether this app
 * version can run each plugin. Lists again when roomsd says plugins changed or
 * the event stream resyncs. Also remembers, for the life of this app run, which
 * enable cards were dismissed ("Not now") and which plugin pages apply the
 * app's theme, so their next frame starts on the pane colour instead of white.
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

/** Valid, runnable here, turned on, and every declared permission granted. */
export const usable = (p: HostPlugin): boolean => p.status === "ok" && p.compatible && p.enabled && !p.needsApproval;

/** The usable plugins that run content scripts inside documents, in id order as roomsd injects them. */
export const contentPlugins = (list: HostPlugin[]): HostPlugin[] =>
  list.filter((p) => usable(p) && p.permissions.includes("artifact.content")).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/** The usable plugins with a background page: each gets one hidden frame that hears host text surfaces. */
export const surfacePlugins = (list: HostPlugin[]): HostPlugin[] =>
  list.filter((p) => usable(p) && p.background !== null && p.permissions.includes("surfaces.text"));

/**
 * A short key for the usable plugins that run content scripts inside documents, with their revs.
 * Part of an artifact frame's URL, so the frame reloads when a plugin is turned on or off or its script
 * changes. The hash (FNV-1a) keeps the URL short; roomsd decides the actual set itself.
 */
export function contentKey(list: HostPlugin[]): string {
  const parts = contentPlugins(list).map((p) => `${p.id}@${p.rev}`);
  let h = 0x811c9dc5;
  for (const c of parts.join(",")) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** `app >= min`, comparing the semver cores. */
export function compatible(app: string, min: string): boolean {
  const [a, m] = [core(app), core(min)];
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (m[i] ?? 0)) return (a[i] ?? 0) > (m[i] ?? 0);
  }
  return true;
}

/**
 * One page of a plugin as the app frames it. Panel and tab frames load the same entry, so they are
 * one page; the background page is another. The rev covers the manifest, the entry, the content
 * scripts and the background page, not a bundle the entry loads: a rebuilt bundle behind an
 * unchanged index.html keeps its page's flag until its first ready or hello replaces it.
 */
export type PluginPage = { id: string; rev: string; entry: string };

const pageKey = (p: PluginPage) => `${p.id}@${p.rev}:${p.entry}`;

export class PluginsStore {
  private state: PluginsState = { list: [], dismissed: new Set(), loaded: false };
  /** Each page whose last ready or hello said it applies the theme. */
  private themed = new Set<string>();
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

  usable(p: HostPlugin): boolean {
    return usable(p);
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

  /** What `page` last said on ready or hello: whether it applies the app's theme, so its frames may start on the pane colour. */
  setThemed(page: PluginPage, themed: boolean): void {
    if (themed) this.themed.add(pageKey(page));
    else this.themed.delete(pageKey(page));
  }

  isThemed(page: PluginPage): boolean {
    return this.themed.has(pageKey(page));
  }

  private set(p: Partial<PluginsState>) {
    this.state = { ...this.state, ...p };
    for (const l of [...this.listeners]) l();
  }
}

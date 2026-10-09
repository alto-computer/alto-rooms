import type { Agent, Artifact } from "@alto-rooms/protocol-ts";
import { isAgent } from "@/lib/agents";
import { isAppearance, type Appearance } from "@/lib/appearance";
import { globalTimers, type Clock } from "@/lib/clock";
import { localDate } from "@/lib/dates";

export type Tab =
  | { id: string; kind: "room"; roomId: string }
  | { id: string; kind: "doc"; roomId: string; artifactId: string }
  | { id: string; kind: "journal"; date: string }
  | { id: string; kind: "note"; date: string; name: string }
  | { id: string; kind: "plugin"; pluginId: string }
  | { id: string; kind: "conversation"; agent: Agent; session: string }
  /** One per window: opening it again shows the one already open. */
  | { id: string; kind: "settings" };

/** `Omit` distributed over the union, so each kind keeps its own id fields. */
export type TabInput = Tab extends infer T ? (T extends Tab ? Omit<T, "id"> : never) : never;

/** A tab's own back/forward entries (nearest last in `back`, nearest first in `forward`). */
export type TabHistory = { back: TabInput[]; forward: TabInput[] };

/** Entries kept per direction, per tab. */
const HISTORY_LIMIT = 50;
/** Closed tabs ⌘⇧T can bring back (this session only). */
const CLOSED_LIMIT = 20;
const NO_HISTORY: TabHistory = { back: [], forward: [] };

/** The artifact side panel: open or not, its width, and which plugin it shows. Per viewer, not per tab. */
export type PluginPanel = { open: boolean; width: number; pluginId: string | null };

export const DEFAULT_PLUGIN_PANEL: PluginPanel = { open: false, width: 360, pluginId: null };

export type ViewerState = {
  tabs: Tab[];
  pluginPanel: PluginPanel;
  /** Tab id -> its in-tab navigation history. Tabs without one have nowhere to go back to. */
  history: Record<string, TabHistory>;
  activeId: string | null;
  sidebarOpen: boolean;
  appearance: Appearance;
  lastVisit: Record<string, string>; // roomId -> ISO time the user last LEFT that room tab
  firstRunAt: string; // rooms never visited use this as their last visit
};

export const VIEWER_STORAGE_KEY = "alto-rooms.viewer.v1";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

/** Writes coalesce for this long, so a burst of tab switches costs one write. */
export const PERSIST_DELAY_MS = 300;

function defaultStorage(): StorageLike | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

const isStr = (v: unknown): v is string => typeof v === "string";
/** roomsd's session id rule; anything else could never name a conversation. */
const isSession = (v: unknown): v is string => isStr(v) && /^[A-Za-z0-9_-]{1,128}$/.test(v);

/**
 * Rebuilds a tab from untrusted JSON, keeping only its id fields. The retired New tab
 * (`kind: "new"`) comes back as the Journal for `today`, which took its place as home.
 */
function parseTab(v: unknown, today: string): Tab | null {
  if (!v || typeof v !== "object") return null;
  const t = v as Record<string, unknown>;
  if (!isStr(t.id)) return null;
  switch (t.kind) {
    case "room":
      return isStr(t.roomId) ? { id: t.id, kind: "room", roomId: t.roomId } : null;
    case "doc":
      return isStr(t.roomId) && isStr(t.artifactId) ? { id: t.id, kind: "doc", roomId: t.roomId, artifactId: t.artifactId } : null;
    case "journal":
      return isStr(t.date) ? { id: t.id, kind: "journal", date: t.date } : null;
    case "note":
      return isStr(t.date) && isStr(t.name) ? { id: t.id, kind: "note", date: t.date, name: t.name } : null;
    case "new":
      return { id: t.id, kind: "journal", date: today };
    case "plugin":
      return isStr(t.pluginId) ? { id: t.id, kind: "plugin", pluginId: t.pluginId } : null;
    case "conversation":
      return isAgent(t.agent) && isSession(t.session) ? { id: t.id, kind: "conversation", agent: t.agent, session: t.session } : null;
    case "settings":
      return { id: t.id, kind: "settings" };
    default:
      return null;
  }
}

/** A history entry from untrusted JSON: a tab's id fields, without an id. */
function parseInput(v: unknown, today: string): TabInput | null {
  if (!v || typeof v !== "object") return null;
  const tab = parseTab({ ...(v as object), id: "" }, today);
  return tab ? toInput(tab) : null;
}

function parseHistory(v: unknown, ids: Set<string>, today: string): Record<string, TabHistory> {
  const out: Record<string, TabHistory> = {};
  if (!v || typeof v !== "object") return out;
  const list = (x: unknown) => (Array.isArray(x) ? x.map((e) => parseInput(e, today)).filter((t): t is TabInput => t !== null).slice(-HISTORY_LIMIT) : []);
  for (const [id, h] of Object.entries(v as Record<string, unknown>)) {
    if (!ids.has(id) || !h || typeof h !== "object") continue;
    const { back, forward } = h as Record<string, unknown>;
    out[id] = { back: list(back), forward: list(forward).slice(0, HISTORY_LIMIT) };
  }
  return out;
}

function parsePluginPanel(v: unknown): PluginPanel {
  if (!v || typeof v !== "object") return DEFAULT_PLUGIN_PANEL;
  const p = v as Record<string, unknown>;
  const ok = typeof p.open === "boolean" && typeof p.width === "number" && p.width >= 240 && p.width <= 1200 && (p.pluginId === null || isStr(p.pluginId));
  return ok ? { open: p.open as boolean, width: p.width as number, pluginId: p.pluginId as string | null } : DEFAULT_PLUGIN_PANEL;
}

function parseState(raw: string | null, today: string): ViewerState | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (!v || typeof v !== "object" || !Array.isArray(v.tabs) || !isStr(v.firstRunAt)) return null;
    const tabs: Tab[] = [];
    const seen = new Set<string>();
    for (const t of v.tabs) {
      const tab = parseTab(t, today);
      if (tab && !seen.has(tab.id)) {
        seen.add(tab.id);
        tabs.push(tab);
      }
    }
    const lastVisit: Record<string, string> = {};
    if (v.lastVisit && typeof v.lastVisit === "object") {
      for (const [k, t] of Object.entries(v.lastVisit as Record<string, unknown>)) if (isStr(t)) lastVisit[k] = t;
    }
    const activeId = isStr(v.activeId) && seen.has(v.activeId) ? v.activeId : (tabs[0]?.id ?? null);
    return {
      tabs,
      pluginPanel: parsePluginPanel(v.pluginPanel),
      history: parseHistory(v.history, seen, today),
      activeId,
      sidebarOpen: typeof v.sidebarOpen === "boolean" ? v.sidebarOpen : true,
      appearance: isAppearance(v.appearance) ? v.appearance : "system",
      lastVisit,
      firstRunAt: v.firstRunAt,
    };
  } catch {
    return null;
  }
}

/** Two tabs are equal when their kind and every id field match. */
function sameTab(a: TabInput | Tab, b: TabInput | Tab): boolean {
  switch (a.kind) {
    case "room":
      return b.kind === "room" && a.roomId === b.roomId;
    case "doc":
      return b.kind === "doc" && a.roomId === b.roomId && a.artifactId === b.artifactId;
    case "journal":
      return b.kind === "journal" && a.date === b.date;
    case "note":
      return b.kind === "note" && a.date === b.date && a.name === b.name;
    case "plugin":
      return b.kind === "plugin" && a.pluginId === b.pluginId;
    case "conversation":
      return b.kind === "conversation" && a.agent === b.agent && a.session === b.session;
    case "settings":
      return b.kind === "settings";
  }
}

/** A tab's id fields without its id: what a history entry stores. */
function toInput(tab: Tab): TabInput {
  const { id: _id, ...rest } = tab;
  return rest as TabInput;
}

/** Copies only the id fields, so nothing else from callers (or the server) is persisted. */
function makeTab(id: string, t: TabInput): Tab {
  switch (t.kind) {
    case "room":
      return { id, kind: "room", roomId: t.roomId };
    case "doc":
      return { id, kind: "doc", roomId: t.roomId, artifactId: t.artifactId };
    case "journal":
      return { id, kind: "journal", date: t.date };
    case "note":
      return { id, kind: "note", date: t.date, name: t.name };
    case "plugin":
      return { id, kind: "plugin", pluginId: t.pluginId };
    case "conversation":
      return { id, kind: "conversation", agent: t.agent, session: t.session };
    case "settings":
      return { id, kind: "settings" };
  }
}

/** Per-viewer UI state (tabs, sidebar, appearance, last visits), persisted to localStorage. */
export class ViewerStore {
  private state: ViewerState;
  private listeners = new Set<() => void>();
  private counter = 0;
  /** Transient: bumped per tab on every in-tab navigation, so its view remounts. */
  private navCounts = new Map<string, number>();
  /** Transient: the tab last opened next to its opener, so the next one lines up after it. */
  private lastChild: { opener: string; id: string } | null = null;
  /** Transient: recently closed tabs, oldest first. */
  private closed: { tab: TabInput; index: number; history: TabHistory }[] = [];
  private readonly storage: StorageLike | undefined;
  private readonly now: () => Date;
  private readonly timers: Clock;
  private persistTimer: unknown = null;

  constructor(storage?: StorageLike, now: () => Date = () => new Date(), timers: Clock = globalTimers) {
    this.storage = storage ?? defaultStorage();
    this.now = now;
    this.timers = timers;
    let raw: string | null = null;
    try {
      raw = this.storage?.getItem(VIEWER_STORAGE_KEY) ?? null;
    } catch {
      raw = null;
    }
    this.state = parseState(raw, localDate(this.now())) ?? {
      tabs: [],
      pluginPanel: DEFAULT_PLUGIN_PANEL,
      history: {},
      activeId: null,
      sidebarOpen: true,
      appearance: "system",
      lastVisit: {},
      firstRunAt: this.now().toISOString(),
    };
    if (this.state.tabs.length === 0) {
      const tab = makeTab(this.newId(), this.home());
      this.state = { ...this.state, tabs: [tab], activeId: tab.id };
    }
    this.persist();
  }

  getState = (): ViewerState => this.state;

  /** Home, where a new window and a new tab start: the Journal for the local date right now. */
  home(): TabInput {
    return { kind: "journal", date: localDate(this.now()) };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * Opens `tab` (or activates an equal one). New tabs go at the end, or with `nextToActive`
   * right after the active tab and the tabs already opened from it, in order (Chrome).
   */
  open(tab: TabInput, opts: { activate?: boolean; nextToActive?: boolean } = {}): string {
    const activate = opts.activate ?? true;
    const existing = this.state.tabs.find((t) => sameTab(t, tab));
    if (existing) {
      if (activate) this.activate(existing.id);
      return existing.id;
    }
    const created = makeTab(this.newId(), tab);
    const tabs = [...this.state.tabs];
    tabs.splice(opts.nextToActive ? this.childSlot() : tabs.length, 0, created);
    if (opts.nextToActive && this.state.activeId) this.lastChild = { opener: this.state.activeId, id: created.id };
    if (activate) this.set({ ...this.leaving(), tabs, activeId: created.id });
    else this.set({ tabs });
    return created.id;
  }

  close(id: string): void {
    const i = this.state.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    const closing = this.state.tabs[i];
    let tabs = this.state.tabs.filter((t) => t.id !== id);
    // Closing the last tab goes home; if it already showed home, nothing changed and nothing needs bringing back.
    if (tabs.length > 0 || !sameTab(closing, this.home())) {
      this.closed = [...this.closed, { tab: toInput(closing), index: i, history: this.historyOf(id) }].slice(-CLOSED_LIMIT);
    }
    const { [id]: _dropped, ...history } = this.state.history;
    this.navCounts.delete(id);
    if (this.state.activeId !== id) {
      this.set({ tabs, history });
      return;
    }
    // The window always shows a tab: closing the last one goes home.
    if (tabs.length === 0) tabs = [makeTab(this.newId(), this.home())];
    const next = tabs[i] ?? tabs[i - 1];
    this.set({ ...this.leaving(), tabs, history, activeId: next.id });
  }

  /** Brings back the most recently closed tab at its old position, with its history. */
  reopen(): void {
    const last = this.closed.at(-1);
    if (!last) return;
    this.closed = this.closed.slice(0, -1);
    const existing = this.state.tabs.find((t) => sameTab(t, last.tab));
    if (existing) {
      this.activate(existing.id);
      return;
    }
    const created = makeTab(this.newId(), last.tab);
    const tabs = [...this.state.tabs];
    tabs.splice(Math.min(last.index, tabs.length), 0, created);
    this.set({ ...this.leaving(), tabs, history: { ...this.state.history, [created.id]: last.history }, activeId: created.id });
  }

  /** Activates the tab at `index`; -1 is the last tab. */
  activateAt(index: number): void {
    const tabs = this.state.tabs;
    const tab = index < 0 ? tabs.at(index) : tabs[index];
    if (tab) this.activate(tab.id);
  }

  /** Activates the tab `delta` places from the active one, wrapping around. */
  cycle(delta: number): void {
    const tabs = this.state.tabs;
    const i = tabs.findIndex((t) => t.id === this.state.activeId);
    if (i < 0 || tabs.length < 2) return;
    this.activate(tabs[(((i + delta) % tabs.length) + tabs.length) % tabs.length].id);
  }

  /**
   * Shows `tab` in the active tab, browser style: what it showed goes on its back
   * list and its forward list is dropped. With no tab open, opens one instead.
   */
  navigate(tab: TabInput): void {
    const active = this.activeTab();
    if (!active) {
      this.open(tab);
      return;
    }
    if (sameTab(active, tab)) return;
    const h = this.historyOf(active.id);
    this.moveTo(active.id, tab, { back: [...h.back, toInput(active)].slice(-HISTORY_LIMIT), forward: [] });
  }

  /** A click's destination: a new tab (⌘/Ctrl or middle click) or this one. */
  go(tab: TabInput, newTab = false): void {
    if (newTab) this.open(tab, { nextToActive: true });
    else this.navigate(tab);
  }

  back(): void {
    const active = this.activeTab();
    const h = active && this.historyOf(active.id);
    if (!active || !h?.back.length) return;
    const to = h.back[h.back.length - 1];
    this.moveTo(active.id, to, { back: h.back.slice(0, -1), forward: [toInput(active), ...h.forward].slice(0, HISTORY_LIMIT) });
  }

  forward(): void {
    const active = this.activeTab();
    const h = active && this.historyOf(active.id);
    if (!active || !h?.forward.length) return;
    const [to, ...rest] = h.forward;
    this.moveTo(active.id, to, { back: [...h.back, toInput(active)].slice(-HISTORY_LIMIT), forward: rest });
  }

  canGoBack(): boolean {
    const active = this.activeTab();
    return !!active && this.historyOf(active.id).back.length > 0;
  }

  canGoForward(): boolean {
    const active = this.activeTab();
    return !!active && this.historyOf(active.id).forward.length > 0;
  }

  /** Changes on every in-tab navigation of `id`: the key its view mounts under. */
  navKey(id: string): string {
    return `${id}:${this.navCounts.get(id) ?? 0}`;
  }

  /** Replaces a tab's id fields in place (same id and position), e.g. the journal tab's date. */
  replace(id: string, tab: TabInput): void {
    const i = this.state.tabs.findIndex((t) => t.id === id);
    if (i < 0 || sameTab(this.state.tabs[i], tab)) return;
    const tabs = [...this.state.tabs];
    tabs[i] = makeTab(id, tab);
    this.set({ tabs });
  }

  /** Moves tab `id` to position `to` (clamped), keeping the others in order. */
  move(id: string, to: number): void {
    const from = this.state.tabs.findIndex((t) => t.id === id);
    if (from < 0) return;
    const at = Math.min(Math.max(0, to), this.state.tabs.length - 1);
    if (at === from) return;
    const tabs = [...this.state.tabs];
    const [tab] = tabs.splice(from, 1);
    this.lastChild = null; // a hand-placed order starts a new run
    tabs.splice(at, 0, tab);
    this.set({ tabs });
  }

  activate(id: string): void {
    if (id === this.state.activeId || !this.state.tabs.some((t) => t.id === id)) return;
    this.set({ ...this.leaving(), activeId: id });
  }

  setPluginPanel(patch: Partial<PluginPanel>): void {
    const next = { ...this.state.pluginPanel, ...patch };
    next.width = Math.min(1200, Math.max(240, Math.round(next.width)));
    this.set({ pluginPanel: next });
  }

  setSidebarOpen(open: boolean): void {
    if (open !== this.state.sidebarOpen) this.set({ sidebarOpen: open });
  }

  setAppearance(appearance: Appearance): void {
    if (appearance !== this.state.appearance) this.set({ appearance });
  }

  /** Records leaving the active room tab now (the app is quitting or hiding) and persists synchronously. */
  flush(): void {
    const p = this.leaving();
    if (p.lastVisit) this.set(p);
    this.persist();
  }

  isNew(a: Artifact): boolean {
    const created = Date.parse(a.createdAt);
    const since = Date.parse(this.state.lastVisit[a.roomId] ?? this.state.firstRunAt);
    if (Number.isNaN(created) || Number.isNaN(since)) return false;
    return created > since;
  }

  /** Where a tab opened from the active one goes: after it, and after its last such child. */
  private childSlot(): number {
    const tabs = this.state.tabs;
    const active = tabs.findIndex((t) => t.id === this.state.activeId);
    if (active < 0) return tabs.length;
    const child = this.lastChild?.opener === this.state.activeId ? tabs.findIndex((t) => t.id === this.lastChild!.id) : -1;
    return Math.max(active, child) + 1;
  }

  private activeTab(): Tab | undefined {
    return this.state.tabs.find((t) => t.id === this.state.activeId);
  }

  private historyOf(id: string): TabHistory {
    return this.state.history[id] ?? NO_HISTORY;
  }

  /** Points tab `id` (the active one) at `to` with history `h`, recording leaving a room. */
  private moveTo(id: string, to: TabInput, h: TabHistory) {
    const tabs = this.state.tabs.map((t) => (t.id === id ? makeTab(id, to) : t));
    this.navCounts.set(id, (this.navCounts.get(id) ?? 0) + 1);
    this.set({ ...this.leaving(), tabs, history: { ...this.state.history, [id]: h } });
  }

  /** If the active tab is a room tab, the patch that records leaving it now. */
  private leaving(): Partial<ViewerState> {
    const active = this.state.tabs.find((t) => t.id === this.state.activeId);
    if (active?.kind !== "room") return {};
    return { lastVisit: { ...this.state.lastVisit, [active.roomId]: this.now().toISOString() } };
  }

  private set(p: Partial<ViewerState>) {
    this.state = { ...this.state, ...p };
    this.schedulePersist();
    for (const l of [...this.listeners]) l();
  }

  /** Writes the latest state once the delay passes; later changes ride along. */
  private schedulePersist() {
    if (this.persistTimer !== null) return;
    this.persistTimer = this.timers.setTimeout(() => {
      this.persistTimer = null;
      this.persist();
    }, PERSIST_DELAY_MS);
  }

  private persist() {
    if (this.persistTimer !== null) {
      this.timers.clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    try {
      this.storage?.setItem(VIEWER_STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      // Storage full or denied: state still works for this session.
    }
  }

  private newId(): string {
    const taken = new Set(this.state?.tabs.map((t) => t.id) ?? []);
    for (;;) {
      const id =
        typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : `tab-${++this.counter}`;
      if (!taken.has(id)) return id;
    }
  }
}

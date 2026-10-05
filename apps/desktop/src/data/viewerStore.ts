import type { Artifact } from "@alto-rooms/protocol-ts";

export type Tab =
  | { id: string; kind: "room"; roomId: string }
  | { id: string; kind: "doc"; roomId: string; artifactId: string }
  | { id: string; kind: "journal"; date: string }
  | { id: string; kind: "note"; date: string; name: string }
  | { id: string; kind: "new" };

/** `Omit` distributed over the union, so each kind keeps its own id fields. */
export type TabInput = Tab extends infer T ? (T extends Tab ? Omit<T, "id"> : never) : never;

export type ViewerState = {
  tabs: Tab[];
  activeId: string | null;
  sidebarOpen: boolean;
  lastVisit: Record<string, string>; // roomId -> ISO time the user last LEFT that room tab
  firstRunAt: string; // rooms never visited use this as their last visit
  /**
   * Transient (never persisted): the New tab opened via "에이전트로 정리하기",
   * which shows the compact onboarding card. Cleared once it stops being active.
   */
  onboardingTabId: string | null;
};

export const VIEWER_STORAGE_KEY = "alto-rooms.viewer.v1";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): StorageLike | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

const isStr = (v: unknown): v is string => typeof v === "string";

/** Rebuilds a tab from untrusted JSON, keeping only its id fields. */
function parseTab(v: unknown): Tab | null {
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
      return { id: t.id, kind: "new" };
    default:
      return null;
  }
}

function parseState(raw: string | null): ViewerState | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (!v || typeof v !== "object" || !Array.isArray(v.tabs) || !isStr(v.firstRunAt)) return null;
    const tabs: Tab[] = [];
    const seen = new Set<string>();
    for (const t of v.tabs) {
      const tab = parseTab(t);
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
      activeId,
      sidebarOpen: typeof v.sidebarOpen === "boolean" ? v.sidebarOpen : true,
      lastVisit,
      firstRunAt: v.firstRunAt,
      onboardingTabId: null,
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
    case "new":
      return b.kind === "new";
  }
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
    case "new":
      return { id, kind: "new" };
  }
}

/** Per-viewer UI state (tabs, sidebar, last visits), persisted to localStorage. */
export class ViewerStore {
  private state: ViewerState;
  private listeners = new Set<() => void>();
  private counter = 0;
  private readonly storage: StorageLike | undefined;
  private readonly now: () => Date;

  constructor(storage?: StorageLike, now: () => Date = () => new Date()) {
    this.storage = storage ?? defaultStorage();
    this.now = now;
    let raw: string | null = null;
    try {
      raw = this.storage?.getItem(VIEWER_STORAGE_KEY) ?? null;
    } catch {
      raw = null;
    }
    this.state = parseState(raw) ?? {
      tabs: [],
      activeId: null,
      sidebarOpen: true,
      lastVisit: {},
      firstRunAt: this.now().toISOString(),
      onboardingTabId: null,
    };
    if (this.state.tabs.length === 0) {
      const tab = makeTab(this.newId(), { kind: "new" });
      this.state = { ...this.state, tabs: [tab], activeId: tab.id };
    }
    this.persist();
  }

  getState = (): ViewerState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  open(tab: TabInput, opts: { activate?: boolean } = {}): string {
    const activate = opts.activate ?? true;
    const existing = this.state.tabs.find((t) => sameTab(t, tab));
    if (existing) {
      if (activate) this.activate(existing.id);
      return existing.id;
    }
    const created = makeTab(this.newId(), tab);
    const tabs = [...this.state.tabs, created];
    if (activate) this.set({ ...this.leaving(), tabs, activeId: created.id });
    else this.set({ tabs });
    return created.id;
  }

  close(id: string): void {
    const i = this.state.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    const tabs = this.state.tabs.filter((t) => t.id !== id);
    if (this.state.activeId !== id) {
      this.set({ tabs });
      return;
    }
    const next = tabs[i] ?? tabs[i - 1] ?? null;
    this.set({ ...this.leaving(), tabs, activeId: next?.id ?? null });
  }

  /** Replaces a tab's id fields in place (same id and position), e.g. the journal tab's date. */
  replace(id: string, tab: TabInput): void {
    const i = this.state.tabs.findIndex((t) => t.id === id);
    if (i < 0 || sameTab(this.state.tabs[i], tab)) return;
    const tabs = [...this.state.tabs];
    tabs[i] = makeTab(id, tab);
    this.set({ tabs });
  }

  activate(id: string): void {
    if (id === this.state.activeId || !this.state.tabs.some((t) => t.id === id)) return;
    this.set({ ...this.leaving(), activeId: id });
  }

  /** Opens (or activates) the New tab and flags it to show the compact onboarding card. */
  openOnboarding(): void {
    const id = this.open({ kind: "new" });
    if (this.state.onboardingTabId !== id) this.set({ onboardingTabId: id });
  }

  setSidebarOpen(open: boolean): void {
    if (open !== this.state.sidebarOpen) this.set({ sidebarOpen: open });
  }

  /** Records leaving the active room tab now (the app is quitting or hiding) and persists. */
  flush(): void {
    const p = this.leaving();
    if (p.lastVisit) this.set(p);
    else this.persist();
  }

  isNew(a: Artifact): boolean {
    const created = Date.parse(a.createdAt);
    const since = Date.parse(this.state.lastVisit[a.roomId] ?? this.state.firstRunAt);
    if (Number.isNaN(created) || Number.isNaN(since)) return false;
    return created > since;
  }

  /** If the active tab is a room tab, the patch that records leaving it now. */
  private leaving(): Partial<ViewerState> {
    const active = this.state.tabs.find((t) => t.id === this.state.activeId);
    if (active?.kind !== "room") return {};
    return { lastVisit: { ...this.state.lastVisit, [active.roomId]: this.now().toISOString() } };
  }

  private set(p: Partial<ViewerState>) {
    this.state = { ...this.state, ...p };
    if (this.state.onboardingTabId !== null && this.state.onboardingTabId !== this.state.activeId) {
      this.state = { ...this.state, onboardingTabId: null };
    }
    this.persist();
    for (const l of [...this.listeners]) l();
  }

  private persist() {
    try {
      const { onboardingTabId: _transient, ...kept } = this.state;
      this.storage?.setItem(VIEWER_STORAGE_KEY, JSON.stringify(kept));
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

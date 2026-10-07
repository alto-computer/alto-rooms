/*
 * Ask threads by file key, kept in step with roomsd by `ask.started` / `ask.done`
 * events, plus whether the ask bar is open (global, starts open, not saved).
 */
import type { AskTarget, AskTurn, RoomsEvent, StartAsk } from "@alto-rooms/protocol-ts";

export type Thread = { turns: AskTurn[]; loaded: boolean; error: boolean };
export type AsksState = { open: boolean; threads: Record<string, Thread> };

type Client = {
  startAsk(req: StartAsk): Promise<AskTurn>;
  askTarget(roomId: string, artifactId: string): Promise<AskTarget>;
  askThread(fileKey: string): Promise<AskTurn[]>;
  cancelAsk(askId: string): Promise<void>;
};
type Signals = { onSignal(fn: (type: RoomsEvent["type"], e: RoomsEvent) => void): () => void };

const finished = (t: AskTurn) => t.status !== "running";

/** By id; a finished turn never goes back to running (a late 202 or stale load). */
export function upsert(turns: AskTurn[], t: AskTurn): AskTurn[] {
  const i = turns.findIndex((x) => x.id === t.id);
  if (i < 0) return [...turns, t];
  if (finished(turns[i]) && !finished(t)) return turns;
  const next = turns.slice();
  next[i] = t;
  return next;
}

const EMPTY: Thread = { turns: [], loaded: false, error: false };

export class AsksStore {
  private state: AsksState = { open: true, threads: {} };
  private listeners = new Set<() => void>();
  private stopSignals: (() => void) | null = null;

  constructor(
    private readonly client: Client | undefined,
    private readonly rooms: Signals,
  ) {}

  getState = (): AsksState => this.state;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };

  start(): void {
    if (this.stopSignals) return;
    this.stopSignals = this.rooms.onSignal((type, e) => {
      if (e.type === "ask.started" || e.type === "ask.done") this.apply(e.turn);
      else if (type === "resync" && e.type === "resync" && e.roomId === null) {
        for (const [key, th] of Object.entries(this.state.threads)) if (th.loaded) void this.load(key);
      }
    });
  }

  stop(): void {
    this.stopSignals?.();
    this.stopSignals = null;
  }

  toggle(): void {
    this.setOpen(!this.state.open);
  }

  setOpen(open: boolean): void {
    if (open !== this.state.open) this.set({ ...this.state, open });
  }

  async load(fileKey: string): Promise<void> {
    if (!this.client) return;
    try {
      const loaded = await this.client.askThread(fileKey);
      const current = this.state.threads[fileKey]?.turns ?? [];
      const turns = current.reduce(upsert, loaded);
      this.setThread(fileKey, { turns, loaded: true, error: false });
    } catch (e) {
      console.warn("rooms: could not load ask thread", e);
      this.setThread(fileKey, { ...(this.state.threads[fileKey] ?? EMPTY), loaded: true, error: true });
    }
  }

  /** Which agent an ask from this doc goes to, and its models; null when roomsd can't say. */
  async target(a: { roomId: string; artifactId: string }): Promise<AskTarget | null> {
    if (!this.client) return null;
    try {
      return await this.client.askTarget(a.roomId, a.artifactId);
    } catch (e) {
      console.warn("rooms: could not load the ask target", e);
      return null;
    }
  }

  /** Throws the API error (e.g. ask_busy) for the bar to show. `model` null = the agent's default. */
  async ask(a: { roomId: string; artifactId: string }, question: string, model: string | null = null): Promise<void> {
    if (!this.client) return;
    const t = await this.client.startAsk({ roomId: a.roomId, artifactId: a.artifactId, question, model });
    this.apply(t);
  }

  cancel(askId: string): void {
    void this.client?.cancelAsk(askId).catch((e) => console.warn("rooms: could not cancel ask", e));
  }

  private apply(t: AskTurn) {
    const th = this.state.threads[t.fileKey] ?? EMPTY;
    this.setThread(t.fileKey, { ...th, turns: upsert(th.turns, t) });
  }

  private setThread(key: string, th: Thread) {
    this.set({ ...this.state, threads: { ...this.state.threads, [key]: th } });
  }

  private set(next: AsksState) {
    this.state = next;
    for (const l of [...this.listeners]) l();
  }
}

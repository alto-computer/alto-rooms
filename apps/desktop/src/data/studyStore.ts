/*
 * The Study's rooms as the app sees them: roomsd's index, fetched the first time a view needs it and
 * again whenever roomsd says the Study changed or the event stream resyncs. Volumes and days are
 * loaded by the pages that show them.
 */
import type { RoomsEvent, StudyIndex, StudyRoomSummary } from "@alto-rooms/protocol-ts";

export type StudyState = {
  /** Oldest first; null before the first load. */
  rooms: StudyRoomSummary[] | null;
  /** The last load failed (rooms keeps what the one before brought). */
  failed: boolean;
};

type Client = { studyIndex(): Promise<StudyIndex> };
type Signals = { onSignal(fn: (type: RoomsEvent["type"], e: RoomsEvent) => void): () => void };

export class StudyStore {
  private state: StudyState = { rooms: null, failed: false };
  private listeners = new Set<() => void>();
  private stopSignals: (() => void) | null = null;
  private wanted = false;
  private gen = 0;

  constructor(
    private readonly client: Client | undefined,
    private readonly signals: Signals,
  ) {}

  getState = (): StudyState => this.state;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };

  start(): void {
    if (this.stopSignals || !this.client) return;
    this.stopSignals = this.signals.onSignal((type) => {
      if (this.wanted && (type === "study.changed" || type === "resync")) void this.refresh();
    });
  }

  stop(): void {
    this.stopSignals?.();
    this.stopSignals = null;
  }

  /** Loads the index once; later changes arrive by themselves. */
  want(): void {
    if (this.wanted) return;
    this.wanted = true;
    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.client) return;
    const gen = ++this.gen;
    try {
      const { rooms } = await this.client.studyIndex();
      if (gen === this.gen) this.set({ rooms, failed: false });
    } catch (e) {
      console.warn("rooms: could not load the Study", e);
      if (gen === this.gen) this.set({ failed: true });
    }
  }

  private set(p: Partial<StudyState>) {
    this.state = { ...this.state, ...p };
    for (const l of [...this.listeners]) l();
  }
}

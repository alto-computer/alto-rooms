import type { Clock } from "@/lib/clock";

/**
 * Watchers, linger and fetch tokens for a family of scopes (one per room, one
 * per day, ...).
 *
 * A scope is watched while it has a key here. `acquire` / `release` count
 * watchers; when the count reaches 0 the scope lingers, still watched, for
 * `lingerMs`, then `onExpire(key)` runs and the key is gone. An `acquire`
 * during the linger keeps the scope as it is.
 *
 * Tokens tell a fetch whether it is still the current one: `bump` before
 * starting it, `isCurrent` when it settles. `F` is whatever the owner tracks
 * per in-flight fetch. Tokens come from one counter for all keys, so an expired
 * key forgets its token (and fetch) without letting an old fetch look current
 * once the key is watched again: keys never watched again cost nothing.
 */
export class ScopeRefs<K, F = unknown> {
  private refs = new Map<K, number>(); // count 0 = lingering
  private lingers = new Map<K, unknown>();
  private tokens = new Map<K, number>();
  private fetches = new Map<K, F>();
  private lastToken = 0;

  constructor(
    private readonly clock: Clock,
    private readonly lingerMs: number,
    private readonly onExpire: (key: K) => void,
  ) {}

  // ---------------------------------------------------------------- watchers

  acquire(key: K): void {
    this.refs.set(key, (this.refs.get(key) ?? 0) + 1);
    this.cancelLinger(key);
  }

  /** Extra releases (more than acquires) are ignored. */
  release(key: K): void {
    const n = this.refs.get(key);
    if (n === undefined || n === 0) return;
    this.refs.set(key, n - 1);
    if (n - 1 > 0) return;
    this.lingers.set(
      key,
      this.clock.setTimeout(() => this.expire(key), this.lingerMs),
    );
  }

  /** Watched or lingering. */
  has(key: K): boolean {
    return this.refs.has(key);
  }

  keys(): K[] {
    return [...this.refs.keys()];
  }

  /** Ends every linger now (the owner is shutting down; nobody is coming back). */
  expireLingering(): void {
    for (const key of [...this.lingers.keys()]) this.expire(key);
  }

  private expire(key: K) {
    this.cancelLinger(key);
    if (this.refs.get(key) !== 0) return;
    this.refs.delete(key);
    this.onExpire(key);
    // After onExpire, which may supersede the key's fetch: nothing about the key is kept.
    this.tokens.delete(key);
    this.fetches.delete(key);
  }

  private cancelLinger(key: K) {
    if (!this.lingers.has(key)) return;
    this.clock.clearTimeout(this.lingers.get(key));
    this.lingers.delete(key);
  }

  // ---------------------------------------------------------------- fetches

  /** A new token for `key`; any fetch holding an older one is now stale. */
  bump(key: K): number {
    const t = ++this.lastToken;
    this.tokens.set(key, t);
    return t;
  }

  isCurrent(key: K, token: number): boolean {
    return this.tokens.get(key) === token;
  }

  inflight(key: K): F | undefined {
    return this.fetches.get(key);
  }

  track(key: K, fetch: F): void {
    this.fetches.set(key, fetch);
  }

  settle(key: K): void {
    this.fetches.delete(key);
  }

  /** Makes the in-flight fetch (if any) stale and forgets it; returns the new token. */
  supersede(key: K): number {
    const t = this.bump(key);
    this.fetches.delete(key);
    return t;
  }

  supersedeAll(): void {
    for (const key of [...this.fetches.keys()]) this.supersede(key);
  }
}

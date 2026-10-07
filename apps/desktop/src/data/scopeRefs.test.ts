import { describe, expect, it } from "vitest";
import { manualTimers } from "@/test/fakes";
import { ScopeRefs } from "./scopeRefs";

function setup() {
  const clock = manualTimers();
  const expired: string[] = [];
  const refs = new ScopeRefs<string, string>(clock.timers, 1000, (k) => expired.push(k));
  return { clock, expired, refs };
}

describe("ScopeRefs", () => {
  it("keeps a released scope until its linger fires, then expires it", () => {
    const { clock, expired, refs } = setup();
    refs.acquire("a");
    refs.release("a");
    expect(refs.has("a")).toBe(true);
    clock.run();
    expect(refs.has("a")).toBe(false);
    expect(expired).toEqual(["a"]);
  });

  it("expires only after the last watcher leaves", () => {
    const { clock, expired, refs } = setup();
    refs.acquire("a");
    refs.acquire("a");
    refs.release("a");
    clock.run();
    expect(refs.has("a")).toBe(true);
    expect(expired).toEqual([]);
  });

  it("a watcher returning during the linger keeps the scope", () => {
    const { clock, expired, refs } = setup();
    refs.acquire("a");
    refs.release("a");
    refs.acquire("a");
    clock.run();
    expect(refs.has("a")).toBe(true);
    expect(expired).toEqual([]);
  });

  it("ignores extra releases", () => {
    const { clock, expired, refs } = setup();
    refs.release("a");
    refs.acquire("a");
    refs.release("a");
    refs.release("a");
    clock.run();
    expect(expired).toEqual(["a"]);
  });

  it("expireLingering ends lingers now and leaves watched scopes alone", () => {
    const { expired, refs } = setup();
    refs.acquire("a");
    refs.release("a");
    refs.acquire("b");
    refs.expireLingering();
    expect(expired).toEqual(["a"]);
    expect(refs.keys()).toEqual(["b"]);
  });

  it("bump makes older tokens stale", () => {
    const { refs } = setup();
    const t1 = refs.bump("a");
    expect(refs.isCurrent("a", t1)).toBe(true);
    const t2 = refs.bump("a");
    expect(refs.isCurrent("a", t1)).toBe(false);
    expect(refs.isCurrent("a", t2)).toBe(true);
  });

  it("supersede stales and forgets the in-flight fetch", () => {
    const { refs } = setup();
    const t = refs.bump("a");
    refs.track("a", "fetch");
    expect(refs.inflight("a")).toBe("fetch");
    const next = refs.supersede("a");
    expect(refs.inflight("a")).toBeUndefined();
    expect(refs.isCurrent("a", t)).toBe(false);
    expect(refs.isCurrent("a", next)).toBe(true);
  });

  it("supersedeAll touches only keys with a fetch in flight", () => {
    const { refs } = setup();
    const ta = refs.bump("a");
    refs.track("a", "fa");
    const tb = refs.bump("b");
    refs.supersedeAll();
    expect(refs.inflight("a")).toBeUndefined();
    expect(refs.isCurrent("a", ta)).toBe(false);
    expect(refs.isCurrent("b", tb)).toBe(true);
  });

  it("an expired key keeps nothing behind", () => {
    const { clock, refs } = setup();
    for (let i = 0; i < 100; i++) {
      const k = `day-${i}`;
      refs.acquire(k);
      refs.bump(k);
      refs.track(k, "f");
      refs.release(k);
    }
    clock.run();
    const internals = refs as unknown as Record<"refs" | "lingers" | "tokens" | "fetches", Map<string, unknown>>;
    expect([internals.refs.size, internals.lingers.size, internals.tokens.size, internals.fetches.size]).toEqual([0, 0, 0, 0]);
  });

  it("a fetch from before an expiry stays stale when the key is watched again", () => {
    const { clock, refs } = setup();
    refs.acquire("a");
    const old = refs.bump("a");
    refs.release("a");
    clock.run();
    refs.acquire("a");
    const fresh = refs.bump("a");
    expect(refs.isCurrent("a", old)).toBe(false);
    expect(refs.isCurrent("a", fresh)).toBe(true);
  });
});

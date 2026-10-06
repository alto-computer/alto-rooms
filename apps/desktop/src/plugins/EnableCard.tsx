/*
 * Asks before a new plugin runs (or before one runs with new permissions):
 * one card at a time, what it adds and what it can do, Turn on / Not now.
 */
import { useState } from "react";
import { usePlugins, usePluginsStore } from "@/data/hooks";
import { PERMISSION_COPY } from "./permissions";

export function EnableCard() {
  usePlugins(); // re-render on list and dismiss changes
  const store = usePluginsStore();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const p = store.nextToApprove();
  if (!p) return null;

  const adds = [
    p.slots.tab?.sidebar ? "Adds a sidebar item and a tab" : p.slots.tab ? "Adds a tab" : null,
    p.slots.artifactSidePanel ? "Adds a panel beside documents" : null,
  ].filter((x): x is string => x !== null);
  const can = p.permissions.map((x) => PERMISSION_COPY[x]).filter(Boolean);

  const turnOn = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await store.setEnabled(p.id, true);
    } catch (e) {
      console.warn("could not turn the plugin on", e);
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-label={`New plugin: ${p.name}`}
      className="fixed right-5 bottom-5 z-50 flex w-[300px] flex-col gap-2 rounded-[14px] border border-[#ddd] bg-white px-4 py-3.5 text-[14px] shadow-float"
    >
      <p className="font-medium text-ink">New plugin: {p.name}</p>
      {p.description ? <p className="text-ink-2">{p.description}</p> : null}
      <ul className="flex flex-col gap-0.5 text-[13px] text-ink-2">
        {[...adds, ...can].map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {failed ? <p className="text-[13px] text-[#c13515]">Couldn't turn it on</p> : null}
      <div className="mt-1 flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void turnOn()}
          className="h-8 rounded-lg bg-thread-deep px-3 text-[13px] font-medium text-white hover:bg-[var(--thread-deeper)] disabled:opacity-60"
        >
          Turn on
        </button>
        <button
          type="button"
          onClick={() => store.dismiss(p.id)}
          className="h-8 rounded-lg border border-[#ddd] px-3 text-[13px] text-ink hover:bg-[#f7f7f7]"
        >
          Not now
        </button>
      </div>
    </div>
  );
}

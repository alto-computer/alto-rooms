/*
 * Asks before a new plugin runs ("New plugin": what it adds and can do) or
 * before an approved one gets more access ("Updated plugin": only the new
 * permissions). One card at a time; Turn on grants exactly what it showed.
 */
import { useState } from "react";
import { usePlugins, usePluginsStore } from "@/data/hooks";
import { permissionLine } from "./permissions";
import type { HostPlugin } from "./pluginsStore";

export function EnableCard() {
  usePlugins(); // re-render on list and dismiss changes
  const store = usePluginsStore();
  const p = store.nextToApprove();
  if (!p) return null;
  // Keyed by plugin and rev, so a failed attempt doesn't carry over to the next card.
  return <Card key={`${p.id}:${p.rev}`} plugin={p} />;
}

function Card({ plugin: p }: { plugin: HostPlugin }) {
  const store = usePluginsStore();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const updated = p.granted !== null;
  // A re-ask shows only what is new; a first ask shows everything the plugin adds and can do.
  const adds = updated
    ? []
    : [
        p.slots.tab?.sidebar ? "Adds a sidebar item and a tab" : p.slots.tab ? "Adds a tab" : null,
        p.slots.artifactSidePanel ? "Adds a panel beside documents" : null,
      ].filter((x): x is string => x !== null);
  const asked = updated ? p.permissions.filter((x) => !p.granted!.includes(x)) : p.permissions;
  const can = asked.map(permissionLine);
  const title = `${updated ? "Updated plugin" : "New plugin"}: ${p.name}`;

  const turnOn = async () => {
    setBusy(true);
    setFailed(false);
    try {
      // Grant exactly what this card showed; a manifest that changed meanwhile is asked about again.
      await store.setEnabled(p.id, true, p.permissions);
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
      aria-label={title}
      className="fixed right-5 bottom-5 z-50 flex w-[300px] flex-col gap-2 rounded-[14px] border border-[#ddd] bg-white px-4 py-3.5 text-[14px] shadow-float"
    >
      <p className="font-medium text-ink">{title}</p>
      {p.description && !updated ? <p className="text-ink-2">{p.description}</p> : null}
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

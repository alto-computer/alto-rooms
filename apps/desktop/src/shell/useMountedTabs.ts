import { useRef } from "react";
import type { Tab } from "@/data/viewerStore";

/** Doc tabs kept alive (hidden) after you leave them, so coming back is instant and keeps the doc's scroll. One: a hidden doc keeps running its scripts, timers and media, so each kept tab costs a whole page of memory. */
const KEPT_DOC_TABS = 1;

/**
 * The tabs whose views stay mounted: the active one, plus the doc tab viewed last.
 * A doc's iframe can't be reloaded to where it was (it's sandboxed), so these keep it
 * in a hidden <Activity>; other views remount on arrival (their "new since" baselines rely on it).
 */
export function useMountedTabs(tabs: Tab[], active: Tab | undefined): Tab[] {
  const recent = useRef<string[]>([]);
  if (active?.kind === "doc" && recent.current[0] !== active.id) {
    recent.current = [active.id, ...recent.current.filter((id) => id !== active.id)].slice(0, KEPT_DOC_TABS + 1);
  }
  // The active tab is mounted anyway: the kept ones are the doc tabs viewed last besides it.
  const kept = new Set(recent.current.filter((id) => id !== active?.id).slice(0, KEPT_DOC_TABS));
  const mounted = tabs.filter((t) => t === active || (t.kind === "doc" && kept.has(t.id)));
  // Rendered in the order they were first mounted, never in tab order: moving an iframe's
  // DOM node reloads it, so reordering tabs (or switching between them) must not move any.
  const order = useRef<string[]>([]);
  const ids = new Set(mounted.map((t) => t.id));
  order.current = [...order.current.filter((id) => ids.has(id)), ...mounted.map((t) => t.id).filter((id) => !order.current.includes(id))];
  return order.current.map((id) => mounted.find((t) => t.id === id)!);
}

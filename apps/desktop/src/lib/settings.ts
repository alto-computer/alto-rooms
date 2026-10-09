import type { ViewerStore } from "@/data/viewerStore";

export type SettingsSection = "appearance" | "auto-sort" | "plugins";

export const settingsSectionId = (s: SettingsSection) => `settings-${s}`;

/*
 * A section to bring into view, waiting for the Settings view: it takes the request
 * when it mounts (the tab was elsewhere) or when told (it is already showing).
 */
let requested: SettingsSection | null = null;
const listeners = new Set<() => void>();

/** Shows the Settings tab (the one already open, else a new one), scrolled to `section` if given. */
export function openSettings(viewer: ViewerStore, section?: SettingsSection): void {
  requested = section ?? null;
  viewer.open({ kind: "settings" });
  for (const l of [...listeners]) l();
}

export function takeSettingsSection(): SettingsSection | null {
  const s = requested;
  requested = null;
  return s;
}

export function onSettingsSection(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

import type { PluginInfo } from "@alto-rooms/protocol-ts";

/** A valid, enabled, approved plugin with a side panel; override what a test needs. */
export function plugin(extra: Partial<PluginInfo> = {}): PluginInfo {
  return {
    id: "echo",
    name: "Echo",
    version: "0.1.0",
    minAppVersion: "0.1.0",
    description: null,
    entry: "index.html",
    permissions: [],
    slots: { artifactSidePanel: { title: "Echo", icon: null }, tab: null },
    status: "ok",
    reason: null,
    enabled: true,
    granted: [],
    needsApproval: false,
    rev: "r1",
    ...extra,
  };
}

import type { Permission, PluginInfo } from "@alto-rooms/protocol-ts";

/** What each permission lets a plugin do, in the words the enable card shows. */
export const PERMISSION_COPY: Record<Permission, string> = {
  "rooms.read": "Can see your rooms and artifacts",
  clipboard: "Can copy and paste",
  downloads: "Can save files you export",
  "artifact.content": "Can read the text of artifacts and use the network inside them",
};

/** The card line for a permission; one without copy still shows, so the card never grants it unseen. */
export function permissionLine(p: string): string {
  return (PERMISSION_COPY as Record<string, string | undefined>)[p] ?? `Can use ${p}`;
}

/** iframe attributes from the declared permissions only: never same-origin, popups or top navigation. */
export function frameAttrs(p: PluginInfo): { sandbox: string; allow: string | undefined } {
  return {
    sandbox: p.permissions.includes("downloads") ? "allow-scripts allow-downloads" : "allow-scripts",
    allow: p.permissions.includes("clipboard") ? "clipboard-read; clipboard-write" : undefined,
  };
}

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { isTauri } from "./tauri";

export async function pickFolder(): Promise<string | null> {
  if (isTauri()) {
    const picked = await open({ directory: true, multiple: false });
    return typeof picked === "string" ? picked : null;
  }
  return window.prompt("Folder path");
}

export async function openInEditor(absPath: string): Promise<void> {
  if (isTauri()) await openPath(absPath);
}

/** The original file behind a doc's room link. Without Tauri there is nothing to resolve it with, so the link itself. */
export async function docOriginal(link: string): Promise<string> {
  return isTauri() ? invoke<string>("doc_original", { link }) : link;
}

export async function revealDoc(link: string): Promise<void> {
  await invoke("reveal_doc", { link });
}

export async function openDoc(link: string): Promise<void> {
  await invoke("open_doc", { link });
}

export async function viewerInitial(): Promise<string> {
  if (isTauri()) return invoke<string>("viewer_initial");
  return "J";
}

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { isTauri } from "./tauri";

export async function pickFolder(): Promise<string | null> {
  if (isTauri()) {
    const picked = await open({ directory: true, multiple: false });
    return typeof picked === "string" ? picked : null;
  }
  return window.prompt("폴더 경로");
}

export async function openInEditor(absPath: string): Promise<void> {
  if (isTauri()) await openPath(absPath);
}

export async function viewerInitial(): Promise<string> {
  if (isTauri()) return invoke<string>("viewer_initial");
  return "J";
}

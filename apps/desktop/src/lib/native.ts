import type { Session } from "@alto-rooms/protocol-ts";
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

/** Opens a folder in Finder. */
export async function showInFinder(absPath: string): Promise<void> {
  if (isTauri()) await openPath(absPath);
}

/** The original file behind an artifact's room link. Without Tauri there is nothing to resolve it with, so the link itself. */
export async function artifactOriginal(link: string): Promise<string> {
  return isTauri() ? invoke<string>("artifact_original", { link }) : link;
}

export async function revealArtifact(link: string): Promise<void> {
  await invoke("reveal_artifact", { link });
}

export async function openArtifact(link: string): Promise<void> {
  await invoke("open_artifact", { link });
}

/** Resumes the session in Terminal, in the folder it started in. False when there is no Terminal to open (the web build). */
export async function continueSession(session: Session): Promise<boolean> {
  if (!isTauri()) return false;
  await invoke("continue_session", { sessionRef: { agent: session.agent, id: session.id }, cwd: session.cwd });
  return true;
}

export async function viewerInitial(): Promise<string> {
  if (isTauri()) return invoke<string>("viewer_initial");
  return "J";
}

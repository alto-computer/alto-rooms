import type { Artifact } from "@alto-rooms/protocol-ts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolbarGroup } from "@/components/ToolbarGroup";
import { Toaster } from "@/components/ui/sonner";
import { renderWithStores, room } from "@/test/fakes";
import { ShareMenu } from "./ShareMenu";

const native = vi.hoisted(() => ({ tauri: true, invoke: vi.fn() }));
vi.mock("@/lib/tauri", () => ({ isTauri: () => native.tauri }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));

const artifact = (roomId: string, relPath: string): Artifact => ({
  id: "a1",
  roomId,
  relPath,
  title: "보고서",
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  author: "agent",
  source: { agent: null, session: null, cwd: null, machine: null },
  fileKey: "0000000000000000",
});

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  native.tauri = true;
  native.invoke.mockReset();
  native.invoke.mockImplementation(async (cmd: string) => (cmd === "doc_original" ? "/Users/me/project/report.html" : undefined));
  writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(cleanup);

async function openMenu(doc = artifact("r1", "sub/report.html")) {
  await renderWithStores(
    <>
      <ToolbarGroup label="Document actions">
        <ShareMenu artifact={doc} />
      </ToolbarGroup>
      <Toaster />
    </>,
    { rooms: [room("r1", "방")] },
  );
  fireEvent.keyDown(screen.getByRole("button", { name: "Share" }), { key: "Enter" });
  return (await screen.findAllByRole("menuitem")).map((item) => item.textContent);
}

describe("ShareMenu", () => {
  it("offers copy, reveal and open in the app", async () => {
    expect(await openMenu()).toEqual(["Copy file path", "Reveal in Finder", "Open in browser"]);
  });

  it("copies the original's path, not the room link, and says so", async () => {
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy file path" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("/Users/me/project/report.html"));
    expect(native.invoke).toHaveBeenCalledWith("doc_original", { link: "/h/rooms/r1/sub/report.html" });
    expect(await screen.findByText("Copied file path")).toBeInTheDocument();
  });

  it("reveals and opens the doc through its room link", async () => {
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Reveal in Finder" }));
    await waitFor(() => expect(native.invoke).toHaveBeenCalledWith("reveal_doc", { link: "/h/rooms/r1/sub/report.html" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Share" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open in browser" }));
    await waitFor(() => expect(native.invoke).toHaveBeenCalledWith("open_doc", { link: "/h/rooms/r1/sub/report.html" }));
  });

  it("finds a journal doc under the journal folder", async () => {
    await openMenu(artifact("journal", "2026-10-09/plan.html"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Reveal in Finder" }));
    await waitFor(() => expect(native.invoke).toHaveBeenCalledWith("reveal_doc", { link: "/h/journal/2026-10-09/plan.html" }));
  });

  it("toasts when the app can't do it", async () => {
    native.invoke.mockRejectedValue(new Error("not an HTML file"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Open in browser" }));
    expect(await screen.findByText("Couldn't open the file")).toBeInTheDocument();
  });

  it("outside the app, only copies, and copies the room link", async () => {
    native.tauri = false;
    expect(await openMenu()).toEqual(["Copy file path"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy file path" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("/h/rooms/r1/sub/report.html"));
    expect(native.invoke).not.toHaveBeenCalled();
  });
});

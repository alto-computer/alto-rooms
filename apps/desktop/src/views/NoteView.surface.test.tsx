/*
 * The note body as a host text surface: with a plugin that marks host text on, the body gets a
 * backdrop, a selection shows the plugin's buttons, a click on a painted range asks for its menu,
 * and the textarea itself is the one trunk had. Without such a plugin, nothing of this exists.
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetNoteSavers } from "@/lib/noteSaverRegistry";
import { surfaceHub, surfaceKey } from "@/surfaces/surfaceHub";
import { StoresProvider } from "@/data/hooks";
import { plugin } from "@/test/plugins";
import { renderWithStores } from "@/test/fakes";
import { NoteView } from "./NoteView";

vi.mock("@/lib/native", () => ({
  pickFolder: vi.fn(async () => null),
  openInEditor: vi.fn(async () => {}),
  viewerInitial: vi.fn(async () => "J"),
}));

const DATE = "2026-10-05";
const TEXT = "first line\nthe quick brown fox";
const tagger = plugin({ id: "tagger", name: "Tagger", slots: { artifactSidePanel: null, tab: null }, permissions: ["surfaces.text"], granted: ["surfaces.text"], background: "background.html" });
const id = { kind: "note", date: DATE, name: "Plan.md" } as const;

class FakeHighlight {
  ranges: Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}
const highlights = new Map<string, FakeHighlight>();
const painted = () => (highlights.get("rooms-tagger-amber")?.ranges ?? []).map((r) => r.toString());

let seat: ReturnType<typeof surfaceHub.register> | null = null;
let sent: Record<string, unknown>[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-05T03:00:00Z"));
  highlights.clear();
  vi.stubGlobal("Highlight", FakeHighlight);
  vi.stubGlobal("CSS", { highlights, supports: () => true });
  Range.prototype.getBoundingClientRect = () => ({ left: 20, top: 30, right: 70, bottom: 46, width: 50, height: 16 }) as DOMRect;
  Range.prototype.getClientRects = () => [{ left: 20, top: 30, width: 50, height: 16 }] as unknown as DOMRectList;
  sent = [];
});
afterEach(() => {
  seat?.dispose();
  seat = null;
  cleanup();
  resetNoteSavers();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

async function renderNote(plugins = [tagger], otherNotes: Record<string, string> = {}) {
  const r = await renderWithStores(<NoteView date={DATE} name="Plan.md" />, {
    plugins,
    notes: { [`${DATE}/Plan.md`]: TEXT, ...otherNotes },
    days: { [DATE]: { notes: [{ date: DATE, name: "Plan.md", relPath: `${DATE}/Plan.md`, updatedAt: "2026-10-05T01:00:00Z", author: "me" }] } },
  });
  await advance(0);
  // jsdom lays nothing out: the body box is a real rectangle here so a selection inside it is not read as scrolled out of view.
  (textarea().parentElement as HTMLElement).getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }) as DOMRect;
  return r;
}

/** The tagger's background frame, as the hub sees it: one Tag button, paint on request. */
function sitDown() {
  seat = surfaceHub.register("tagger", (m) => void sent.push(m));
  seat.receive({ rooms: "surface", v: 1, type: "actions", items: [{ id: "tag", title: "Tag", color: "#ffd400" }] });
  return {
    paint: (ranges: { id: string; start: number; end: number }[]) =>
      seat!.receive({ rooms: "surface", v: 1, type: "paint", surface: id, styles: { amber: "#c79a3e" }, ranges: ranges.map((r) => ({ ...r, style: "amber" })) }),
    menu: (rangeId: string) => seat!.receive({ rooms: "surface", v: 1, type: "menu", surface: id, rangeId, items: [{ id: "untag", title: "Untag" }] }),
  };
}

const textarea = () => screen.getByRole("textbox", { name: "Note" }) as HTMLTextAreaElement;
const backdrop = () => document.querySelector("[data-note-backdrop]");

async function select(start: number, end: number) {
  const ta = textarea();
  ta.setSelectionRange(start, end);
  fireEvent.mouseUp(ta);
  await advance(0);
}

describe("NoteView as a text surface", () => {
  it("without a plugin that marks host text, the body is the plain textarea alone", async () => {
    await renderNote([]);
    expect(backdrop()).toBeNull();
    expect(textarea()).toHaveValue(TEXT);
    await select(15, 20);
    expect(screen.queryByRole("button", { name: "Tag" })).toBeNull();
  });

  it("with one on, tells it the text, shows its button over a selection, and posts the selection's offsets and text when clicked", async () => {
    const frame = sitDown();
    await renderNote();
    expect(backdrop()).not.toBeNull();
    expect(sent.at(-1)).toMatchObject({ type: "surface.open", surface: id, text: TEXT });
    await select(15, 20);
    const tag = screen.getByRole("button", { name: "Tag" });
    expect(screen.queryByRole("button", { name: "Ask" }), "notes have no Ask").toBeNull();
    fireEvent.click(tag);
    expect(sent.at(-1)).toEqual({ rooms: "surface", v: 1, type: "selection.action", surface: id, actionId: "tag", start: 15, end: 20, text: "quick" });
    expect(screen.queryByRole("button", { name: "Tag" })).toBeNull();
    frame.paint([{ id: "q", start: 15, end: 20 }]);
    expect(painted()).toEqual(["quick"]);
    expect(backdrop()!.textContent).toBe(TEXT);
  });

  it("keeps the bar while focus moves onto its button, so Tab + Enter and an accessibility press run the action on the selection the bar was shown for", async () => {
    sitDown();
    await renderNote();
    textarea().focus();
    await select(15, 20);
    const tag = screen.getByRole("button", { name: "Tag" });
    // Tab lands on the button, and an accessibility press (WebKit's HTMLButtonElement::accessKeyAction) focuses it before its click.
    act(() => tag.focus());
    expect(screen.getByRole("button", { name: "Tag" }), "the textarea's blur into the bar keeps it").toBe(tag);
    fireEvent.click(tag);
    expect(sent.at(-1)).toEqual({ rooms: "surface", v: 1, type: "selection.action", surface: id, actionId: "tag", start: 15, end: 20, text: "quick" });
    expect(screen.queryByRole("button", { name: "Tag" })).toBeNull();
    expect(document.activeElement, "focus goes back to the text").toBe(textarea());
    // Focus leaving the body altogether takes the bar with it.
    await select(15, 20);
    expect(screen.getByRole("button", { name: "Tag" })).toBeInTheDocument();
    act(() => screen.getByRole("button", { name: "Open in another editor" }).focus());
    expect(screen.queryByRole("button", { name: "Tag" })).toBeNull();
  });

  it("typing keeps the paint on its word, saves the typed text as before, and tells the plugin after a pause", async () => {
    const frame = sitDown();
    const { client } = await renderNote();
    frame.paint([{ id: "q", start: 15, end: 20 }]);
    await select(15, 20);
    expect(screen.getByRole("button", { name: "Tag" })).toBeInTheDocument();
    const typed = `A${TEXT}`;
    fireEvent.change(textarea(), { target: { value: typed } });
    expect(screen.queryByRole("button", { name: "Tag" }), "an edit dismisses the bar").toBeNull();
    expect(textarea()).toHaveValue(typed);
    await advance(0);
    expect(painted(), "the paint moved with its word before any plugin heard of the edit").toEqual(["quick"]);
    expect(sent.filter((m) => m.type === "surface.open")).toHaveLength(1);
    await advance(300);
    expect(sent.at(-1)).toMatchObject({ type: "surface.open", text: typed });
    await advance(800);
    expect(client.saveNote).toHaveBeenCalledTimes(1);
    expect(client.saveNote).toHaveBeenLastCalledWith(DATE, "Plan.md", typed);
  });

  it("a click on a painted word asks the plugin for its menu and runs the pick; a click elsewhere does not", async () => {
    const frame = sitDown();
    await renderNote();
    frame.paint([{ id: "q", start: 15, end: 20 }]);
    await select(2, 2);
    expect(sent.some((m) => m.type === "range.click")).toBe(false);
    await select(17, 17);
    expect(sent.at(-1)).toMatchObject({ type: "range.click", surface: id, rangeId: "q" });
    frame.menu("q");
    await advance(0);
    fireEvent.click(screen.getByRole("button", { name: "Untag" }));
    expect(sent.at(-1)).toMatchObject({ type: "range.action", surface: id, rangeId: "q", actionId: "untag" });
    expect(screen.queryByRole("button", { name: "Untag" })).toBeNull();
  });

  it("drops the backdrop and the paint when the plugin goes off, leaving the textarea as it was", async () => {
    const frame = sitDown();
    const { client, emit } = await renderNote();
    frame.paint([{ id: "q", start: 15, end: 20 }]);
    expect(painted()).toEqual(["quick"]);
    client.listPlugins.mockResolvedValue([{ ...tagger, enabled: false }]);
    await act(async () => emit({ type: "plugins.changed" }));
    await advance(0);
    expect(backdrop()).toBeNull();
    expect(sent.at(-1)).toMatchObject({ type: "surface.close", surface: id });
    expect(painted()).toEqual([]);
    expect(textarea()).toHaveValue(TEXT);
    expect(textarea().getAttribute("data-note-editor")).toBe("");
  });

  it("shown another note, tells plugins that note's text once it has loaded, and never the first note's text or an empty one under its id", async () => {
    sitDown();
    const fake = await renderNote([tagger], { [`${DATE}/Other.md`]: "other note" });
    const opens = (name: string) => sent.filter((m) => m.type === "surface.open" && (m.surface as { name: string }).name === name).map((m) => m.text);
    expect(opens("Plan.md")).toEqual([TEXT]);
    await act(async () => {
      fake.rerender(
        <StoresProvider rooms={fake.rooms} viewer={fake.viewer} client={fake.client}>
          <NoteView date={DATE} name="Other.md" />
        </StoresProvider>,
      );
    });
    await advance(0);
    expect(textarea()).toHaveValue("other note");
    expect(opens("Other.md"), "the first text plugins hear for the note is the note's").toEqual(["other note"]);
    expect(opens("Plan.md"), "the first note heard nothing more").toEqual([TEXT]);
    expect(sent.filter((m) => m.type === "surface.close")).toEqual([{ rooms: "surface", v: 1, type: "surface.close", surface: id }]);
  });

  it("names the surface by the folded file name, so a rename changes it and a case change does not", async () => {
    sitDown();
    await renderNote();
    expect(surfaceKey(id)).toBe(`note:${DATE}/plan.md`);
    expect(sent.at(-1)).toMatchObject({ type: "surface.open", surface: { kind: "note", date: DATE, name: "Plan.md" } });
  });
});

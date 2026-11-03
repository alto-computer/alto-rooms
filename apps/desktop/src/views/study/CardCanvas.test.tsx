import { act, cleanup, createEvent, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { StudyCard } from "@alto-rooms/protocol-ts";
import type { Editor } from "@tiptap/react";
import { fakeFlowLayout } from "@/test/flow";
import { renderWithStores, studyCard, studyVolume, type FakeStudyRoom } from "@/test/fakes";
import { SAVE_DELAY_MS } from "./CardCanvas";
import { VolumePage } from "./VolumePage";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeAll(fakeFlowLayout);

const room = (cards: StudyCard[], published = false): FakeStudyRoom => ({
  id: "s000000101",
  name: "어텐션",
  createdAt: "2026-10-01T00:00:00Z",
  links: [],
  volumes: [studyVolume(1, { title: "병목", cards, ...(published ? { publishedAt: "2026-10-12T00:00:00Z" } : {}) }), ...(published ? [studyVolume(2)] : [])],
});

const section = (id: string, extra: Partial<StudyCard> = {}) => studyCard(id, { kind: "section", width: 600, height: 400, body: "읽기", ...extra });

type Saved = { cards: StudyCard[] };
const lastSaved = (client: { saveStudyVolume: unknown }) => vi.mocked(client.saveStudyVolume as (...a: unknown[]) => unknown).mock.calls.at(-1)?.[2] as Saved | undefined;
const savedCard = (client: { saveStudyVolume: unknown }, id: string) => lastSaved(client)?.cards.find((c) => c.id === id);
const settle = () => act(() => new Promise((r) => setTimeout(r, SAVE_DELAY_MS + 100)));

/** Drags `el` by (dx, dy) the way a mouse does: d3-drag, under React Flow, follows the press's window. */
async function drag(el: Element, dx: number, dy: number) {
  const at = { clientX: 50, clientY: 20 };
  const fire = (target: Element | Window, make: typeof createEvent.mouseDown, x: number, y: number) => {
    const e = make(target, { clientX: x, clientY: y, button: 0 });
    // jsdom refuses its own window as `view` in an event's init; d3-drag only reads it.
    Object.defineProperty(e, "view", { value: window });
    fireEvent(target, e);
  };
  fire(el, createEvent.mouseDown, at.clientX, at.clientY);
  for (const t of [0.5, 1]) fire(window, createEvent.mouseMove, at.clientX + dx * t, at.clientY + dy * t);
  fire(window, createEvent.mouseUp, at.clientX + dx, at.clientY + dy);
  await act(async () => {});
}

const editorOf = (el: HTMLElement) => (el as HTMLElement & { editor: Editor }).editor;

describe("a section", () => {
  it("carries the cards wholly inside it when dragged by its title bar, and leaves the rest", async () => {
    const cards = [section("s"), studyCard("in", { x: 40, y: 80, body: "안" }), studyCard("out", { x: 800, y: 80, body: "밖" }), studyCard("edge", { x: 500, y: 80, body: "걸침" })];
    const { client, container } = await renderWithStores(<VolumePage roomId="s000000101" number={1} />, { studyRooms: [room(cards)] });
    await screen.findAllByTestId("ink-card");
    expect(screen.getByRole("textbox", { name: "Section title" })).toHaveValue("읽기");

    await drag(container.querySelector(".st-secbar")!, 100, 50);
    await waitFor(() => expect(client.saveStudyVolume).toHaveBeenCalled(), { timeout: SAVE_DELAY_MS + 1000 });
    const moved = savedCard(client, "s")!;
    expect(moved.x).toBeGreaterThan(40);
    expect(moved.y).toBeGreaterThan(20);
    expect(moved).toMatchObject({ width: 600, height: 400 });
    expect(savedCard(client, "in")).toMatchObject({ x: 40 + moved.x, y: 80 + moved.y });
    // Outside, and half in (its right edge, x 500 + 280, sticks out of the frame): neither moves.
    expect(savedCard(client, "out")).toMatchObject({ x: 800, y: 80 });
    expect(savedCard(client, "edge")).toMatchObject({ x: 500, y: 80 });

  });

  it("keeps a width and a height dragged at its corner, and a card keeps a width dragged at its edge", async () => {
    const cards = [section("s"), studyCard("a", { x: 800, y: 0, body: "카드" })];
    const { client, container } = await renderWithStores(<VolumePage roomId="s000000101" number={1} />, { studyRooms: [room(cards)] });
    await screen.findByTestId("ink-card");

    await drag(container.querySelector(".st-secrz")!, 120, 80);
    await drag(screen.getByTestId("ink-card").querySelector(".st-rz")!, 60, 30);
    await waitFor(() => expect(savedCard(client, "a")!.width).toBeGreaterThan(280), { timeout: SAVE_DELAY_MS + 1000 });
    const frame = container.querySelector<HTMLElement>(".react-flow__node-section")!;
    const card = screen.getByTestId("ink-card").closest<HTMLElement>(".react-flow__node")!;
    // What is saved is what the canvas shows.
    expect(savedCard(client, "s")).toMatchObject({ x: 0, y: 0, width: parseFloat(frame.style.width), height: parseFloat(frame.style.height) });
    expect(savedCard(client, "s")!.width).toBeGreaterThan(600);
    expect(savedCard(client, "s")!.height).toBeGreaterThan(400);
    // A card's height is its text's: none is saved, and dragging its edge changed nothing else.
    expect(savedCard(client, "a")).toEqual({ id: "a", kind: "ink", x: 800, y: 0, width: parseFloat(card.style.width), body: "카드" });
  });
});

describe("the canvas tools", () => {
  it("add a text and a section; a section saves its frame's height and its title as its body", async () => {
    const { client } = await renderWithStores(<VolumePage roomId="s000000101" number={1} />, { studyRooms: [room([])] });
    for (const name of ["+ Card", "+ Text", "+ Section", "+ ?"]) await screen.findByRole("button", { name });
    fireEvent.click(screen.getByRole("button", { name: "+ Text" }));
    expect(await screen.findByTestId("text-node")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "+ Section" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Section title" }), { target: { value: "오늘 읽은 것" } });
    await waitFor(() => expect(lastSaved(client)?.cards).toHaveLength(2), { timeout: SAVE_DELAY_MS + 1000 });
    const [text, sec] = lastSaved(client)!.cards;
    expect(text).toMatchObject({ kind: "text", width: 280, body: "" });
    expect(text).not.toHaveProperty("height");
    expect(sec).toMatchObject({ kind: "section", width: 560, height: 360, body: "오늘 읽은 것" });
  });
});

describe("placeholders", () => {
  it("hint at a heading in an empty card and at text in an empty text, only while they can be written in", async () => {
    const cards = [studyCard("a"), studyCard("t", { kind: "text", x: 400 })];
    await renderWithStores(<VolumePage roomId="s000000101" number={1} />, { studyRooms: [room(cards)] });
    const ink = await screen.findByTestId("ink-card");
    await waitFor(() => expect(ink.querySelector(".is-editor-empty")).toHaveAttribute("data-placeholder", "Heading 1"));
    expect(ink.querySelector(".is-editor-empty")?.tagName).toBe("H1");
    expect(screen.getByTestId("text-node").querySelector(".is-editor-empty")).toHaveAttribute("data-placeholder", "Text");
    cleanup();

    await renderWithStores(<VolumePage roomId="s000000101" number={1} />, { studyRooms: [room(cards, true)] });
    const frozen = await screen.findByTestId("ink-card");
    await waitFor(() => expect(within(frozen).getByRole("textbox", { name: "Card" })).toHaveAttribute("contenteditable", "false"));
    expect(document.querySelectorAll("[data-placeholder]")).toHaveLength(0);
  });
});

describe("the side panel", () => {
  it("opens a card as a page whose edits show in the card at once and are saved; Esc closes it", async () => {
    const { client } = await renderWithStores(<VolumePage roomId="s000000101" number={1} />, { studyRooms: [room([studyCard("a", { body: "# 제목\n\n본문" })])] });
    const ink = await screen.findByTestId("ink-card");
    fireEvent.click(within(ink).getByRole("button", { name: "Open" }));
    const panel = await screen.findByRole("complementary", { name: "Opened card" });
    expect(within(panel).getByRole("heading", { level: 2, name: "제목" })).toBeInTheDocument();
    const page = within(panel).getByRole("textbox", { name: "Card" });
    expect(within(page).getByRole("heading", { level: 1, name: "제목" })).toBeInTheDocument();

    act(() => {
      editorOf(page).chain().focus("end").insertContent([{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "소제목" }] }]).run();
    });
    expect(within(ink).getByRole("heading", { level: 2, name: "소제목" })).toBeInTheDocument();
    await waitFor(() => expect(savedCard(client, "a")?.body).toBe("# 제목\n\n본문\n\n## 소제목"), { timeout: SAVE_DELAY_MS + 1000 });

    // And the other way: typed in the card, it shows in the panel, and the panel's heading follows the first line.
    act(() => {
      editorOf(within(ink).getByRole("textbox", { name: "Card" })).chain().setTextSelection(1).insertContent("새 ").run();
    });
    expect(within(page).getByRole("heading", { level: 1, name: "새 제목" })).toBeInTheDocument();
    expect(within(panel).getByRole("heading", { level: 2, name: "새 제목" })).toBeInTheDocument();

    fireEvent.keyDown(page, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
    await settle();
    expect(savedCard(client, "a")?.body).toBe("# 새 제목\n\n본문\n\n## 소제목");
  });

  it("opens from a double-click on the card's frame, says Untitled for an empty card, and closes with its button", async () => {
    await renderWithStores(<VolumePage roomId="s000000101" number={1} />, { studyRooms: [room([studyCard("a")])] });
    const ink = await screen.findByTestId("ink-card");
    fireEvent.doubleClick(within(ink).getByRole("textbox", { name: "Card" }));
    expect(screen.queryByRole("complementary")).toBeNull();
    fireEvent.doubleClick(ink);
    const panel = await screen.findByRole("complementary", { name: "Opened card" });
    expect(within(panel).getByRole("heading", { level: 2, name: "Untitled" })).toBeInTheDocument();
    await waitFor(() => expect(panel.querySelector(".is-editor-empty")).toHaveAttribute("data-placeholder", "Heading 1"));
    fireEvent.click(within(panel).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("only reads on a published volume", async () => {
    const { client } = await renderWithStores(<VolumePage roomId="s000000101" number={1} />, { studyRooms: [room([studyCard("a", { body: "# 제목" })], true)] });
    const ink = await screen.findByTestId("ink-card");
    fireEvent.click(within(ink).getByRole("button", { name: "Open" }));
    const panel = await screen.findByRole("complementary", { name: "Opened card" });
    await waitFor(() => expect(within(panel).getByRole("textbox", { name: "Card" })).toHaveAttribute("contenteditable", "false"));
    await settle();
    expect(client.saveStudyVolume).not.toHaveBeenCalled();
  });
});

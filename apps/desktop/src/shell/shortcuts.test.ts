import { describe, expect, it } from "vitest";
import { allowedWithFocus, isNoteEditor, isTextField, keyAction } from "./shortcuts";

const kd = (key: string, init: KeyboardEventInit = {}) => new KeyboardEvent("keydown", { key, code: `Key${key.toUpperCase()}`, metaKey: true, ...init });

describe("shortcuts", () => {
  it("maps ⌘B/⌘W/⌘T/⌘K, including the physical key under a Korean IME", () => {
    expect(keyAction(kd("b"))).toBe("toggle-sidebar");
    expect(keyAction(kd("w"))).toBe("close-tab");
    expect(keyAction(kd("t"))).toBe("new-tab");
    expect(keyAction(kd("k"))).toBe("find");
    expect(keyAction(new KeyboardEvent("keydown", { key: "ㅠ", code: "KeyB", metaKey: true }))).toBe("toggle-sidebar");
    expect(keyAction(kd("w", { shiftKey: true }))).toBeNull();
    expect(keyAction(kd("w", { metaKey: false }))).toBeNull();
    expect(keyAction(kd("x"))).toBeNull();
  });

  it("classifies text fields", () => {
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    const note = document.createElement("textarea");
    note.setAttribute("data-note-editor", "");
    const editable = document.createElement("div");
    editable.contentEditable = "true";
    // jsdom does not implement isContentEditable.
    Object.defineProperty(editable, "isContentEditable", { value: true });
    const button = document.createElement("button");
    expect([input, textarea, note, editable].every(isTextField)).toBe(true);
    expect(isTextField(button)).toBe(false);
    expect(isTextField(null)).toBe(false);
    expect(isNoteEditor(note)).toBe(true);
    expect(isNoteEditor(textarea)).toBe(false);
  });

  it("in a text field only ⌘K works, plus ⌘W from the note body", () => {
    const input = document.createElement("input");
    const note = document.createElement("textarea");
    note.setAttribute("data-note-editor", "");
    for (const a of ["toggle-sidebar", "new-tab", "close-tab"] as const) expect(allowedWithFocus(a, input)).toBe(false);
    expect(allowedWithFocus("find", input)).toBe(true);
    expect(allowedWithFocus("close-tab", note)).toBe(true);
    expect(allowedWithFocus("new-tab", note)).toBe(false);
    expect(allowedWithFocus("toggle-sidebar", note)).toBe(false);
    expect(allowedWithFocus("close-tab", document.body)).toBe(true);
    expect(allowedWithFocus("toggle-sidebar", null)).toBe(true);
  });
});

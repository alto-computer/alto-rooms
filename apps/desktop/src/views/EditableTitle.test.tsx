import { RoomsApiError } from "@alto-rooms/protocol-ts";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditableTitle } from "./EditableTitle";

afterEach(cleanup);

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("EditableTitle", () => {
  it("click edits, Enter saves, input is disabled while saving", async () => {
    const d = deferred();
    const onSave = vi.fn(() => d.promise);
    render(<EditableTitle value="벤치마크" onSave={onSave} ariaLabel="Room name" />);
    fireEvent.click(screen.getByRole("heading", { name: "벤치마크" }));
    const input = screen.getByRole("textbox", { name: "Room name" });
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "벤치" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSave).toHaveBeenCalledWith("벤치");
    expect(input).toBeDisabled();
    fireEvent.blur(input); // no second save while one is in flight
    expect(onSave).toHaveBeenCalledTimes(1);
    await act(async () => d.resolve());
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("Escape cancels without saving", () => {
    const onSave = vi.fn(async () => {});
    const onCancel = vi.fn();
    render(<EditableTitle value="벤치마크" onSave={onSave} onCancel={onCancel} ariaLabel="Room name" />);
    fireEvent.click(screen.getByRole("heading", { name: "벤치마크" }));
    const input = screen.getByRole("textbox", { name: "Room name" });
    fireEvent.change(input, { target: { value: "x" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onSave).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "벤치마크" })).toBeInTheDocument();
  });

  it("an unchanged value exits without saving", () => {
    const onSave = vi.fn(async () => {});
    render(<EditableTitle value="벤치마크" onSave={onSave} ariaLabel="Room name" />);
    fireEvent.click(screen.getByRole("heading", { name: "벤치마크" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Room name" }), { key: "Enter" });
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("a rejected save stays in edit mode and shows the mapped copy", async () => {
    const onSave = vi.fn(async () => {
      throw new RoomsApiError(400, "bad", "invalid_room_name");
    });
    render(<EditableTitle value="벤치마크" onSave={onSave} ariaLabel="Room name" />);
    fireEvent.click(screen.getByRole("heading", { name: "벤치마크" }));
    const input = screen.getByRole("textbox", { name: "Room name" });
    fireEvent.change(input, { target: { value: "a/b" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(screen.getByText("That name can't be used")).toBeInTheDocument();
    expect(input).toBeEnabled();
    expect(input).toHaveValue("a/b");
    expect(input).toHaveAttribute("aria-invalid", "true");
  });

  it("readOnly renders plain text", () => {
    render(<EditableTitle value="벤치마크" onSave={async () => {}} ariaLabel="Room name" readOnly />);
    fireEvent.click(screen.getByRole("heading", { name: "벤치마크" }));
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});

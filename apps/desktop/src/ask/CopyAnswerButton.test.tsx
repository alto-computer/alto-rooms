import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { CopyAnswerButton } from "./CopyAnswerButton";

function mockClipboard(writeText: () => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn(writeText) }, configurable: true });
  return navigator.clipboard.writeText as ReturnType<typeof vi.fn>;
}

function setup() {
  render(<><CopyAnswerButton text="the answer" /><Toaster /></>);
  return screen.getByRole("button", { name: "Copy answer" });
}

describe("CopyAnswerButton", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("copies, flips to a check, and toasts", async () => {
    const writeText = mockClipboard(() => Promise.resolve());
    const btn = setup();
    expect(btn.getAttribute("data-copied")).toBeNull();
    fireEvent.click(btn);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("the answer"));
    await waitFor(() => expect(btn.getAttribute("data-copied")).toBe("true"));
    expect(await screen.findByText("Copied")).toBeTruthy();
    const toaster = document.querySelector("[data-sonner-toaster]");
    expect(toaster?.getAttribute("data-y-position")).toBe("top");
    expect(toaster?.getAttribute("data-x-position")).toBe("center");
  });

  it("toasts on every click, even while still showing the check", async () => {
    mockClipboard(() => Promise.resolve());
    const success = vi.spyOn(toast, "success");
    const btn = setup();
    fireEvent.click(btn);
    await waitFor(() => expect(success).toHaveBeenCalledTimes(1));
    fireEvent.click(btn);
    await waitFor(() => expect(success).toHaveBeenCalledTimes(2));
  });

  it("toasts when the clipboard refuses", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockClipboard(() => Promise.reject(new Error("no")));
    const btn = setup();
    fireEvent.click(btn);
    expect(await screen.findByText("Couldn't copy")).toBeTruthy();
    expect(btn.getAttribute("data-copied")).toBeNull();
  });
});

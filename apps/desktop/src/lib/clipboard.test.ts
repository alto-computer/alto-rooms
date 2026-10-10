import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

/** What the browser gives ClipboardItem: the types and their promised data. */
class FakeClipboardItem {
  constructor(public data: Record<string, Promise<Blob>>) {}
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  delete (globalThis as { ClipboardItem?: unknown }).ClipboardItem;
});

describe("copyText", () => {
  it("with ClipboardItem, hands the clipboard the promised text at once, so the write stays inside the click", async () => {
    (globalThis as { ClipboardItem?: unknown }).ClipboardItem = FakeClipboardItem;
    const write = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { write }, configurable: true });
    const path = deferred<string>();
    const done = copyText(path.promise);
    expect(write).toHaveBeenCalledTimes(1);
    const [item] = (write.mock.calls[0] as unknown as [FakeClipboardItem[]])[0];
    path.resolve("/Users/me/report.html");
    await done;
    const blob = await item.data["text/plain"];
    expect(blob.type).toBe("text/plain");
    expect(await blob.text()).toBe("/Users/me/report.html");
  });

  it("with ClipboardItem, fails when the text does", async () => {
    (globalThis as { ClipboardItem?: unknown }).ClipboardItem = FakeClipboardItem;
    const write = vi.fn(async (items: FakeClipboardItem[]) => void (await items[0].data["text/plain"]));
    Object.defineProperty(navigator, "clipboard", { value: { write }, configurable: true });
    await expect(copyText(Promise.reject(new Error("not an HTML file")))).rejects.toThrow("not an HTML file");
  });

  it("without ClipboardItem, waits for the text and writes it plainly", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const path = deferred<string>();
    const done = copyText(path.promise);
    expect(writeText).not.toHaveBeenCalled();
    path.resolve("/Users/me/report.html");
    await done;
    expect(writeText).toHaveBeenCalledWith("/Users/me/report.html");
  });
});

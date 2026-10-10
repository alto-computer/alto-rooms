/**
 * Copies text that is still being resolved, within the click that asked for it.
 *
 * WebKit (the app's WKWebView) only allows a clipboard write while it is processing the user's
 * click, and that gesture does not survive a wait on a native call. So the write starts at once,
 * with a ClipboardItem whose text arrives later, which WebKit accepts. Where ClipboardItem is
 * missing (jsdom), the text is awaited and written plainly.
 */
export async function copyText(text: Promise<string>): Promise<void> {
  if (typeof ClipboardItem === "undefined") return navigator.clipboard.writeText(await text);
  const blob = text.then((t) => new Blob([t], { type: "text/plain" }));
  await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
}

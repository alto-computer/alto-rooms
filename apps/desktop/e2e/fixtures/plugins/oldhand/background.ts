// The oldhand's background page for the e2e tests: the messages SDK 0.5 posted, with no `hello`
// and no `api` on them, so the app takes it for a plugin that reads notes as answers. One Mark
// button, and `window.oldhand.heard()` gives every surface message the app sent it.
const heard: Record<string, unknown>[] = [];
window.addEventListener("message", (e) => {
  if (e.source === window.parent && e.data?.rooms === "surface") heard.push(e.data as Record<string, unknown>);
});
const post = (m: Record<string, unknown>) => window.parent.postMessage({ rooms: "surface", v: 1, ...m }, "*");

declare global {
  interface Window {
    oldhand: { heard(): Record<string, unknown>[] };
  }
}
window.oldhand = { heard: () => heard };

post({ type: "actions", items: [{ id: "mark", title: "Mark" }] });
post({ type: "ready" });

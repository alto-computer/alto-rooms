// A content script for the e2e tests: proves it ran inside the document, stored data for it through
// the app, and got its selection action, without touching the document's body.
import { connectContent } from "@alto-rooms/plugin-sdk";

const root = document.documentElement;
root.dataset.marker = "1";

const rooms = connectContent("marker");
rooms.setActions([{ id: "mark", title: "Mark", color: "#ffd400" }]);
rooms.onAction((id, selection) => {
  if (id === "mark") root.dataset.markerSelected = selection?.text ?? "";
});
rooms.onDataChanged((path) => {
  root.dataset.markerChanged = path;
});
rooms.onReveal((anchor) => {
  root.dataset.markerReveal = JSON.stringify(anchor);
  root.dataset.markerReveals = String(Number(root.dataset.markerReveals ?? 0) + 1);
});
rooms.ready();

async function roundTrip() {
  await rooms.storage.write("marks.json", JSON.stringify({ title: document.title }));
  const back = await rooms.storage.read("marks.json");
  root.dataset.markerRead = back ? (JSON.parse(back) as { title: string }).title : "";
}

// The script runs from <head>, before the title is parsed.
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => void roundTrip());
else void roundTrip();

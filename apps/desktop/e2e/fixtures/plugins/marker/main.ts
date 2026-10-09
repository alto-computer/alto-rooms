// The marker's tab for the e2e tests: opens the document whose file key is typed in, with the typed anchor, or twice at once with {"n":1} and {"n":2}.
import { connect } from "@alto-rooms/plugin-sdk";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const rooms = await connect();
const run = (open: (fileKey: string) => Promise<void>) => async () => {
  try {
    await open($<HTMLInputElement>("fileKey").value);
    $("out").textContent = "opened";
  } catch (e) {
    $("out").textContent = `error ${(e as { code?: string }).code}`;
  }
};
$("open").onclick = run((fileKey) => rooms.open({ fileKey, anchor: JSON.parse($<HTMLTextAreaElement>("anchor").value) }));
// Both at once: once the first brings its doc forward, this tab is in the background and its calls stop.
$("twice").onclick = run(async (fileKey) => void (await Promise.all([rooms.open({ fileKey, anchor: { n: 1 } }), rooms.open({ fileKey, anchor: { n: 2 } })])));

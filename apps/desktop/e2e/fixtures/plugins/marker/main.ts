// The marker's tab for the e2e tests: opens the document whose file key is typed in, with the typed anchor.
import { connect } from "@alto-rooms/plugin-sdk";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const rooms = await connect();
$("open").onclick = async () => {
  try {
    await rooms.open({ fileKey: $<HTMLInputElement>("fileKey").value, anchor: JSON.parse($<HTMLTextAreaElement>("anchor").value) });
    $("out").textContent = "opened";
  } catch (e) {
    $("out").textContent = `error ${(e as { code?: string }).code}`;
  }
};

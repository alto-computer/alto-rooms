// An SDK-only plugin for the e2e tests: everything it does goes through @alto-rooms/plugin-sdk.
import { connect, type PluginContext } from "@alto-rooms/plugin-sdk";

const $ = (id: string) => document.getElementById(id)!;
const show = (id: string, text: string) => ($(id).textContent = text);

const rooms = await connect();
let ctx: PluginContext | null = null;
rooms.onContext((c) => {
  ctx = c;
  show("ctx", c.slot === "artifact.sidePanel" ? `doc ${c.artifact.fileKey}` : c.slot);
});
rooms.onBeforeClose(() => rooms.storage.write("closed.txt", "yes"));

$("save").onclick = async () => {
  const key = ctx?.slot === "artifact.sidePanel" ? ctx.artifact.fileKey : "tab";
  await rooms.storage.write("echo.txt", key);
  show("out", `saved ${key}`);
};
$("load").onclick = async () => show("out", `loaded ${(await rooms.storage.read("echo.txt")) ?? "nothing"}`);
$("open").onclick = () => void rooms.open({ fileKey: ($("fileKey") as HTMLInputElement).value });
$("rooms").onclick = async () => {
  try {
    show("out", (await rooms.rooms.list()).map((r) => r.name).join(", "));
  } catch (e) {
    show("out", `error ${(e as { code?: string }).code}`);
  }
};

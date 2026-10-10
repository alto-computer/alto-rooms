// The stamper's background page for the e2e tests: one style, painted over the first three
// characters of every answer. A second surface plugin, so a test can show that one plugin's
// hostile paint leaves another's rules alone.
import { connect, connectSurfaces } from "@alto-rooms/plugin-sdk";

await connect();
const surfaces = connectSurfaces();
surfaces.onOpen((s, text) => surfaces.paint(s, text.length >= 3 ? [{ id: "stamp", start: 0, end: 3, style: "mark" }] : [], { mark: "rgb(0, 0, 255)" }));
surfaces.ready();

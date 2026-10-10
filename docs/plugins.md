# Writing a Rooms plugin

A plugin adds UI to Rooms: a panel beside documents, or a tab of its own (opened from the sidebar's **Plugins** flyout). It runs in a sandboxed iframe and talks to the app only through `@alto-rooms/plugin-sdk`. Rooms never imports plugin code.

Plugins change what you **see**. To change what gets **made** (reports, reviews), use your agent and its skills; their output lands in Rooms as files.

## Layout

```text
~/rooms/.rooms/plugins/<id>/
  manifest.json
  index.html        # the entry (or "entry" in the manifest)
  main.js, assets…  # everything the page needs, bundled
  data/             # your plugin's files; Rooms creates it on first write
```

Install a plugin by copying its built folder there. Rooms notices it and asks the user before it runs.

## manifest.json

```json
{
  "id": "excalidraw",
  "name": "Excalidraw notes",
  "version": "0.1.0",
  "minAppVersion": "0.3.0",
  "description": "Sketch next to any document.",
  "permissions": ["clipboard", "downloads"],
  "slots": {
    "artifact.sidePanel": { "title": "Notes" },
    "tab": { "title": "Goals", "icon": "target", "sidebar": true }
  }
}
```

| Field | Rule |
| --- | --- |
| `id` | `^[a-z0-9][a-z0-9-]{1,39}$`, and the same as the folder name |
| `name` | 1–40 characters |
| `version`, `minAppVersion` | semver. Rooms older than `minAppVersion` won't run the plugin |
| `description` | optional, up to 200 characters, shown when Rooms asks the user |
| `entry` | optional, defaults to `index.html`; not under `data/` |
| `permissions` | any of `rooms.read`, `clipboard`, `downloads`, `artifact.content`, `surfaces.text` |
| `slots` | at least one of the two below, unless the plugin has `contentScripts` or a `background` page. Unknown slots are ignored |
| `contentScripts` | optional, up to 4 `.js` files in the plugin folder, not under `data/`. Needs `artifact.content`, and `artifact.content` needs it. See [Content scripts](#content-scripts) |
| `background` | optional, an `.html` page in the plugin folder, not under `data/`, that runs hidden while the plugin is on. Needs `surfaces.text`, and `surfaces.text` needs it. See [Host text surfaces](#host-text-surfaces) |

Slots:

- `artifact.sidePanel` `{ title, icon? }`: a panel beside an open document. The user opens it from an icon button on the document, `icon` or else `pencil`, with `title` as its tooltip.
- `tab` `{ title, icon?, sidebar? }`: a tab of its own, opened from the sidebar's **Plugins** flyout. `icon` or else `puzzle` marks the tab.

An `icon` is one of `target`, `pencil`, `list-checks`, `calendar`, `star`, `book`, `flag`, `layout-grid`, `sparkles`, `notebook`, `lightbulb`, `puzzle`, `palette`.

Titles are 1–24 characters.

## Permissions

Storing your own files is always allowed. Everything else is declared, and the user sees it before the plugin runs:

| Permission | The user sees | You get |
| --- | --- | --- |
| `rooms.read` | Can see your rooms and documents | `rooms.list()`, `artifacts.list()` |
| `clipboard` | Can copy and paste | clipboard access in the frame |
| `downloads` | Can save files you export | file downloads from the frame |
| `artifact.content` | Can read the text of documents and use the network inside them | your `contentScripts` run inside documents |
| `surfaces.text` | Can read and mark chat answers | your `background` page hears the text of chat answers and paints them |

If a new version asks for more permissions, Rooms asks the user again.

## The SDK

```sh
bun add https://github.com/alto-computer/alto-rooms/releases/download/plugin-sdk-v0.2.0/alto-rooms-plugin-sdk-0.2.0.tgz
```

Build with any bundler; set its base to `./` so every URL in the build is relative. [Goals](https://github.com/alto-computer/rooms-plugin-goals) and [Excalidraw notes](https://github.com/alto-computer/rooms-plugin-excalidraw) are complete examples.

```ts
import { connect } from "@alto-rooms/plugin-sdk";

const rooms = await connect();

rooms.onContext(async (ctx) => {
  if (ctx.slot !== "artifact.sidePanel") return;
  const saved = await rooms.storage.read(`notes/${ctx.artifact.fileKey}.excalidraw`);
  scene.load(saved ? JSON.parse(saved) : EMPTY);
});

const save = debounce(
  () => rooms.storage.write(`notes/${current.fileKey}.excalidraw`, JSON.stringify(scene.serialize())),
  400,
);
rooms.onBeforeClose(async () => {
  await save.flush();
});
```

| Call | What it does |
| --- | --- |
| `connect({ timeoutMs? })` | Connects; resolves once the app sends the first context |
| `onContext(cb)` | Called at once and whenever the context changes (another document in the same panel) |
| `onBeforeClose(cb)` | Runs before your frame closes: panel closed, app quitting, plugin updated or re-permissioned |
| `storage.read(path)` | Text of a file in your `data/`, or `null` |
| `storage.write(path, text)` | Writes atomically; up to 10 MB |
| `storage.list(prefix?)` | Your files under `data/`, sorted |
| `storage.delete(path)` | Removes a file; a missing file is fine |
| `storage.onChange(cb)` | Calls `cb(path)` when one of your files changes from outside the frame: an agent called one of your tools, or another frame of your plugin (a tab, a panel, a content script) wrote it. Never for this frame's own writes. Returns an unsubscribe function |
| `rooms.list()` | Rooms in sidebar order (`rooms.read`) |
| `artifacts.list(roomId)` | Documents in a room, newest first (`rooms.read`) |
| `open({ roomId } \| { fileKey, anchor? })` | Opens a room or document. From a tab, a document opens in a tab next to yours, or its open tab comes forward. A room, or anything opened from a side panel, replaces the current tab. `anchor` is any JSON value up to 4 KiB; your content script gets it in that document through `onReveal` (SDK 0.4.0) |

Errors are `PluginError` with a `code`: `permission_denied`, `invalid_path`, `too_large`, `not_found`, `write_failed`, `unknown_method`, `rate_limited`, `bad_request` (an anchor over 4 KiB or not JSON), `timeout`.

The context is `{ slot: "artifact.sidePanel", artifact }` or `{ slot: "tab" }`. `artifact.fileKey` identifies the original file: it stays the same when Rooms moves the document, and every room that links the same original gets the same key. Key your per-document data by it.

## Tools for agents

A plugin can let agents write into its data by declaring tools in `manifest.json`. Rooms exposes them to agents through `rooms-mcp`, an MCP server that ships with the app; asks from the ask bar get it automatically.

```json
"tools": {
  "draw": {
    "description": "Add shapes to this doc's notes. Call several times to draw step by step.",
    "input": { "type": "object", "required": ["doc", "ops"], "properties": { "doc": { "type": "string" }, "ops": { "type": "array" } } },
    "appendTo": "notes/{doc}.ops.jsonl"
  }
}
```

- `name` is `[a-z][a-z0-9_]{0,39}`; at most 16 tools; `description` 1–500 characters; `input` is a JSON Schema object (`"type": "object"`, up to 16 KB) shown to the agent.
- Every call must include `doc`: a document's `fileKey` or the absolute path of its original. Rooms appends one line, `{"at", "tool", "input"}`, to the `appendTo` file (`{doc}` becomes the fileKey) and your frame hears it through `storage.onChange`. Rooms never checks `input` against the schema: validate it when you read the lines.
- Treat `appendTo` files as append-only from your side: rewriting them can race with an agent's call. Each file is capped at 10 MB.
- Rooms itself never interprets your tools. What a line means is up to your plugin. [Excalidraw notes](https://github.com/alto-computer/rooms-plugin-excalidraw) is a complete example (`draw`).

## Content scripts

A plugin that declares `artifact.content` can list scripts under `contentScripts`, like a browser extension's content scripts.

```json
"permissions": ["artifact.content"],
"contentScripts": ["content.js"]
```

Scripts load in the listed order, so each path may appear once; a repeated path makes the manifest invalid. A plugin with content scripts needs no slot. The user sees "Can read the text of documents and use the network inside them" before it runs, and a changed content script changes the plugin's `rev`.

Rooms loads content scripts into the document a doc tab shows, as `<script src>` tags after its own selection bridge. The block is spliced in where the HTML parser opens the head. That is right after `<head>`, or, when the document has no `<head>` before its first other tag or text, before that tag or text. So the scripts run before any `<meta http-equiv="Content-Security-Policy">` the document declares in its head, including a policy of `script-src 'none'`. A UTF-16 document gets no scripts. Card previews in a room grid get no content scripts. Turning the plugin on or off reloads open doc tabs. A changed script loads the next time a doc tab loads, since its URL carries the plugin's `rev`.

A content script runs inside the document's sandbox with the document's own powers, not the plugin frame's:

- It can read and change the page, including its text.
- It can use the network the way the document can, for example `no-cors` requests.
- It can't reach cookies, `localStorage` or IndexedDB (the document's origin is opaque), the roomsd API or its token, or the app window.

### Talking to the app

A content script stores data and adds buttons to the selection bar through `connectContent` from SDK 0.3.0.

```ts
import { connectContent } from "@alto-rooms/plugin-sdk";

const rooms = connectContent("highlight");
rooms.setActions([{ id: "yellow", title: "Highlight", color: "#ffd400" }]);
rooms.onAction(async (id, selection) => {
  if (!selection) return;
  paint(selection.range);
  await rooms.storage.write("highlights.json", JSON.stringify(save()));
});
rooms.onDataChanged((path) => path === "highlights.json" && repaint());
rooms.ready();
```

| Call | What it does |
| --- | --- |
| `storage.read/write/list/delete` | Your data for this document only. Paths are relative to `docs/<fileKey>/` in your `data/`, so your tab or panel finds them there. Up to 1 MiB a write, 20 writes or deletes a second, and 100 reads or lists a second for the document |
| `setActions(items)` | Replaces your buttons in the selection bar, shown after Ask: up to 6 `{ id, title, color? }`, titles cut to 24 characters with control and bidi formatting characters removed, `color` any CSS color |
| `onAction(cb)` | Calls `cb(id, selection)` when one of your buttons is clicked. `selection` is the last `{ text, range }` selected in the document, since the click can clear the live selection |
| `onDataChanged(cb)` | Calls `cb(path)` when another frame of your plugin changed a file in this document's folder |
| `onReveal(cb)` | Calls `cb(anchor)` with the anchor your plugin passed to `open({ fileKey, anchor })` for this document, once per open, after `ready()` (SDK 0.4.0). When a second `open` for the same document arrives before your script is ready, the script gets only the later anchor. The document can read it and post a fake one, so treat it as untrusted |
| `ready()` | Tells the app the script is listening |

Messages are `{ rooms: "content", v: 1, plugin, type, … }` posted to `window.parent`, and the SDK trusts only messages whose source is `window.parent`.

The app can stop listening while your script keeps running, for example while the document's tab is in the background. When it listens again, it posts `sync`, and SDK 0.4.0 answers by repeating your last `setActions` and `ready()`. A script built with SDK 0.3 ignores `sync`, so after such a gap its buttons stay missing and anchors wait until the document reloads.

### What a hostile document can do

The document's own script shares the window with your content script and can post the same messages. Rooms takes the document's `fileKey` from the tab, never from a message, and accepts only plugin ids that are on and declare `artifact.content`. So a hostile document can read, forge, or delete your files under `docs/<its fileKey>/`, and nothing else: not another document's folder, not the rest of your `data/`, not another plugin's data, and not the token. Two content plugins in one document share the window too, so each can reach the other's folder for that document. Treat every file under `docs/` as untrusted input, and render its text as text.

## Host text surfaces

Text the app itself shows, like a chat answer, is host DOM: no plugin code runs there. A plugin that declares `surfaces.text` and a `background` page can still read and mark it. The app runs the page in a hidden frame, under the same sandbox and CSP as a tab or panel, for as long as the plugin is on. One frame per plugin, next to the one its tab or panel may have.

```json
"permissions": ["surfaces.text"],
"background": "background.html"
```

The page uses `connect()` for storage and `open`, and `connectSurfaces` from SDK 0.5.0 for the surfaces.

```ts
import { connect, connectSurfaces, surfacePath } from "@alto-rooms/plugin-sdk";

const rooms = await connect();
const surfaces = connectSurfaces("highlight");
surfaces.setActions([{ id: "yellow", title: "Highlight", color: "#ffd400" }]);
surfaces.onOpen(async (surface, text) => {
  const saved = JSON.parse((await rooms.storage.read(`${surfacePath(surface)}.json`)) ?? "[]");
  surfaces.paint(surface, saved.map((h) => ({ id: h.id, start: text.indexOf(h.quote), end: text.indexOf(h.quote) + h.quote.length, color: "amber" })));
});
surfaces.onAction((id, { surface, start, end, text }) => save(surface, { quote: text, start, end }));
surfaces.onRangeClick((surface, rangeId) => surfaces.menu(surface, rangeId, [{ id: "delete", title: "Delete" }]));
surfaces.ready();
```

| Call | What it does |
| --- | --- |
| `onOpen(cb)` | Calls `cb(surface, text)` when an answer is on screen, for every open answer right after `ready()`, and again when an answer's text changes. `surface` is `{ kind: "answer", scope, turnId }`, `scope` one of `{ kind: "doc", fileKey }`, `{ kind: "room", roomId }`, `{ kind: "day", date }`. `text` is the answer's text content, so offsets you store point into it; keep the quote and some context too, and re-anchor on each open |
| `onClose(cb)` | The answer left the screen. Its paint went with it |
| `setActions(items)` | Replaces your buttons in the selection bar over answers, shown after Ask: up to 6 `{ id, title, color? }`, as for content scripts |
| `onAction(cb)` | Calls `cb(id, { surface, start, end, text })` when one of your buttons is clicked over a selection in an answer |
| `paint(surface, ranges)` | Replaces your ranges on that answer: up to 1,000 `{ id, start, end, color }`. `color` is one of `amber`, `green`, `red`, `violet`, `blue`, `gray`; the app owns the paint and draws it with the CSS Custom Highlight API, so the answer's DOM never changes. A range outside the text, a repeated id, or another color is dropped; the rest paint |
| `onRangeClick(cb)` | The user clicked one of your painted ranges. Answer with `menu(surface, rangeId, items)` to show up to 6 buttons there, or do nothing |
| `onRangeAction(cb)` | Calls `cb(surface, rangeId, actionId)` when the user picks from that menu |
| `rooms.open({ surface, rangeId })` | Opens the thread that holds the answer, unfolds it, and flashes your range once you have painted it |
| `surfaceKey(surface)`, `surfacePath(surface)` | The answer's name, `answer:doc:<fileKey>/<turnId>`, and the same as a storage path, `answer/doc/<fileKey>/<turnId>` |

Messages are `{ rooms: "surface", v: 1, type, … }` posted to `window.parent`, and the SDK trusts only messages whose source is `window.parent`. The background frame has no network and no token, like every plugin frame, so what it reads stays in your `data/`. Notes become a surface in a later release; the `surface.kind` tells them apart.

## Rules of the sandbox

- **Paths** are relative to `data/`: 1–200 characters, `/`-separated segments of `A–Z a–z 0–9 . _ -`, no `.` or `..`, at most 8 deep.
- **No network** in the plugin frame. `fetch` to anywhere is blocked. Bundle your fonts, images and wasm into the plugin folder.
- **Your files only.** You can't read other plugins' data or Rooms' own state. Only content scripts see document contents, and only a background page with `surfaces.text` sees chat answers.
- **Save as you go.** Switching tabs closes your frame right away; `onBeforeClose` is reliable when the panel closes or the app quits, but not on a tab switch. Debounce writes to a few hundred milliseconds.
- **Stay responsive.** If your frame stops answering pings, Rooms shows "This plugin stopped responding" with a Reload button.

## Your data is just files

Everything you store is a plain file under `~/rooms/.rooms/plugins/<id>/data/`. Document its format, and the user's agent can read and change it too (for example, "link this report to my Q4 goal").

## Plugins that ship with the app

The desktop app ships a few plugins, listed in `apps/desktop/bundled-plugins.json` (repo, version, sha256 of the release zip). `bun run plugins` puts their releases in `src-tauri/resources/plugins/`, and the release build includes them.

When the app starts, roomsd installs them into `~/rooms/.rooms/plugins/<id>/` and marks each folder with a `.bundled` file:

- The first time, the plugin is turned on with its permissions; no card asks, unless it declares `artifact.content`.
- A new version replaces the code and keeps `data/`. Its permissions come with the app update, except `artifact.content`. A bundled plugin that declares it for the first time shows the "Updated plugin" card, like a plugin you installed yourself. Once approved, later versions keep it.
- If the user turned it off, it stays off. A deleted folder comes back on the next start, on or off as it was; turn it off in Settings › Plugins to stop using it.
- A folder without the `.bundled` mark is the user's own and is never replaced.

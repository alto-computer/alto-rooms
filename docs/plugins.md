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
| `permissions` | any of `rooms.read`, `clipboard`, `downloads`, `artifact.content` |
| `slots` | at least one of the two below, unless the plugin has `contentScripts`. Unknown slots are ignored |
| `contentScripts` | optional, up to 4 `.js` files in the plugin folder, not under `data/`. Needs `artifact.content`, and `artifact.content` needs it. See [Content scripts](#content-scripts) |

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
| `storage.onChange(cb)` | Calls `cb(path)` when one of your files changes from outside the frame (an agent called one of your tools); returns an unsubscribe function |
| `rooms.list()` | Rooms in sidebar order (`rooms.read`) |
| `artifacts.list(roomId)` | Documents in a room, newest first (`rooms.read`) |
| `open({ roomId } \| { fileKey })` | Opens a room or document in the current tab |

Errors are `PluginError` with a `code`: `permission_denied`, `invalid_path`, `too_large`, `not_found`, `write_failed`, `unknown_method`, `timeout`.

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

## Rules of the sandbox

- **Paths** are relative to `data/`: 1–200 characters, `/`-separated segments of `A–Z a–z 0–9 . _ -`, no `.` or `..`, at most 8 deep.
- **No network** in the plugin frame. `fetch` to anywhere is blocked. Bundle your fonts, images and wasm into the plugin folder.
- **Your files only.** You can't read other plugins' data or Rooms' own state. Only content scripts see document contents.
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

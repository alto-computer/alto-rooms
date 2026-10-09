<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.svg">
    <img src="assets/banner-light.svg" alt="Alto Rooms" width="100%">
  </picture>
</h1>

Alto Rooms collects the HTML files your coding agents write and shows them in one place, sorted by topic.

<img src="assets/screenshot-room.png" alt="A room in Alto Rooms" width="100%">

## Why

Agents like Claude Code and Codex write specs, reports, and reviews as HTML. These files end up spread across repos and folders. Rooms gathers them into one place, where you can browse them.

## Concepts

- **Room**: a topic. One folder in `~/rooms`, or an existing folder you link.
- **Artifact**: one HTML file in a room. It can be a symlink to a file that lives elsewhere.
- **Journal**: one page per day. It shows the artifacts created that day, next to your own notes. Today's page is home: a new tab opens on it.

## How it works

- Write an `.html` file into a room folder. It shows up in the app within two seconds.
- While the app is open, HTML your agents (Claude Code, Codex, Aside) write anywhere is linked into `inbox` on its own, and auto-sort moves it on to the room named like its repo. See [Collecting](#collecting) and [Auto-sort](#auto-sort).
- Rooms never moves your files, and never writes into a folder you linked.
- Drag rooms in the sidebar to reorder them.

Rooms does not run agents. It calls an AI model only if you turn on [auto-sort](#auto-sort) with your own TypeSafe key.

## Install

There is no prebuilt release yet. Build it from source on macOS.

Requirements: [Rust](https://rustup.rs) (stable) and [Bun](https://bun.sh).

```sh
git clone https://github.com/alto-computer/alto-rooms.git
cd alto-rooms
bun install
cd apps/desktop
bun run sidecar        # build roomsd, rooms-mcp, rooms-collect and rooms-sort
bun run tauri build    # build the app
```

Then copy `src-tauri/target/release/bundle/macos/Alto Rooms.app` to `/Applications`.

## Sort your existing files

Ask your agent:

```text
Read ~/rooms/ONBOARD.md and follow it.
```

The agent installs a small `rooms` skill. It then finds the HTML files you wrote in the last 14 days and links each one into a room. Your original files stay where they are.

After that, new files are linked on their own while the app is open. Ask your agent to "sort my inbox" now and then.

## Collecting

`rooms-collect` runs beside the app (and stops with it). It reads the logs Claude Code (`~/.claude/projects`), Codex (`~/.codex/sessions`) and Aside (`~/.aside/u`) already keep, read-only, and:

- links each new `.html` an agent writes into `inbox` (and notes it in `~/rooms/.rooms/collect/linked.jsonl`). It never chooses a room, never creates rooms, and never re-adds a link you deleted;
- records which conversation wrote each file in `~/rooms/.rooms/sources.json`, so asking about a document continues that conversation;
- keeps a copy of the logs in `~/Library/Application Support/computer.alto.rooms/archive` (agents delete old logs; Claude Code after 30 days);
- indexes the last 30 days of conversations for search:

```sh
rooms-collect search "pricing page" --since 7d
```

Settings live in `~/rooms/.rooms/collect.toml` (all optional):

```toml
enabled = true        # false: read nothing, link nothing
history_days = 30     # how far back search reaches; 0 turns the index off
archive = true        # keep copies of the logs

[agents]
claude-code = true
codex = true
aside = true
```

## Auto-sort

`rooms-sort` runs every minute while the app is open. It only moves links `rooms-collect` put in `inbox`, never ones you or your agent put there, and the first rule that matches decides:

| Rule | Needs a key | Moves the doc |
|---|---|---|
| R1 | no | to the room named like its git repo |
| R2 | no | to the room R4 once made for its repo, even after you rename it |
| R3 | yes | to the room TypeSafe Jev picks, when it is at least 70% sure |
| R4 | yes | nowhere yet: a vote for its repo; at 3 votes a room named after the repo is made and they move in |
| R5 | | stays in `inbox` |

To turn on R3 and R4, paste a [TypeSafe key](https://console.typesafe.ai/keys) into **Settings › Auto-sort** (`⌘,`), which also shows the last run and undoes it. The key is kept in the macOS Keychain; `TYPESAFE_API_KEY` in the app's environment wins over it. For each doc, Jev gets its title, its path inside the repo and its first 2,000 characters, plus each room's name and five recent titles.

```sh
rooms-sort log            # every decision with its rule and reason
rooms-sort run --dry-run  # what would move now
rooms-sort undo           # put the last run's docs back in the inbox
```

Settings live in `~/rooms/.rooms/sort.toml` (all optional): `enabled`, `min_confidence` (0.7), `new_room_min_docs` (3), `model`, `max_docs_per_run`, `ignore_names`.

## For agents

Write an HTML file into `~/rooms/<room>/`. That's all.

Optional `<meta>` tags:

| Tag | Use |
| --- | --- |
| `rooms:title` | Title shown on the card. Defaults to `<title>`, then the file name. |
| `rooms:created` | Creation time (ISO 8601). Defaults to when Rooms first sees the file. |
| `rooms:agent`, `rooms:session`, `rooms:cwd`, `rooms:machine` | Where the file came from. |

Rooms ignores hidden files, `node_modules`, `dist`, `build`, and anything listed in a `.roomsignore` file (same syntax as `.gitignore`).

## Plugins

Plugins add UI: a panel beside documents or a tab of their own. They run sandboxed and keep their data as files.

Two come with the app, on by default:

- [Goals](https://github.com/alto-computer/rooms-plugin-goals): long-, mid- and short-term goals and a TODO list, with documents linked to each.
- [Excalidraw notes](https://github.com/alto-computer/rooms-plugin-excalidraw): sketch beside any document; export as PNG.

Right-click a plugin in the sidebar to turn it off. To add another, copy its folder into `~/rooms/.rooms/plugins/`; Rooms asks before it runs. To write one, see [docs/plugins.md](docs/plugins.md).

## Shortcuts

| Key | Action |
| --- | --- |
| `⌘T` / `⌘W` | New tab (today's Journal) / close tab |
| `⌘K` | Find a room or document |
| `⌘B` | Toggle the sidebar |
| `⌘,` | Settings |
| `⌘[` / `⌘]`, `⌘←` / `⌘→` | Back / forward |
| `⌘`-click | Open in a new tab |

## Architecture

- **roomsd** (Rust) watches `~/rooms` and serves a local HTTP API on `127.0.0.1:4317`.
- **rooms-collect** (Rust) reads agent logs and talks to Rooms only through folders: the symlinks it makes in `~/rooms/inbox` reach roomsd through its usual file watching.
- **rooms-sort** (Rust) moves those links to rooms through roomsd's API. Its rules are one function, `rules::decide`.
- **The desktop app** (Tauri + React) is one client of that API. You can build your own.
- `GET /v1/rooms` lists rooms. `GET /v1/events` streams changes. Write requests need the token in `~/rooms/.rooms/token`.

```text
crates/rooms-core       indexing, file watching, rooms, notes
crates/roomsd           HTTP API and event stream
crates/rooms-collect    agent-log collector: links, sources, archive, search
crates/rooms-sort       inbox sorter: rules R1–R5, TypeSafe Jev
crates/rooms-protocol   API types
packages/protocol-ts    TypeScript client
apps/desktop            Tauri app
```

## Develop

```sh
cd apps/desktop
bun run sidecar
bun run tauri dev      # run the app
bun run test           # unit tests
cargo test             # Rust tests (from the repo root)
```

## Status

This is an early version (0.6). It has been tested on macOS only.

## License

[MIT](LICENSE)

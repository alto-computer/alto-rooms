# Glossary

Alto Rooms uses one word for each thing, in the UI, in code, on the wire, in file names and in events. Use these words in new code and docs. A check in the test suite fails when an old word comes back (see [Enforcement](#enforcement)).

## Words

**room**
: A topic folder, `~/rooms/<room>`, or an existing folder the user linked. The **inbox** is the room where unsorted artifacts land. The Journal has a room of its own (`journalRoomId`) that holds its day files.

**artifact**
: One agent-written HTML file in a room. Code, routes, tab kinds and ask scopes say `artifact`. Do not say "doc" or "document" for it. "Document" stays only where it means a generic HTML document, as in DOM and iframe code (`document.body`, "the document's own script").

**session**
: One agent run: a Claude Code, Codex or Aside log. Code uses three layers, each with its own name:

| Layer | Type | What it is |
| --- | --- | --- |
| id | `SessionId` | The id string the agent issued. Validated: `^[A-Za-z0-9_-]{1,128}$`, and it never starts with `-`, because it ends up in a resume command line. |
| pointer | `SessionRef { agent, id }` | Names one session. URLs, ask scopes, room membership keys and events use it. |
| record | `Session { agent, id, title, cwd, startedAt, endedAt, messages, lastReply, artifactsWritten, roomId }` | What the Journal and a room show. `agent` and `id` are flattened into it, so code reads `session.agent` and `session.id`. |

Naming rule: a variable named `session` holds a `Session`. A variable that holds the id string is `sessionId` (or `id` inside a session's own code). A variable that holds the pointer is `sessionRef`.

Two wire fields keep the name `session` for a `SessionId` value, because files and agents already write them:

- `artifact.source.session`, written by `rooms-collect` into `sources.json` and by agents as `<meta name="rooms:session">`. Turn a source into a pointer with `sourceSessionRef(source)` (TypeScript) or `Source::session_ref()` (Rust). Do not build a `SessionRef` from a source by hand.
- `AskTurn.session`, the ask agent's own session a turn ran in, stored in the ask logs.

**journal**
: The per-day view. A **day** is one date in it. The ask scope for a day is `day`.

**note**
: The owner's own Markdown in the Journal.

**conversation**
: Only the ask bar's question-and-answer chat, and only in UI copy: "New conversation", "Conversation summarized", "Couldn't save the conversation". In code the chat is a **thread** (`ThreadSheet`, an ask scope's thread).

## Where each word appears

| Thing | Rust | TypeScript | Wire and files |
| --- | --- | --- | --- |
| artifact | `Artifact`, `AskScope::Artifact` | `Artifact`, tab kind `artifact`, `ArtifactView`, `useOpenArtifact` | ask scope `{ kind: "artifact", fileKey }`, scope key `artifact:<fileKey>` |
| session | `Session`, `SessionRef`, `SessionId`, module `sessions` | `Session`, `SessionRef`, tab kind `session`, `SessionView`, `useSession` | `GET /v1/sessions/{agent}/{id}`, `PUT /v1/sessions/{agent}/{id}/room`, `GET /v1/rooms/{room_id}/sessions`, event `session.moved`, ask scope `{ kind: "session", agent, id }`, scope key `session:<agent>:<id>`, `~/rooms/.rooms/sessions.json`, ask log `session-<agent>-<id>.jsonl`, Tauri command `continue_session` |
| thread | `asks` module | `ThreadSheet`, `useThread` | one ask log per scope under `~/rooms/.rooms/asks/` |

## Kept on purpose

Some names keep "doc" because something outside this repository reads or writes them:

- Plugin data for one artifact lives under `docs/<fileKey>/` in the plugin's data folder. Plugins that are already installed have files there, and their content scripts address them by that path. Renaming it would lose their data.
- A plugin tool's `appendTo` path may use the `{doc}` placeholder, and the tool's input names the artifact in a `doc` field. Published plugin manifests (Excalidraw notes) and the agents that call those tools through `rooms-mcp` use these names.

## Migrations

roomsd and the app move old names to new ones the first time they run. Each step is safe to run again.

- `~/rooms/.rooms/conversations.json` becomes `sessions.json`. The old file is kept as `conversations.json.bak`.
- Ask logs named `conversation-<agent>-<session>.jsonl` are renamed to `session-<agent>-<id>.jsonl`.
- Saved tabs and tab history of kind `conversation` become kind `session`, and kind `doc` becomes kind `artifact`.
- Unsent ask drafts saved under a `conversation:` scope key move to the `session:` key.
- `sort.toml` still accepts `new_room_min_docs` and `max_docs_per_run`, read as `new_room_min_artifacts` and `max_artifacts_per_run`.

## Enforcement

`scripts/check-terms.mjs` runs in `bun run test`. It fails when a Rust or TypeScript identifier contains `conversation` (any case), or when app code has a `doc` or `Doc` identifier, outside the allowlist at the top of the script. The allowlist holds the ask-thread UI strings, the migration code and this glossary. To add an exception, add it there with the reason.

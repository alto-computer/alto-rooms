# Glossary

Alto Rooms uses one word for each thing, in the UI, in code, on the wire, in file names and in events. Use these words in new code and docs. A test fails when an old word comes back as a name in code (see [Enforcement](#enforcement)).

## Words

**room**
: A topic folder, `~/rooms/<room>`, or an existing folder the user linked. The **inbox** is the room where unsorted artifacts land. The Journal has a room of its own (`journalRoomId`) that holds its day files.

**artifact**
: One agent-written HTML file in a room. Code, routes, tab kinds and ask scopes say `artifact`. Do not say "doc" for it. "Document" stays only where it means a generic HTML document, as in DOM, iframe and content-script code (`document.body`, "the document's own script").

**session**
: One agent run: a Claude Code, Codex or Aside log. Code uses three layers, each with its own name:

| Layer | Type | What it is |
| --- | --- | --- |
| id | `SessionId` | The id string the agent issued. Validated as `^[A-Za-z0-9_-]{1,128}$`, and never starting with `-`, because it ends up in a resume command line. TypeScript checks the same rule with `isSessionId`. |
| pointer | `SessionRef { agent, id }` | Names one session. URLs, ask scopes, room membership keys and the drag payload use it. |
| record | `Session { agent, id, title, cwd, startedAt, endedAt, messages, lastReply, artifactsWritten, roomId }` | What the Journal and a room show. `agent` and `id` are flattened into it, so code reads `session.agent` and `session.id`, and a `Session` can be passed where a `SessionRef` is expected. |

Naming rule: a variable named `session` holds a `Session`. A variable that holds the id string is `sessionId` (or `id` inside session code). A variable that holds the pointer is `sessionRef`.

Three names keep `session` or `sessionId` for a `SessionId` value:

- `artifact.source.session`, which `rooms-collect` writes into `sources.json` and agents write as `<meta name="rooms:session">`. Turn a source into a pointer with `sourceSessionRef(source)` (TypeScript, `lib/sessions.ts`) or `Source::session_ref()` (Rust). Do not build a `SessionRef` from a source by hand.
- `AskTurn.session`, the ask agent's own session a turn ran in, stored in the ask logs.
- A session tab is `{ id, kind: "session", agent, sessionId }`. The field is `sessionId`, not `id`, because every tab already has an `id`, and it matches `roomId` and `artifactId` on the other tabs.

**journal**
: The per-day view. A **day** is one date in it. The ask scope for a day is `day`.

**note**
: The owner's own Markdown in the Journal.

**conversation**
: Only the ask bar's question-and-answer chat, and only in UI copy: "New conversation", "Conversation summarized", "continuing this conversation", "Couldn't save the conversation". In code the chat is a **thread** (`ThreadSheet`, a scope's thread in `AsksStore`).

## Where each word appears

| Thing | Rust | TypeScript | Wire and files |
| --- | --- | --- | --- |
| artifact | `Artifact`, `AskScope::Artifact` | `Artifact`, tab `{ kind: "artifact", roomId, artifactId }`, `ArtifactView`, `useOpenArtifact` | ask scope `{ kind: "artifact", fileKey }`, scope key `artifact:<fileKey>`, files server `?tab=1` for the artifact-tab variant, Tauri commands `artifact_original`, `reveal_artifact`, `open_artifact` |
| session | `Session`, `SessionRef`, `SessionId`, modules `rooms_core::sessions` and `rooms_collect::sessions` | `Session`, `SessionRef`, tab `{ kind: "session", agent, sessionId }`, `SessionView`, `useSession`, `useRoomSessions`, `lib/sessions.ts` | `GET /v1/sessions/{agent}/{id}`, `PUT /v1/sessions/{agent}/{id}/room`, `GET /v1/rooms/{room_id}/sessions`, event `session.moved { session, fromRoomId }`, `JournalDay.sessions`, ask scope `{ kind: "session", agent, id }`, scope key `session:<agent>:<id>`, `~/rooms/.rooms/sessions.json`, ask log `session-<agent>-<id>.jsonl`, Tauri command `continue_session`, drag type `application/x-rooms-session` |
| thread | `asks` module | `ThreadSheet`, `AsksStore` threads | one ask log per scope under `~/rooms/.rooms/asks/` |

## Kept on purpose

Some names keep "doc" because something outside this repository reads or writes them:

- Plugin data for one artifact lives under `docs/<fileKey>/` in the plugin's data folder. Installed plugins already keep files there, and their content scripts and tabs address them by that path. Renaming it would lose their data.
- A plugin tool's `appendTo` path may use the `{doc}` placeholder, and the tool's input names the artifact in a `doc` field. Published plugin manifests (Excalidraw notes) and the agents that call those tools through `rooms-mcp` use these names. An artifact ask's prompt says `Rooms doc: <fileKey>` for the same reason: it is the value an agent passes as `doc`.
- `rooms-mcp` has no tool names of its own. Every tool is a plugin's, named `<plugin>__<tool>`, and agents find them by listing.

## Migrations

roomsd and the app move old names to new ones the first time they meet them. Each step is safe to run again, and each has a test that fails without it.

- `~/rooms/.rooms/conversations.json` becomes `sessions.json` when roomsd opens the home. The old file is kept as `conversations.json.bak`, or `.bak.2` and up when a backup is already there. If `sessions.json` already exists (an older app ran again in between), the sessions only the old file has are added to it, and `sessions.json` wins for the rest.
- Ask logs named `conversation-<agent>-<id>.jsonl` are renamed to `session-<agent>-<id>.jsonl` when the ask log opens. When a log is already under the new name, the old log's lines are added to its end and the old file is removed.
- Saved tabs and tab history of kind `conversation` (id in `session`) come back as kind `session` (id in `sessionId`), and kind `doc` comes back as kind `artifact`.
- An unsent ask draft saved under `alto-rooms.askDraft.conversation:<agent>:<id>` moves to the `session:` key the first time it is read. Artifact drafts keep their bare file key.
- A surface a plugin names with SDK 0.5 scope kinds (`doc`, or `conversation` with `session`) still parses in `paint`, `menu` and `open` until SDK 0.7. A plugin built on SDK 0.6 says `hello` with `api: 2` when it connects; one that does not is sent the 0.5 kinds, so its `surfacePath` keeps working. `legacySurfacePath` in the SDK finds data a plugin saved under the 0.5 paths.
- `sort.toml` still reads `new_room_min_docs` and `max_docs_per_run`, as `new_room_min_artifacts` and `max_artifacts_per_run`. A file with both names reads the new one. A file that does not parse turns sorting off.
- The onboarding skill is v10, so homes with the v9 text get the new words.

## Enforcement

`apps/desktop/src/terms.test.ts` runs with `bun run test` in `apps/desktop` (alone: `bunx vitest run src/terms.test.ts`). It reads every Rust and TypeScript file under `crates`, `packages` and `apps/desktop` (`src`, `src-tauri/src`, `e2e`) and fails when:

- an identifier contains `conversation` in any case, or
- in app code (`apps/desktop` and `packages/*/src`, not the crates, which keep `doc` for a generic HTML document), an identifier has `doc` or `docs` as a word part: `openDoc`, `DocView`, `doc_original`, `MAX_DOCS`. `document` and `ownerDocument` are fine.

String literals and comments are not checked, so the migration code can name the old keys and kinds. Text between JSX tags is checked, which is why the ask-chat copy in `ThreadSheet.tsx` and `Turn.tsx` is on the allowlist at the top of the test, next to the one Rust field that reads the old `conversations.json`. Each entry names a file, a word and the reason; a second test fails when an entry no longer matches anything.

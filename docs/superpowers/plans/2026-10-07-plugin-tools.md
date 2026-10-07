# Plugin Tools (agents draw into Excalidraw) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Plugins declare tools in their manifest; agents call them through a thin `rooms-mcp` adapter; roomsd appends the input to the plugin's data file and emits `plugin.data.changed`; the Excalidraw plugin replays appended draw ops live. Plus Task 0: split find_html's noise filter so files inside room folders/Journal get provenance recorded.

**Architecture:** Generic extension point in core (declarative append), MCP outside core, all Excalidraw knowledge in the plugin repo (`~/personal/rooms-plugin-excalidraw`).

**Tech Stack:** Rust (rooms-core, roomsd, new `crates/rooms-mcp` with `ureq` for HTTP), TS (desktop, plugin-sdk), React (Excalidraw plugin), Python (find_html).

**Spec:** `docs/superpowers/specs/2026-10-07-plugin-tools-spec.html` (rules T1–T11, §3 errors, §5 frozen seams). Read it before any task.

## Global Constraints

- Core never mentions "excalidraw"; `rooms-mcp` never mentions it either.
- Manifest `tools`: name `[a-z][a-z0-9_]{0,39}`; description 1–500 chars; `input` is a JSON object ≤ 16 KiB (stored, not enforced); `appendTo` may contain only the `{doc}` placeholder and must pass `valid_path` after substitution; ≤ 16 tools per plugin; any invalid tool makes the manifest invalid with a reason.
- Tool call input: JSON object ≤ 64 KiB; must have `doc` = 16-hex fileKey or absolute path (resolved via realpath to an indexed artifact's fileKey).
- Appended line: `{"at": <RFC3339>, "tool": <name>, "input": <object>}` + `\n`; data file total ≤ 10 MiB (`MAX_DATA_BYTES`).
- Event `plugin.data.changed {pluginId, path}` only for tool appends (bridge writes stay silent).
- MCP tool names `<pluginId>__<tool>`; `rooms-mcp` reads token from `<home>/.rooms/token` (home = `ROOMS_HOME` or `~/rooms`), API base `http://127.0.0.1:<ROOMS_API_PORT or 4317>`.
- `{mcp_config}` placeholder: if empty, drop that argv element AND the element right before it.
- Default claude templates gain `--mcp-config {mcp_config} --allowedTools=mcp__rooms`; prompt gains a `Rooms doc: <fileKey>` line.
- UI copy English. Commits: repo identity (jun-hash), message ends with a blank line then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Plugin repo commits the same way; never push or publish releases.

## Review Focus

- A tool call for a doc given as a path inside a symlinked room must resolve to the original's fileKey — test in Task 2.
- Two concurrent tool calls to the same file must not interleave partial lines (single `write_all` with O_APPEND) — test in Task 2.
- An agent run with no rooms-mcp installed must still work (no `--mcp-config` arg) — test in Task 5.
- The Excalidraw plugin must not re-apply ops after reload (opsApplied persisted) — test in Task 7.
- A malformed op line must be skipped without breaking the rest — test in Task 7.

---

### Task 0: find_html — separate "not a document" from "already in Rooms"
**Files:** `crates/rooms-core/assets/onboarding/skill/rooms/scripts/find_html.py`, `test_find_html.py`; marker bump `rooms-onboarding v7` in SKILL.md, ONBOARD.md, find_html.py, `crates/rooms-core/src/onboarding.rs` tests (+v6→v7 upgrade), `apps/desktop/e2e/onboarding.spec.ts`.
- [ ] Tests first: a Claude `cp …/scratchpad/x.html <home>/browser/x.html` and a Write to `<home>/journal/2026-10-07/y.html` are RECORDED in sources.json but are NOT link candidates; `<home>/.rooms/**` is never recorded; scratchpad/node_modules/~/.claude stay noise for both.
- [ ] Implement: split `is_noise` into `not_a_document(path)` (scratchpad, node_modules, .superpowers/brainstorm, ~/.claude, ~/.codex, tmp dirs, ~/.aside non-artifacts, `<home>/.rooms`) used for collection, and `in_rooms_home(path)` used only when building link candidates. Keep functions small.
- [ ] Python suite + `cargo test -p rooms-core onboarding` pass. Commit "Record provenance for files written inside Rooms".

### Task 1: Protocol types + manifest `tools`
**Files:** `crates/rooms-protocol/src/lib.rs` (+ shape test + TS export), `packages/protocol-ts/src/index.ts`, `crates/rooms-core/src/plugins.rs` (+ tests).
**Produces:** `ToolInfo`, `ToolCall`, `ToolResult`, `EventKind::PluginDataChanged { plugin_id, path }` (`"plugin.data.changed"`, camelCase fields); `Manifest.tools: Vec<ManifestTool { name, description, input: serde_json::Value, append_to: String }>` (pub(crate)).
- [ ] Tests first (shape test for event JSON; plugins.rs tests for every T1 rule incl. bad placeholder `{x}`, absolute/`..` appendTo, >16 tools, oversize input, missing description; valid manifest without tools unchanged).
- [ ] Implement parsing in `load_manifest` (hand-walk like the rest). Make the desktop `RoomsStore.apply` ignore `plugin.data.changed` if its switch needs a case.
- [ ] `cargo test -p rooms-protocol -p rooms-core`, `cd apps/desktop && bunx tsc -b`. Commit.

### Task 2: Core `list_tools` / `call_tool`
**Files:** create `crates/rooms-core/src/tools.rs`; modify `core.rs` (methods + emit), `plugins.rs` (`append_data(dir, rel, line) -> Result<(), CoreError>`: O_APPEND single write, size check including existing length, symlink-safe like `data_file`).
**Produces:** `RoomsCore::list_tools(&self) -> Vec<ToolInfo>`, `RoomsCore::call_tool(&self, call: &ToolCall) -> Result<ToolResult, CoreError>` (errors: `InvalidInput("bad_request:<why>")` → 400, `NotFound` → 404, `InvalidInput("too_large")` → 413).
- [ ] Tests first (tests/tools.rs or core_flows): list only valid+enabled plugins; call with fileKey; call with absolute path of a symlinked room doc → original fileKey; unknown plugin/tool/doc → NotFound; disabled plugin → NotFound; input not object / >64 KiB / no doc → bad_request; appended line format; >10 MiB → too_large; event emitted with path; 8 concurrent calls → 8 intact lines.
- [ ] Implement in tools.rs (doc resolution helper, template substitution, envelope) — no plugin-specific code. Commit.

### Task 3: roomsd routes
**Files:** `crates/roomsd/src/lib.rs`, `routes.rs`, `guard.rs` (treat `/v1/tools` GET as private like data reads), `tests/api.rs`.
- [ ] Tests first: GET /v1/tools without token → 403, with token → list; POST /v1/tools/call → 200/400/404/413 per spec §3 with `{error,message}` JSON (map extractor rejections to bad_request like `/v1/asks`).
- [ ] Implement via the existing `blocking()` helper. Commit.

### Task 4: `crates/rooms-mcp`
**Files:** create `crates/rooms-mcp/{Cargo.toml,src/main.rs,src/lib.rs}`; add to workspace members; `ureq` dependency.
**Behaviour:** newline-delimited JSON-RPC 2.0 on stdio. `initialize` → `{protocolVersion: <echo client's or "2025-06-18">, capabilities:{tools:{}}, serverInfo:{name:"rooms", version}}`; `notifications/initialized` ignored; `tools/list` → from `GET /v1/tools`: `{name:"<plugin>__<tool>", description, inputSchema: input}`; `tools/call` → `POST /v1/tools/call` → `{content:[{type:"text", text:"Saved to <path>"}]}` or `isError:true` with the API message; unknown method → JSON-RPC error -32601. Token/home/port per Global Constraints; if roomsd is unreachable, `tools/list` returns an empty list and `tools/call` an error result (never crash).
- [ ] Tests first in lib.rs with an injected `Api` trait (fake): each method's JSON in/out, name mapping, error mapping, unreachable roomsd.
- [ ] Implement; `cargo build -p rooms-mcp`; commit.

### Task 5: Wire MCP into asks + sidecar
**Files:** `crates/roomsd/src/main.rs` (write `<home>/.rooms/mcp.json` per spec T7), `crates/rooms-core/src/asks/{agents.rs,mod.rs,prompt.rs}`, `apps/desktop/scripts/build-sidecar.sh` (also build+copy `rooms-mcp-<triple>`), `apps/desktop/src-tauri/tauri.conf.json` (`externalBin` add `binaries/rooms-mcp`), `apps/desktop/src-tauri/src/daemon.rs` (pass `ROOMS_MCP_BIN` = sidecar path if resolvable, else rely on "next to roomsd").
- [ ] Tests first: `{mcp_config}` substitution and drop-with-previous when empty (agents.rs); default claude templates include the new args; prompt has `Rooms doc: <fileKey>` (prompt.rs snapshot updates); Asks passes the mcp.json path only when the file exists (tests/asks.rs: fake agent prints argv).
- [ ] Implement; run `cargo test`, `bun run sidecar` and `cd apps/desktop/src-tauri && cargo build`. Commit.

### Task 6: Desktop relay + SDK `storage.onChange`
**Files:** `apps/desktop/src/plugins/{PluginHost or pluginsStore, PluginFrame.tsx}`, `packages/plugin-sdk/src/index.ts` (+ version 0.2.0), tests.
- [ ] Tests first: a `plugin.data.changed` event for plugin X posts `{rooms:1,type:"dataChanged",path}` to X's frames only; SDK `storage.onChange` fires for that message and unsubscribes.
- [ ] Implement (listen via `RoomsStore.onSignal`). `bunx tsc -b && bunx vitest run`. Commit.

### Task 7: Excalidraw plugin `draw` (repo `~/personal/rooms-plugin-excalidraw`)
**Files:** `public/manifest.json` (version 0.2.0, minAppVersion 0.5.0, `tools.draw` with description telling agents to call several times, input schema: `doc` string + `ops` array of `{type: "box"|"arrow"|"text", id?, text?, from?, to?, near?}`, `appendTo: "notes/{doc}.ops.jsonl"`), new `src/ops.ts` (parse lines, layout, ops → Excalidraw elements via `convertToExcalidrawElements` skeletons), `src/notes.ts`/`src/App.tsx` (replay on open + on `storage.onChange`, persist `rooms.opsApplied` in the saved scene, "<agent> is drawing" badge 2 s — badge text "Drawing…" since agent name isn't known), SDK dependency pointed at the local workspace package for dev (`file:../alto-rooms/packages/plugin-sdk`) with a note to switch back to the release tarball before publishing.
- [ ] Tests first (vitest in the plugin repo; add vitest if absent): replay applies only new lines; bad JSON line skipped; layout places new boxes right of existing content; arrows bind by id; opsApplied survives a save/load.
- [ ] Implement; `bun run build`; commit in the plugin repo (no push).

### Task 8: End-to-end in the dev app
- [ ] Build the plugin, run the dev app with `ROOMS_PLUGIN_EXCALIDRAW=<plugin dist>` so it installs locally; confirm `GET /v1/tools` lists `excalidraw/draw`; run `rooms-mcp` by hand with a JSON-RPC `tools/list` + `tools/call` and see shapes appear in an open Notes panel; then ask a real doc "Draw …" and watch it draw live. Record results in the report (no code changes unless a bug is found — then fix in the owning task's files and note it).

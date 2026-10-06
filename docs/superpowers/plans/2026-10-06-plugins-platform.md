# Rooms Plugins v1 — Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sandboxed iframe plugins can add UI to the artifact side panel and to a plugin tab (opened from a sidebar item), talk to the app only through a narrow postMessage bridge, and keep their own data as files — without the app importing any plugin code.

**Architecture:** rooms-core discovers `<home>/.rooms/plugins/<id>/manifest.json`, validates it, stores enable/grant state in `state.json`, owns plugin data files and a persisted `fileKey` per artifact. roomsd exposes `/v1/plugins*` and serves plugin assets at `/_plugins/<id>/…` with a per-plugin CSP. The desktop app's `PluginHost` renders iframes in two slots, relays bridge calls to `RoomsClient`, asks before enabling, and flushes plugins before quit. Plugins use `packages/plugin-sdk` only.

**Tech Stack:** Rust (rooms-core, roomsd/axum, rusqlite, ts-rs), TypeScript/React 19 (Tauri desktop app, Vitest, Playwright Chromium + WebKit), Bun workspaces.

**Spec:** `docs/superpowers/specs/2026-10-06-plugins-spec.html` (§N references below point into it).

**Out of this plan:** the Excalidraw and Goals plugins themselves (separate repos `rooms-plugin-excalidraw`, `rooms-plugin-goals`; separate plans after this one ships).

## Global Constraints

- Plugin folder: `<home>/.rooms/plugins/<id>/`; data: `<home>/.rooms/plugins/<id>/data/`. Folder name == manifest `id`, `id` matches `^[a-z0-9][a-z0-9-]{1,39}$`.
- Manifest fields: `id`, `name` (1–40 chars), `version` (semver), `minAppVersion` (semver), `description?` (≤200), `entry?` (default `index.html`, not under `data/`), `permissions` ⊆ {`rooms.read`, `clipboard`, `downloads`}, `slots` with ≥1 of `artifact.sidePanel: {title}` / `tab: {title, icon?, sidebar?}`; title 1–24 chars; unknown slot keys are ignored with a warning.
- Storage path rule: 1–200 chars, segments `[A-Za-z0-9._-]+` joined by `/`, no `.`/`..`/empty segment, no leading `/`, depth ≤ 8. Text ≤ 10 MB (UTF-8 bytes). Writes are atomic (tmp → rename).
- iframe: `sandbox="allow-scripts"` (+ `allow-downloads` iff `downloads`), never `allow-same-origin`; `allow="clipboard-read; clipboard-write"` iff `clipboard`.
- `/_plugins/<id>/*` header: `Content-Security-Policy: sandbox allow-scripts[ allow-downloads]; default-src 'none'; script-src {P}; style-src {P} 'unsafe-inline'; img-src {P} data: blob:; font-src {P}; connect-src 'none'; frame-src 'none'; form-action 'none'` with `{P}` = `http://127.0.0.1:<files_port>/_plugins/<id>/`. The global `sandbox allow-scripts allow-popups` header must not apply to `/_plugins`.
- Bridge wire: every message has `rooms: 1`. Host accepts only `event.source === frame.contentWindow`; SDK accepts only `event.source === window.parent`.
- Error codes: `permission_denied`, `invalid_path`, `too_large`, `not_found`, `write_failed`, `unknown_method`, `timeout`.
- `fileKey`: first 16 hex of sha256(realpath at first indexing), stored in the index, carried by `index.reassign`.
- Quit budget: plugins share the notes' 1.6 s window, capped at 1.5 s; drafts 400 ms and Rust 2.5 s unchanged. Panel close / tab leave also send `beforeClose` with a 1.5 s cap.
- Liveness: host pings every 5 s; no `pong` within 3 s → "This plugin stopped responding" + Reload.
- At most one live iframe per plugin per window (only the active tab is mounted).
- UI copy is English and short. No explanatory text beyond what §1 ACs show.
- Repo formatting: TS files that were prettier-140-clean stay so (`bunx prettier --check --print-width 140 <file>` before commit); never reformat files that weren't.

## Review Focus

1. **A plain-file artifact moved between rooms by Rooms** — its notes must still open (fileKey carried by `reassign`); pinned in Task 1.
2. **A sibling artifact iframe posting forged `{rooms:1,type:"context"}` / fake responses** — the SDK must ignore them; pinned in Task 5.
3. **A plugin whose manifest gains a permission while its panel is open** — the panel must close (after `beforeClose`) and the enable card must ask again; pinned in Task 7.
4. **A storage path like `notes/../../token`, an absolute path, or a symlink inside `data/` pointing out** — rejected by both host and core; pinned in Tasks 2 and 6.
5. **Quitting right after a write is scheduled** — the plugin's `beforeClose` handler runs and finishes before the app closes; pinned in Task 7 (unit) and Task 8 (e2e).

---

## File Structure

| Path | Status | Responsibility |
|---|---|---|
| `crates/rooms-protocol/src/lib.rs` | modify | `Artifact.file_key`, `PluginInfo`, `PluginSlots`, `PluginStatus`, `EventKind::PluginsChanged` |
| `crates/rooms-core/src/index.rs` | modify | schema v2 `file_key` column, compute on insert, keep on reassign, `by_file_key` |
| `crates/rooms-core/src/plugins.rs` | create | manifest parse/validate, scan, `rev`, path rules, data read/write/list/delete, asset resolve |
| `crates/rooms-core/src/state.rs` | modify | persist `plugins: { enabled, grants }` |
| `crates/rooms-core/src/core.rs` | modify | `RoomsCore` facades: `plugins`, `set_plugin_enabled`, `*_plugin_data`, `resolve_plugin_file`, `artifact_by_file_key`, `plugins_changed` |
| `crates/rooms-core/src/watch.rs` | modify | changes under `.rooms/plugins/` (not `*/data/**`) → `plugins_changed()` |
| `crates/roomsd/src/routes.rs`, `src/lib.rs` | modify | `/v1/plugins*`, `/v1/artifacts/by-file-key/{key}`, files `/_plugins/{id}/{*rel}` with per-plugin CSP, 10 MB body limit on data PUT |
| `packages/protocol-ts/src/client.ts` | modify | client methods for the above, `pluginEntryUrl` |
| `packages/plugin-sdk/` | create | `connect()`, types, `PluginError` |
| `apps/desktop/src/plugins/` | create | `usePlugins.ts`, `permissions.ts`, `bridge.ts`, `PluginFrame.tsx`, `PluginSlot.tsx`, `EnableCard.tsx`, `host.ts` (flush registry) |
| `apps/desktop/src/data/viewerStore.ts` | modify | `Tab` kind `plugin`, `pluginPanel` state |
| `apps/desktop/src/lib/appEvents.ts` | modify | `onQuitFlushAsync` |
| `apps/desktop/src/views/DocView.tsx`, `shell/Sidebar.tsx`, `shell/AppShell.tsx`, `shell/TabBar.tsx` | modify | place `<PluginSlot>`, sidebar Plugins section, tab label/icon |
| `apps/desktop/vite.config.ts` | modify | `__APP_VERSION__` define for `minAppVersion` checks |
| `apps/desktop/e2e/fixtures/plugins/echo/` | create | minimal SDK-only plugin for e2e |
| `apps/desktop/e2e/plugins.spec.ts` | create | Chromium + WebKit plugin e2e |
| `docs/plugins.md`, `README.md` | create/modify | plugin author guide; README section |

---

### Task 1: Persisted `fileKey` on artifacts

**Files:** Modify `crates/rooms-protocol/src/lib.rs`, `crates/rooms-core/src/index.rs`, `crates/rooms-core/src/core.rs`; Test `crates/rooms-core/tests/core_flows.rs`.

**Interfaces — Produces:**
- `Artifact { …, file_key: String }` (wire `fileKey`)
- `RoomsCore::artifact_by_file_key(&self, file_key: &str) -> Option<Artifact>` — first match in sidebar room order (owned/linked rooms, then journal)

- [ ] **Step 1: Failing tests** in `core_flows.rs`:
  - `file_key_is_stable_across_moves_for_plain_files_and_links`: create rooms a, b; write `a/x.html` (plain) and a symlink `a/y.html → <tmp>/orig.html`; backfill; record keys; `move_artifact` both to b; keys unchanged; reopen core; keys unchanged.
  - `same_original_linked_twice_shares_file_key`: two symlinks in two rooms to the same file → equal keys; a different file → different key.
  - `artifact_by_file_key_finds_first_in_room_order`.
- [ ] **Step 2:** `cargo test -p rooms-core --test core_flows file_key` → fails (no field).
- [ ] **Step 3: Implement.** Protocol: add `pub file_key: String` to `Artifact`. Index: `SCHEMA_VERSION = 2`; add `file_key TEXT NOT NULL` + `CREATE INDEX idx_artifacts_file_key ON artifacts(file_key)`; in `upsert_facts` compute `file_key = hex(sha256(f.target))[..16]` only for a new row (`existing == None`), otherwise keep the stored value (select it with the existing row); `reassign` leaves the column untouched; `row_to_artifact` reads it. Add `Index::by_file_key(&self, key) -> Vec<Artifact>`; core orders by `state.rooms` position then journal. Add `sha2` to rooms-core deps.
- [ ] **Step 4:** `cargo test` (workspace) → all pass; `cargo test` also regenerates `packages/protocol-ts/src/generated/Artifact.ts` (check it contains `fileKey`).
- [ ] **Step 5: Commit** `feat(core): persisted fileKey per artifact`.

### Task 2: Plugin discovery, state, and data files in rooms-core

**Files:** Create `crates/rooms-core/src/plugins.rs`; Modify `lib.rs` (mod), `state.rs`, `core.rs`, `watch.rs`, `crates/rooms-protocol/src/lib.rs`; Test `crates/rooms-core/src/plugins.rs` (unit) + `tests/core_flows.rs`.

**Interfaces — Produces (protocol):**
```rust
wire!(pub struct PluginInfo {
    pub id: String, pub name: String, pub version: String, pub min_app_version: String,
    pub description: Option<String>, pub entry: String, pub permissions: Vec<String>,
    pub slots: PluginSlots, pub status: PluginStatus, pub reason: Option<String>,
    pub enabled: bool, pub needs_approval: bool, pub rev: String,
});
wire!(pub struct PluginSlots { pub artifact_side_panel: Option<SidePanelSlot>, pub tab: Option<TabSlot> });
wire!(pub struct SidePanelSlot { pub title: String });
wire!(pub struct TabSlot { pub title: String, pub icon: Option<String>, pub sidebar: bool });
pub enum PluginStatus { Ok, Invalid }            // serde "ok" | "invalid"
EventKind::PluginsChanged                          // serde "plugins.changed", no payload
```
`manifest.json` keys map: `slots["artifact.sidePanel"]` → `artifact_side_panel`, `slots["tab"]` → `tab`.
`needs_approval = status == Ok && (!enabled || !permissions ⊆ grants[id])`.
Allowed icons: `target, pencil, list-checks, calendar, star, book, flag, layout-grid, sparkles, notebook, lightbulb, puzzle`.

**Interfaces — Produces (core facades):**
```rust
pub fn plugins(&self) -> Vec<PluginInfo>;                                   // sorted by id
pub fn set_plugin_enabled(&self, id: &str, enabled: bool) -> Result<PluginInfo, CoreError>; // NotFound / InvalidInput if invalid
pub fn read_plugin_data(&self, id: &str, rel: &str) -> Result<Option<String>, CoreError>;
pub fn write_plugin_data(&self, id: &str, rel: &str, text: &str) -> Result<(), CoreError>;
pub fn list_plugin_data(&self, id: &str, prefix: &str) -> Result<Vec<String>, CoreError>;
pub fn delete_plugin_data(&self, id: &str, rel: &str) -> Result<(), CoreError>;
pub fn resolve_plugin_file(&self, id: &str, rel: &str) -> Result<PathBuf, CoreError>; // never under data/
pub fn plugins_changed(&self);                                               // emits PluginsChanged
```
Errors: bad path → `CoreError::InvalidInput("invalid_path")`; > 10 MB → `CoreError::InvalidInput("too_large")`; unknown/invalid plugin → `CoreError::NotFound`. (roomsd maps these to `invalid_path` 400 / `too_large` 413 / `not_found` 404.)
State: `state.json` gains `"plugins": { "enabled": ["id"], "grants": { "id": ["perm"] } }` (missing → empty). Enabling sets `grants[id] = permissions`; disabling removes from `enabled` and keeps grants.
`rev` = hex sha256 of (manifest bytes ‖ entry file size ‖ entry mtime nanos), first 12.

- [ ] **Step 1: Failing unit tests** in `plugins.rs`: manifest table (valid; id≠folder; bad id; missing name; unknown permission; no slots; unknown slot ignored; bad icon; entry under data/ → invalid), path rule table (ok `notes/a.excalidraw`; reject `../x`, `/x`, `a//b`, `a/./b`, 9-deep, 201 chars, `a b`), size limit, atomic write leaves no `.tmp`, `list` sorted relative files only, `delete` missing = Ok, symlink in `data/` pointing outside → rejected on read/write, `resolve_plugin_file("data/x")` → invalid, `resolve_plugin_file("../manifest")` → invalid.
- [ ] **Step 2: Failing flow tests** in `core_flows.rs`: `plugin_enable_and_grants_persist` (enable → reopen core → enabled, needs_approval false; add a permission to manifest → needs_approval true; disable → enabled false); `plugins_changed_emits_event`.
- [ ] **Step 3:** run → fail.
- [ ] **Step 4: Implement** `plugins.rs` (pure functions taking `home: &Path` + state), state changes, core facades (take the state lock for enable; data I/O outside the lock), watcher: in the `Ok(events)` branch, if any path starts with `<home>/.rooms/plugins/` and has no `data` component right after the plugin id, call `c2.plugins_changed()` (coalesce: once per batch).
- [ ] **Step 5:** `cargo test` → pass. **Commit** `feat(core): plugin discovery, enable state, and plugin data files`.

### Task 3: roomsd routes and plugin asset serving

**Files:** Modify `crates/roomsd/src/lib.rs`, `src/routes.rs`; Test `crates/roomsd/tests/api.rs`.

**Interfaces — Produces (HTTP):**
- `GET /v1/plugins` → `PluginInfo[]`
- `PATCH /v1/plugins/{id}` `{ "enabled": bool }` → `PluginInfo` (token)
- `GET /v1/plugins/{id}/data?prefix=` → `string[]` (token — plugin data is private to the app)
- `GET /v1/plugins/{id}/data/{*path}` → `text/plain; charset=utf-8` body, 404 when missing (token)
- `PUT /v1/plugins/{id}/data/{*path}` body text → 204 (token, body limit 10 MB + 1)
- `DELETE /v1/plugins/{id}/data/{*path}` → 204 (token)
- `GET /v1/artifacts/by-file-key/{key}` → `Artifact` | 404
- files: `GET /_plugins/{id}/{*rel}` → asset with the per-plugin CSP from Global Constraints; 404 for `data/…`, invalid/unknown plugin; content types incl. `woff2 → font/woff2`, `wasm → application/wasm`, `svg`, `json`, `js → text/javascript`, `css`.

- [ ] **Step 1: Failing tests** in `api.rs`: list/enable round trip; data PUT/GET/list/DELETE; 400 `invalid_path`; 413 `too_large` (11 MB body); 403 without token on data GET/PUT; `by-file-key` 200/404; files `/_plugins/echo/index.html` has exact CSP (with and without `downloads`), never contains `allow-popups`; `/_plugins/echo/data/x` → 404; artifact responses keep `sandbox allow-scripts allow-popups`.
- [ ] **Step 2:** run → fail.
- [ ] **Step 3: Implement.** Move the files CSP from the router-wide layer into the artifact handler so `/_plugins` sets its own; add routes; map errors; `DefaultBodyLimit::max(10 * 1024 * 1024 + 1)` on the data PUT route only.
- [ ] **Step 4:** `cargo test` → pass. **Commit** `feat(roomsd): plugin API and sandboxed plugin asset serving`.

### Task 4: protocol-ts client

**Files:** Modify `packages/protocol-ts/src/client.ts`, `src/index.ts`; generated types come from Task 1–2 `cargo test`.

**Interfaces — Produces:**
```ts
listPlugins(): Promise<PluginInfo[]>;
setPluginEnabled(id: string, enabled: boolean): Promise<PluginInfo>;
getPluginData(id: string, path: string): Promise<string | null>;   // 404 → null
putPluginData(id: string, path: string, text: string): Promise<void>;
listPluginData(id: string, prefix?: string): Promise<string[]>;
deletePluginData(id: string, path: string): Promise<void>;
findArtifactByFileKey(fileKey: string): Promise<Artifact | null>; // 404 → null
pluginEntryUrl(info: Info, p: PluginInfo): string;                 // `${filesOrigin}/_plugins/${id}/${entry}`
```
- [ ] **Step 1:** add methods (path segments encoded per segment like `fileUrl`), export new types. Extend `apps/desktop/src/test/fakes.tsx` fake client with in-memory plugins + data.
- [ ] **Step 2:** `bunx tsc -b` (apps/desktop) passes. **Commit** with Task 6 (no behaviour on its own).

### Task 5: `@alto-rooms/plugin-sdk`

**Files:** Create `packages/plugin-sdk/{package.json,tsconfig.json,src/index.ts,src/index.test.ts}`; add to root workspaces (already `packages/*`).

**Interfaces — Produces:** exactly the frozen signature in spec §5 S1 (`connect`, `RoomsPlugin`, `PluginContext`, `PluginRoom`, `PluginArtifact`, `PluginError`). Wire messages exactly as §5 S1 "Wire". Defaults: `connect({ timeoutMs = 10_000 })`; `ready` is posted on connect; the promise resolves on the first `context`.

- [ ] **Step 1: Failing tests** (vitest, jsdom; simulate `window.parent` with a stub `postMessage` and dispatch `MessageEvent`s with explicit `source`):
  - resolves after `context`, `onContext` fires immediately with the current context and on later contexts;
  - a request posts `{rooms:1,id,method,params}` and resolves with `result`; `error` rejects `PluginError` with `code`;
  - **messages whose `source !== window.parent` are ignored** (forged context, forged result for a pending id, forged beforeClose);
  - `beforeClose` runs handlers then posts `beforeClose.done` with the same id (even if a handler throws);
  - `ping` → `pong` with the same id; request timeout → `PluginError("timeout")`.
- [ ] **Step 2:** run → fail. **Step 3:** implement (no deps). **Step 4:** pass. **Commit** `feat(sdk): plugin-sdk bridge client`.

### Task 6: Desktop plugin host — data, bridge, frames, slots

**Files:** Create `apps/desktop/src/plugins/{usePlugins.ts,permissions.ts,bridge.ts,host.ts,PluginFrame.tsx,PluginSlot.tsx,EnableCard.tsx}` + tests; Modify `data/viewerStore.ts`, `views/DocView.tsx`, `shell/Sidebar.tsx`, `shell/AppShell.tsx`, `shell/TabBar.tsx`, `vite.config.ts`, `src/vite-env.d.ts`.

**Interfaces — Produces:**
```ts
// usePlugins.ts — list + refetch on `plugins.changed`; compatibility from __APP_VERSION__
export type HostPlugin = PluginInfo & { compatible: boolean };
export function usePlugins(): HostPlugin[];
export function usePluginItems(): { pluginId: string; title: string; icon: string }[]; // enabled, ok, compatible, !needsApproval, tab.sidebar
// permissions.ts
export function frameAttrs(p: PluginInfo): { sandbox: string; allow: string | undefined };
// bridge.ts
export type BridgeCall = { id: string; method: string; params: unknown };
export async function handleBridgeCall(p: PluginInfo, call: BridgeCall, deps: { client: RoomsClient; navigate: (t: TabInput) => void }): Promise<unknown>; // throws BridgeError{code}
export function validPath(path: unknown): path is string;
// host.ts — live frames registry for flush and change handling
export function registerFrame(f: { pluginId: string; beforeClose(capMs: number): Promise<void> }): () => void;
export function flushAllPlugins(capMs: number): Promise<void>;
// PluginSlot.tsx — spec §5 S2 frozen signature
// viewerStore
| { id: string; kind: "plugin"; pluginId: string }
pluginPanel: { open: boolean; width: number; pluginId: string | null } // persisted, default {false, 360, null}
setPluginPanel(patch: Partial<ViewerState["pluginPanel"]>): void;
```

- [ ] **Step 1: Failing tests**:
  - `permissions.test.ts`: none → `sandbox="allow-scripts"`, no allow; downloads → `allow-scripts allow-downloads`; clipboard → allow string; never `allow-same-origin`/`allow-popups`.
  - `bridge.test.ts`: `storage.*` map to client calls; `validPath` table (same as Task 2); `rooms.list`/`artifacts.list` without `rooms.read` → `permission_denied`; `artifacts.list` maps to `PluginArtifact` (fileKey, newest first); `open({fileKey})` → `findArtifactByFileKey` → navigate doc; missing → `not_found`; unknown method → `unknown_method`; 10 MB+ text → `too_large` before any request.
  - `PluginFrame.test.tsx`: iframe attrs from permissions; `ready` from the frame → `context` posted to that frame; a message from another window is ignored; a request is answered to the same frame; no `pong` in 3 s → overlay "This plugin stopped responding" + Reload.
  - `PluginSlot.test.tsx`: side panel renders nothing with no enabled side-panel plugin; with one: closed shows a "✎ {title}" toggle, opening shows the frame and persists `pluginPanel.open`; two plugins → panel header tabs; tab slot renders the frame or "Missing plugin".
  - `EnableCard.test.tsx`: shows name, description, permissions in plain words (`rooms.read` → "Can see your rooms and documents", `clipboard` → "Can copy and paste", `downloads` → "Can save files you export"); Turn on → `setPluginEnabled(id,true)`; Not now hides until reload; one card at a time, id order; never shown for invalid/incompatible.
  - `Sidebar.test.tsx`: "Plugins" section only when a sidebar item exists; click opens the plugin tab (⌘-click new tab); right-click → "Turn off" → `setPluginEnabled(id,false)`.
  - `viewerStore.test.ts`: parse/persist `plugin` tabs and `pluginPanel`; navigate/back with plugin tabs.
- [ ] **Step 2:** run → fail. **Step 3:** implement; DocView wraps its iframe and `<PluginSlot slot="artifact.sidePanel" context={{ artifact }} />` in a flex row; AppShell renders `<EnableCard />` once and `TabView` handles `plugin`; TabBar label = plugin tab title, icon from the allowed set (fallback `Puzzle`). **Step 4:** `bunx vitest run`, `bunx tsc -b` pass. **Commit** `feat(desktop): plugin host — slots, bridge, enable card, sidebar items`.

### Task 7: Lifecycle — quit flush, panel close, changes while open

**Files:** Modify `lib/appEvents.ts`, `plugins/host.ts`, `plugins/PluginFrame.tsx`, `plugins/usePlugins.ts`; Tests alongside.

**Interfaces — Produces:** `onQuitFlushAsync(fn: () => Promise<void>): () => void` in `appEvents.ts`; `runQuitFlush` starts all async hooks in parallel with the note flush and awaits them inside the same window.

- [ ] **Step 1: Failing tests**:
  - `appEvents.test.ts`: an async hook that resolves at 200 ms finishes before `done`; one that never resolves does not delay `done` past the cap; notes still flush.
  - `host.test.ts`: `flushAllPlugins(1500)` sends `beforeClose` to every registered frame and resolves when all ack or at the cap.
  - `PluginFrame.test.tsx`: unmount sends `beforeClose` first (cap 1.5 s); on `plugins.changed` with a new `rev` → beforeClose then reload (new iframe `key`); with `needsApproval` → beforeClose then removed and the card shows; with `status: "invalid"` → "This plugin can't load"; plugin gone → removed at once, tab shows "Missing plugin".
- [ ] **Step 2:** fail → **Step 3:** implement (`AppShell`/`App` registers `onQuitFlushAsync(() => flushAllPlugins(1500))` once) → **Step 4:** pass. **Commit** `feat(desktop): plugin beforeClose on quit, close, and updates`.

### Task 8: E2E with an SDK-only echo plugin

**Files:** Create `apps/desktop/e2e/fixtures/plugins/echo/{manifest.json,index.html,main.js}` (built from `packages/plugin-sdk` via `bun build` in a `pretest` step: `scripts/build-echo-plugin.sh`), `apps/desktop/e2e/plugins.spec.ts`; Modify `e2e/fixtures.ts` (`daemon.installPlugin(dir)` copies into `<home>/.rooms/plugins/`), `playwright.config.ts` (run `plugins.spec.ts` on webkit too).

Echo plugin: declares both slots (`artifact.sidePanel` title "Echo", `tab` title "Echo" sidebar true), permissions `["rooms.read"]`; shows the current context as text, has buttons "Save" (writes `echo.txt` = context fileKey), "Load", "List rooms" (renders names), "Try downloads" (expects an error). `onBeforeClose` writes `closed.txt`.

- [ ] **Step 1: Write tests**:
  - install → card "New plugin: Echo" with "Can see your rooms and documents" → Turn on → sidebar "Echo".
  - open a doc → "✎ Echo" → panel shows the doc's fileKey; Save → `daemon` sees `.rooms/plugins/echo/data/echo.txt` with that key.
  - move the doc to another room (sidebar drop) → reopen → panel still shows the same fileKey.
  - sidebar Echo → tab; List rooms shows room names; back (⌘[) returns.
  - turn off via right-click → item disappears.
  - add `"clipboard"` to the manifest while the panel is open → panel closes, `closed.txt` exists, card asks again.
- [ ] **Step 2:** run → fail. **Step 3:** fix whatever the e2e shows. **Step 4:** `bunx playwright test` (all, Chromium + WebKit for plugins/reorder) → pass. **Commit** `test(e2e): plugins end to end with an SDK-only echo plugin`.

### Task 9: Author docs and release

**Files:** Create `docs/plugins.md`; Modify `README.md` (short "Plugins" section linking it), versions → 0.3.0.

- [ ] `docs/plugins.md`: folder layout, manifest reference (table from Global Constraints), slots, permissions and what the user sees, SDK API with the Excalidraw call-site from spec §5 S1, storage rules, lifecycle (`beforeClose`), CSP/no-network note (bundle fonts and assets), install by copying into `~/rooms/.rooms/plugins/<id>/`.
- [ ] Bump to 0.3.0, `bun run sidecar && bun run tauri build`, install over `/Applications`, run full unit + e2e suites. **Commit** `docs: plugin author guide; release 0.3.0`.

---

## Self-review notes

- Spec coverage: §1 AC-1/2/3 → Tasks 2,6,8; AC-4 → 6,8; AC-5 → 1,8; AC-6 → 7,8; AC-7 → permissions (6) + Excalidraw plan; AC-8 → 1,3,6; AC-9 → 2,3,5,6; AC-10 → 2,6; AC-11 → 6 (ping); AC-12 → 7. §2 invariants → 1,2,6,7. §3 matrix → 2,3,6. §5 S1–S4 → 5,6,4,2/3. §7 flows → 2/6, 6, 7. Open question decisions → Turn off in Task 6; no data-changed event; no process isolation; no overlay.
- AC-7 and AC-4/8 with the real Excalidraw/Goals UIs are verified in the plugin plans; here they are covered by the echo plugin and unit tests.

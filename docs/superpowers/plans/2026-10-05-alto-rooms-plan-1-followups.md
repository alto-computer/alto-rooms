# Alto Rooms Plan 1 — follow-ups (parked during SDD review)

Do these before Plan 2 depends on live updates. Each item came out of a task review or the final whole-branch review.

## Live updates and correctness
- Note filesystem events: add, change and remove `.md` files under `journal/<date>/`, then emit `note.saved` and `note.removed` (AC-11, Flow 3).
- `ArtifactRemoved` / lag resync seq ordering. A lag resync reuses `current_seq` (M3).

## Performance
- (none open — see Resolved in Plan 1.5)

## Security and API polish
- `resolve_file` ignores `.gitignore`/`.roomsignore`/`node_modules`. Consider `Sec-Fetch-*` filtering. Fixed ids (`inbox`, `journal`) allow existence probing.
- Notes listing: require regular files, and no symlinked `.md`.
- Error codes:
  - Add `internal` (500) to the spec §3 table.
  - Add `not_found` (404, note GET for a missing note; added in Plan 2 Task 0) to the spec §3 table.
  - A missing file returns `room_not_found`.
  - An unreadable file returns `write_failed`.
- Constant-time token compare. The risk is low because the API is loopback-only.

## Tests
- Snapshot-seq atomicity, API responsiveness during backfill, an oversized note body, the lagged-resync and keep-alive paths, removal and rename-over in watch tests, a `.rooms` filter test that actually discriminates, a TS bindings drift check (spec §9), and journal tests that don't depend on the timezone (`TZ=Asia/Seoul` on CI).

## Product notes for Plan 2
- Stray top-level folders in home, such as `node_modules`, become owned rooms automatically. This follows the spec, but the UI or onboarding may want to tell the user.
- Owned rooms whose folders disappear while the daemon is down are removed at startup.
- QuickFind's empty state "결과가 없어요" was added in Plan 2 (Task 7). It isn't in the plan's copy list, so add it to the spec's copy.
- roomsd sends no `room.updated` when a room's documents change, so `artifactCount` in a room snapshot goes stale. The desktop app now counts `artifact.added`/`artifact.removed` itself (Plan 2 Task 8); emitting `room.updated` from the daemon would make that unnecessary.

## Resolved in Plan 1.5 (`docs/superpowers/plans/2026-10-05-alto-rooms-plan-1-5-concurrency.md`)
- Scan and meta IO now run outside the core lock, scans of one room are serialized, and a removed or renamed room is never written by an in-flight scan (Task 2). Covered by a deterministic scan-order test.
- Unchanged files are skipped by fingerprint (target + mtime). This replaces per-path watcher updates and avoids a second copy of the ignore rules. Measured in a debug build: a 3,000-file room adds one new file in 381–431 ms, and the API's worst latency during a big backfill is 72–92 ms (Task 1 + Task 2).
- `seq` is an atomic, so `current_seq()` never waits on the lock (Task 2).
- Journal folder dates are strict and canonical (Task 1). A Finder rename of `inbox` no longer moves the inbox (Task 2).
- Concurrent `save_note` calls are serialized, and each uses a unique temp file (Task 2 review fix).
- Watcher helper threads hold weak references, so dropping the handle and the core closes the channel (Task 3).
- Watcher overflow or error runs `resync_all`: home folders, then every room, then `resync` (Task 3).
- A failed linked watch is logged once (Task 3).

## Plan 2 (desktop) — parked during review
- Artifact previews run on the app's main thread (WKWebView has no site isolation); one runaway artifact can freeze the UI. Consider static thumbnails for strips.
- `reuse()` trusts any local process answering `version "1"` on 4317 (multi-user Macs); token-file checks prove the file, not the responder.
- Terminate/Dock-quit flush hooks tao's private `TaoAppDelegateParent`; a tao upgrade that renames it silently disables that flush (logged).
- Quit-flush budget: notes get ~1.6 s, draft-file writes the last 400 ms; a slower disk exits without the draft.
- Draft conflict bar is not dismissed when a later save lands; 되살리기 then overwrites the newer text.
- No Window submenu (⌘M, full screen); app/Edit menu labels are English.
- Journal artifacts are not searchable in ⌘K; QuickFind only iterates rooms.
- Raw SIGTERM to a possibly-reaped sidecar pid (tiny window); Ctrl-C in `tauri dev` kills roomsd via the process group (dev only).
- WKWebView `allow-popups` / `target=_blank` behavior inside artifacts: verify manually.
- Manual-test doc test counts drift (now 237 vitest / 23 src-tauri).

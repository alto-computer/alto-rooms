# Alto Rooms Plan 1 — follow-ups (parked during SDD review)

Do these before Plan 2 depends on live updates. Each item came out of a task review or the final whole-branch review.

## Live updates and correctness
- Note filesystem events: add, change and remove `.md` files under `journal/<date>/`, then emit `note.saved` and `note.removed` (AC-11, Flow 3).
- Watcher overflow and `Flag::Rescan`: rescan the room and emit `resync{roomId}` (spec §3 `watch_overflow`).
- Per-room scan generation, so a stale scan cannot overwrite a newer one or re-insert rows for a removed room.
- `watch.rs` RoomAdded/RoomUpdated thread captures a `RoomsCore` clone, which leaks one thread and core per dropped `WatchHandle`. Hold a `Weak` instead.
- Journal folder date check is loose: chrono accepts `" 2026-10-5"`. Re-format the date and compare it to the folder name.
- An inbox rename in Finder follows the inbox record live, and the next start inserts a duplicate `"inbox"`. Exclude the inbox from inode matching.
- `ArtifactRemoved` / lag resync seq ordering. A lag resync reuses `current_seq` (M3).

## Performance
- Move scan and meta IO out of the core lock, and apply per-path updates for watcher batches instead of a whole-room rescan (I4, rest).
- SSE `current_seq()` takes the core lock on an async worker.
- Retry log spam when a linked root is available but cannot be watched.

## Security and API polish
- `resolve_file` ignores `.gitignore`/`.roomsignore`/`node_modules`. Consider `Sec-Fetch-*` filtering. Fixed ids (`inbox`, `journal`) allow existence probing.
- Notes listing: require regular files, and no symlinked `.md`.
- Error codes:
  - Add `internal` (500) to the spec §3 table.
  - A missing file returns `room_not_found`.
  - An unreadable file returns `write_failed`.
- Constant-time token compare. The risk is low because the API is loopback-only.

## Tests
- Snapshot-seq atomicity, API responsiveness during backfill, an oversized note body, the lagged-resync and keep-alive paths, removal and rename-over in watch tests, a `.rooms` filter test that actually discriminates, a TS bindings drift check (spec §9), and journal tests that don't depend on the timezone (`TZ=Asia/Seoul` on CI).

## Product notes for Plan 2
- Stray top-level folders in home, such as `node_modules`, become owned rooms automatically. This follows the spec, but the UI or onboarding may want to tell the user.
- Owned rooms whose folders disappear while the daemon is down are removed at startup.

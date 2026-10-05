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
  - Add `note_exists` (409, note rename target already taken, compared case-insensitively; added with `POST /v1/journal/{date}/notes/{name}/rename`) to the spec §3 table. Kept separate from `room_exists` so the app can say "같은 이름의 노트가 있어요".
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
- Manual-test doc test counts drift. Updated in Plan 3 Task 5 to the measured 279 vitest / 13 e2e / 23 src-tauri / 157 workspace / 24 find_html.py; they will drift again.

## Plan 3 (onboarding) — parked during review
Source: `.superpowers/sdd/2026-10-05-alto-rooms-plan-3-onboarding/progress.md` ("minor (deferred)" lines and the cost of accepted rulings).

- Onboarding files (Task 3):
  - The temp file used to write `ONBOARD.md` and the skill is opened without `O_NOFOLLOW`.
  - If `.rooms/onboarding` is itself a symlink, the chmod goes through it.
  - A non-UTF-8 file at an onboarding path logs a warning on every open.
  - No tests for a symlink or a directory sitting at a destination path.
- Moving artifacts (Task 1):
  - Rename-plus-recreate window: `move_artifact` renames, then (for a relative link) recreates it absolutely. An external writer that creates a file at the destination in that millisecond window can be overwritten. The stale-index-row replace is accepted for the same reason.
  - When the old relative link cannot be removed after the absolute one is created, the failure is only logged.
- Desktop (Task 4):
  - Releasing the New tab's inbox watch (unwatch on unmount) is untested.
  - Inbox rows are `draggable` `<button>`s. That works in Chromium/WebKit (Tauri) but not Firefox, which is fine only while the app is Tauri-only.
- `find_html.py` (Task 2 ruling): Codex shell matches count only with a write hint (`>`, `tee`, `cp`, `write_text`, …), and `/tmp`-style noise rules exempt paths under `$HOME`. Cost if wrong: a few missed Codex shell writes.
- Dry run (Task 5): `crates/rooms-core/assets/onboarding/skill/rooms/scripts/dry_run.sh` is dev-only and not in CI; run it by hand after changing `find_html.py`, the skill or move/index code.

## Plan 3 (onboarding) — parked at final review
- When everything went to inbox, the full first-run card keeps showing (the waiting list appears below it).
- Agent-created rooms show their slug as the display name (`브라우저-하네스`); folder adoption has no display-name channel.
- Codex user-skill path `~/.codex/skills/<name>` assumed; verify against current Codex.
- `in_worktree` also flags git submodules (nearest `.git` file).
- New tab counts any never-visited room as "새로 정리된 방" until visited.
- `cargo test -p rooms-core` is only reliable with `--test-threads=1` (timing tests).

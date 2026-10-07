# Polish pass (perf, sync, quality, UX) — follow-ups

Branch `polish/perf-ux-quality`, a 6-hour goal loop on 2026-10-07 against four goals: near-real-time artifact sync and robust indexing, desktop memory/speed, a pi-like codebase, and UI/UX detail. Each area was audited first (findings with measurements), fixed, then independently reviewed; review findings were fixed before moving on.

## What changed, in one line each
- Sync: watcher without the file-id cache, noise filter, incremental per-path rescans off the watcher thread (~80 ms debounce), symlink originals watched (incl. deleted-and-recreated and ignored folders), big batches as one `resync{room}`, mtime_ns+size change check (schema 3, atomic migration), case/NFD-exact entries, ignore rules identical to the walk.
- Latency to `artifact.added`: 3k room 400 → ~100 ms; 20k room 690 → ~110 ms; linked 500+60k 950–2280 → ~100 ms; symlink-original edit never → ~13 ms.
- Live refresh: `fileUrl` is versioned by `updatedAt`, so open docs and previews reload when the file changes; files carry an inode-aware weak ETag (304 when unchanged).
- Desktop: slice hooks instead of whole-state re-renders, memoized cards, previews load 4 at a time and linger 2 s, the last 3 doc tabs stay alive in `<Activity>`, markdown and Find are separate chunks (main 716 → 562 kB), roomsd starts in `setup()`, release profiles (roomsd −31 %), coalesced viewer writes, bounded ask threads.
- Quality: core.rs 1140 → 201 lines (scan / rooms / artifacts / journal / home_sync), typed errors with wire codes pinned by `tests/wire_errors.rs`, `plugins::find`, roomsd split into config / home_files / router / state, shared `layout` module, noteSaver and roomsStore split into single-purpose modules, 0 clippy warnings.
- UX: tab drag-reorder, ⌘-clicked tabs open next to their opener, logo → Home, Thinking only, ⌘1–9 / ⌘⇧T / ⌃Tab / ⌘⇧[ ], closing the last tab leaves a New tab, roving-tabindex tab strip, Chrome-style frozen widths and dividers, tab and icon tooltips, per-tab scroll memory, growing ask input with type-ahead, answer scrolls to its question.

## Deferred
- Streaming ask answers: needs a per-agent stream parser (`claude --output-format stream-json`, `codex exec --json`) and an `ask.delta` event. Not asked for; the waiting line is just "Thinking".
- Static preview thumbnails rendered by roomsd, to replace live preview iframes in big rooms.
- Links whose original vanished are remembered in memory only; after a restart they come back on the room's next rescan.
- Read failures still use the `write_failed` wire code ("Couldn't save"); the error type is split, so it is a one-line change, but a protocol change.
- A hidden (kept) doc tab keeps running its page, including audio/video, like a background browser tab.
- A live reload (file rewritten while its preview is near) reloads the frame without taking a load slot, so a mass rewrite reloads all near previews at once. Re-acquiring per version would blank the preview while it waits.
- The web build (not the Tauri app, which has `daemon://exited`) shows nothing when roomsd dies mid-session; opening a room then says "Something went wrong" with no retry.
- Proposals left for the owner: macOS overlay title bar with the tab row as drag region (~28 px back); one hover style and one cursor rule for all cards; focusing an already-open room tab instead of a duplicate; a line (or no row) for an empty past Journal day; the global reduced-motion rule also freezes the toast spinner and skeleton pulse.
- `tests/timing.rs` and one watcher test flake when the machine's load average is very high (also on the pre-branch commit).
- The CLAUDE.md astack hooks (astack:change / recall / spec) could not run: the astack skills are not installed in this environment.

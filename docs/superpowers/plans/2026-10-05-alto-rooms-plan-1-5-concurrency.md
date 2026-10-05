# Alto Rooms Plan 1.5 — IO Out of the Lock, Per-Room Scan Order Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `roomsd` stays responsive while big or slow rooms are scanned. No file IO happens while the global core lock is held, and two scans of the same room can never overwrite each other.

**Architecture:**
- A rescan becomes a three-phase pipeline:
  1. **Walk and read** with no global lock. This walks the room and reads the head of each changed file, skipping unchanged files by fingerprint.
  2. **Commit** under the global lock. This writes SQLite rows and emits events.
  3. **Serialize.** A per-room scan mutex, taken *before* the global lock, ensures one scan per room at a time. That removes the stale-scan race.
- `seq` moves to an atomic so `current_seq()` never waits on the lock.
- The watcher's helper threads hold only weak references, so dropping a `WatchHandle` frees everything.
- Watcher overflow triggers a full resync.

**Tech Stack:** Rust 1.99, existing crates only (`tokio` 1.53 `broadcast::WeakSender`, `notify-debouncer-full` 0.5, `rusqlite` 0.32).

**Spec:** `docs/superpowers/specs/2026-10-05-alto-rooms-v1-spec.html` (§2 rules, §3 errors incl. `watch_overflow`, §5 S3 seq rule). Follow-up source: `docs/superpowers/plans/2026-10-05-alto-rooms-plan-1-followups.md`.

## Global Constraints

These are unchanged from Plan 1.
- No public signature used by `roomsd` or the tests may change. That covers every existing `RoomsCore` method, `start_watching`, `open_and_watch` and `Index::backfill`. Additive items are fine.
- The wire protocol (`rooms-protocol`, generated TS) and the HTTP API are unchanged.
- Lock order is **room scan lock → global `Inner` lock**. Never acquire a room scan lock while holding `Inner`.
- Files are the source of truth, and the SQLite index is rebuildable. The first-seen `createdAt` must never be lost.
- Linked folders are never written to.
- Tests use `--test-threads=1` for `core_flows`. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Overlapping scans.** The startup backfill and a watcher rescan of the same room overlap. The final index must equal the latest file state, with no lost add and no resurrected row.
2. **Room removed mid-scan.** A Finder delete removes a room while its scan is in its read phase. No rows for that room may be written afterwards.
3. **API during a big backfill.** `list_rooms` / `current_seq` are called while a 3,000-file backfill runs. Each call returns quickly instead of waiting for the backfill.
4. **Dropped handle.** After the `WatchHandle` and every `RoomsCore` are dropped, the event channel closes, which proves no helper thread keeps the core alive.
5. **Loose date folders.** A journal folder named `" 2026-10-5"` or `"+026-10-05"` is not treated as a date.

## Scope change from the conversation

The conversation proposed "per-path watcher updates". This plan **replaces** that with fingerprint skip plus IO outside the lock, because:
- After fingerprinting, a rescan of an unchanged room only *stats* files and never reads them.
- Per-path updates would need a second implementation of the ignore rules (`.roomsignore`, `.gitignore`, default dirs) for single paths. The two implementations could drift, and the result would be wrong cards.

Task 2's latency test (one new file in a 3,000-file room → `artifact.added` < 1 s) is the gate. If it fails, per-path updates come back as a follow-up.

---

### Task 1: Index split into fingerprint / read / apply; strict dates

**Files:**
- Modify: `crates/rooms-core/src/index.rs`, `crates/rooms-core/src/rules.rs`
- Test: unit tests in both files

**Interfaces:**
- Consumes: `ScanEntry` (walk.rs), `read_meta`, `file_times`, `file_mtime`, `title_or_filename` (meta.rs).
- Produces:
  - `pub struct Fingerprint { pub target: String, pub updated_at: String, pub created_day: String }`
  - `pub struct FileFacts { pub rel_path: String, pub target: String, pub meta: crate::meta::Meta, pub file_created: String, pub updated: String }`
  - `impl Index { pub fn fingerprints(&self, room_id: &str) -> Result<HashMap<String, Fingerprint>, CoreError> }`
  - `pub fn read_entry(room_id: &str, e: &ScanEntry, fp: Option<&Fingerprint>) -> Option<FileFacts>`. A free function that touches no DB. It returns `None` when the entry is not an artifact or its fingerprint is unchanged.
  - `impl Index { pub fn apply(&mut self, room_id: &str, facts: &[FileFacts], present: &HashSet<String>) -> Result<Vec<Change>, CoreError> }`
    - It runs as one transaction.
    - It upserts `facts` and removes every row of the room whose `rel_path` is not in `present`.
    - On rollback it clears `touched_days`.
  - `impl Index { pub fn room_summary(&self, room_id: &str) -> Result<(u32, Option<String>), CoreError> }` returns `(count, max updated_at)`.
  - `Index::backfill(room_id, entries)` keeps its signature and becomes `fingerprints` + `read_entry` + `apply`.
  - `validate_iso_date` additionally requires `parsed.format("%Y-%m-%d").to_string() == d`.

- [ ] **Step 1: Write the failing tests**

Add to `rules.rs` tests:
```rust
#[test]
fn iso_date_must_be_canonical() {
    assert!(validate_iso_date("2026-10-05").is_ok());
    for bad in [" 2026-10-5", "+026-10-05", "2026-1-005", "2026-13-01"] {
        assert!(validate_iso_date(bad).is_err(), "{bad}");
    }
}
```

Add to `index.rs` tests:
```rust
#[test]
fn read_entry_skips_unchanged_and_apply_removes_missing() {
    let (d, room) = setup();
    let mut ix = Index::open(&d.path().join("index.sqlite")).unwrap();
    fs::write(room.join("a.html"), "<title>A</title>").unwrap();
    fs::write(room.join("b.html"), "<title>B</title>").unwrap();
    ix.backfill("r1", &scan_room(&room, false, false)).unwrap();
    let fps = ix.fingerprints("r1").unwrap();
    let entries = scan_room(&room, false, false);
    // unchanged → no facts (no file read)
    assert!(entries.iter().all(|e| read_entry("r1", e, fps.get(&e.rel_path)).is_none()));
    // b disappears from `present` → removed
    let present: HashSet<String> = ["a.html".to_string()].into();
    let ch = ix.apply("r1", &[], &present).unwrap();
    assert!(matches!(&ch[..], [Change::Removed { .. }]), "{ch:?}");
    assert_eq!(ix.room_summary("r1").unwrap().0, 1);
}

#[test]
fn rollback_clears_touched_days() {
    let (d, room) = setup();
    let mut ix = Index::open(&d.path().join("index.sqlite")).unwrap();
    fs::write(room.join("a.html"), "").unwrap();
    ix.backfill("r1", &scan_room(&room, false, false)).unwrap();
    let _ = ix.take_touched_days();
    ix.conn.execute_batch("DROP TABLE artifacts").unwrap(); // force the next apply to fail
    let fact = FileFacts { rel_path: "x.html".into(), target: "/x".into(), meta: Default::default(),
        file_created: "2026-10-05T00:00:00+09:00".into(), updated: "2026-10-05T00:00:00+09:00".into() };
    assert!(ix.apply("r1", &[fact], &["x.html".to_string()].into()).is_err());
    assert!(ix.take_touched_days().is_empty());
}

#[test]
fn journal_folder_day_rejects_loose_dates() {
    assert_eq!(journal_folder_day("journal", "2026-10-05/a.html").as_deref(), Some("2026-10-05"));
    assert_eq!(journal_folder_day("journal", "+026-10-05/a.html"), None);
}
```
If `Meta` does not derive `Default`, add `#[derive(Default)]` to it in `meta.rs`. The field types `Option<String>`, `Option<String>` and `Source` already have defaults.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p rooms-core --lib`
Expected: FAIL. The tests don't compile because `read_entry`, `fingerprints`, `apply`, `room_summary` and `FileFacts` are missing. The `iso_date_must_be_canonical` test fails.

- [ ] **Step 3: Write the implementation**

`rules.rs`:
```rust
pub fn validate_iso_date(d: &str) -> Result<(), CoreError> {
    let bad = || CoreError::InvalidInput("date".into());
    let parsed = chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").map_err(|_| bad())?;
    if parsed.format("%Y-%m-%d").to_string() != d { return Err(bad()); }
    Ok(())
}
```

`index.rs` changes. Replace `upsert_one`, `backfill` and `backfill_inner` with the following. Keep `remove_one` and `drop_room`.
```rust
#[derive(Debug, Clone)]
pub struct Fingerprint { pub target: String, pub updated_at: String, pub created_day: String }

#[derive(Debug, Clone)]
pub struct FileFacts { pub rel_path: String, pub target: String, pub meta: Meta, pub file_created: String, pub updated: String }

/// Phase 2 of a rescan, run WITHOUT the core lock: reads the file head only when its fingerprint
/// (target + mtime, plus the journal folder day) changed. `None` = not an artifact or unchanged.
pub fn read_entry(room_id: &str, e: &ScanEntry, fp: Option<&Fingerprint>) -> Option<FileFacts> {
    if e.class != PathClass::Artifact { return None; }
    let target = e.target.to_string_lossy().to_string();
    if let Some(fp) = fp {
        let day_ok = journal_folder_day(room_id, &e.rel_path).map(|d| d == fp.created_day).unwrap_or(true);
        if day_ok && fp.target == target && file_mtime(&e.target).as_deref() == Some(fp.updated_at.as_str()) { return None; }
    }
    let meta = read_meta(&e.target);
    let (file_created, updated) = file_times(&e.target);
    Some(FileFacts { rel_path: e.rel_path.clone(), target, meta, file_created, updated })
}

impl Index {
    pub fn fingerprints(&self, room_id: &str) -> Result<HashMap<String, Fingerprint>, CoreError> {
        let mut st = self.conn.prepare("SELECT rel_path, target, updated_at, created_day FROM artifacts WHERE room_id = ?1").map_err(err)?;
        let rows = st.query_map(params![room_id], |r| Ok((r.get::<_, String>(0)?, Fingerprint { target: r.get(1)?, updated_at: r.get(2)?, created_day: r.get(3)? }))).map_err(err)?;
        rows.collect::<rusqlite::Result<HashMap<_, _>>>().map_err(err)
    }

    pub fn room_summary(&self, room_id: &str) -> Result<(u32, Option<String>), CoreError> {
        self.conn.query_row("SELECT COUNT(*), MAX(updated_at) FROM artifacts WHERE room_id = ?1", params![room_id],
            |r| Ok((r.get::<_, i64>(0)? as u32, r.get(1)?))).map_err(err)
    }

    /// Phase 3, run under the core lock: one transaction. Upserts `facts`, removes rows not in `present`.
    pub fn apply(&mut self, room_id: &str, facts: &[FileFacts], present: &HashSet<String>) -> Result<Vec<Change>, CoreError> {
        let mut changes = Vec::new();
        self.conn.execute_batch("BEGIN").map_err(err)?;
        let r = (|| -> Result<(), CoreError> {
            for f in facts { if let Some(c) = self.upsert_facts(room_id, f)? { changes.push(c); } }
            let existing: Vec<String> = {
                let mut st = self.conn.prepare("SELECT rel_path FROM artifacts WHERE room_id = ?1").map_err(err)?;
                let rows = st.query_map(params![room_id], |r| r.get(0)).map_err(err)?;
                rows.collect::<rusqlite::Result<Vec<_>>>().map_err(err)?
            };
            for rel in existing.into_iter().filter(|r| !present.contains(r)) {
                if let Some(c) = self.remove_one(room_id, &rel)? { changes.push(c); }
            }
            Ok(())
        })();
        match r {
            Ok(()) => { self.conn.execute_batch("COMMIT").map_err(err)?; Ok(changes) }
            Err(e) => { let _ = self.conn.execute_batch("ROLLBACK"); self.touched_days.clear(); Err(e) }
        }
    }

    /// Kept for callers and tests: the three phases in one call (used where no lock split matters).
    pub fn backfill(&mut self, room_id: &str, entries: &[ScanEntry]) -> Result<Vec<Change>, CoreError> {
        let fps = self.fingerprints(room_id)?;
        let facts: Vec<FileFacts> = entries.iter().filter_map(|e| read_entry(room_id, e, fps.get(&e.rel_path))).collect();
        let present: HashSet<String> = entries.iter().filter(|e| e.class == PathClass::Artifact).map(|e| e.rel_path.clone()).collect();
        self.apply(room_id, &facts, &present)
    }

    fn upsert_facts(&mut self, room_id: &str, f: &FileFacts) -> Result<Option<Change>, CoreError> {
        // Body = the old upsert_one from `let id = artifact_id(...)` onward, with these substitutions:
        //   existing row lookup unchanged (created_at, title, updated_at, created_day);
        //   `meta` → `f.meta.clone()`; `(file_created, updated)` → `(f.file_created.clone(), f.updated.clone())`;
        //   `e.rel_path` → `f.rel_path`; `e.target.to_string_lossy()` → `f.target`.
        //   Created precedence, journal-folder day, created_day reuse, touch(old/new day) and the
        //   "same title + updated + day → None" rule stay exactly as they are today.
        todo!("port upsert_one body as described")
    }
}
```
The `todo!` stands for a mechanical port of the existing `upsert_one` body (index.rs:95-135 at plan time). The implementer must replace it with that body and the listed substitutions. A remaining `todo!` is a defect. Import `HashMap` and `crate::meta::Meta`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p rooms-core --lib && cargo test -p rooms-core --test core_flows -- --test-threads=1`
Expected: all pass. That includes the existing `unchanged_file_skips_meta_read` and `unchanged_journal_file_still_gets_folder_day` tests.

- [ ] **Step 5: Commit**

```bash
git add crates/rooms-core
git commit -m "refactor(core): split index upsert into fingerprint/read/apply; strict ISO dates"
```

---

### Task 2: RoomsCore — atomic seq, per-room scan lock, IO outside the global lock

**Files:**
- Modify: `crates/rooms-core/src/core.rs`
- Test: append to `crates/rooms-core/tests/core_flows.rs`

**Interfaces:**
- Consumes: Task 1 (`fingerprints`, `read_entry`, `apply`, `room_summary`).
- Produces:
  - `RoomsCore` gains private fields `seq: Arc<AtomicU64>` and `scan_locks: Arc<Mutex<HashMap<RoomId, Arc<Mutex<()>>>>>`. `Inner.seq` is removed.
  - `current_seq()` reads the atomic and takes no lock.
  - `emit` still runs while holding `Inner`, and does `let s = self.seq.fetch_add(1, SeqCst) + 1;` then `send`. The send order still matches seq order.
  - `try_rescan_room(room)` becomes:
    1. Lock this room's scan mutex. Get it from `scan_locks` with a short lock on the map, clone the `Arc`, release the map, then lock the room mutex.
    2. Read `room_root` (short global lock).
    3. Check availability. This needs no lock; for the unavailable branch keep today's behavior, taking the global lock only to flag and emit.
    4. Run `scan_room` without the lock.
    5. Run `index.fingerprints` (short global lock).
    6. Run `read_entry` for each entry without the lock.
    7. Take the global lock. **If the room no longer exists** (`room != JOURNAL_ROOM_ID && state.find(room).is_none()`), drop everything and return `Ok`. Otherwise call `apply`, `emit_changes`, and clear the unavailable flag. The global lock is held only here.
  - `to_room` uses `index.room_summary` instead of `index.list`.
  - `journal_day`: SQL `by_day` stays under the lock. Listing the notes directory and reading `file_times` happen **after** releasing it.
  - `save_note`: writing the temp file and renaming it happen **without** the global lock. Take the lock only to `emit`.
  - `sync_home_dirs` / `open`:
    - `reconcile_home_dirs` is split. `list_home_dirs(home) -> Vec<HomeDir { path, name, dev, ino }>` does the `read_dir` and `inode_of` with no lock. `reconcile_home_dirs(home, listing, state)` runs under the lock.
    - The "gone" check keeps its per-room `symlink_metadata`. These are cheap stats over a handful of owned rooms and are allowed under the lock; add a comment saying so.
    - **The inbox is excluded from inode matching.** A Finder rename of `inbox` adopts the renamed folder as a normal room. `sync_home_dirs` then recreates an empty `home/inbox` (`create_dir_all`) so the inbox record never points elsewhere.
  - `create_room` and `rename_room` keep their small filesystem ops under the lock. These are intentional: the slug check and the mkdir/rename must be atomic. Add a comment.

- [ ] **Step 1: Write the failing tests**

Append to `core_flows.rs`:
```rust
#[test]
fn concurrent_rescans_of_one_room_converge_to_latest_files() {
    let (d, core) = home();
    let r = core.create_room("c").unwrap();
    for i in 0..300 { fs::write(d.path().join(format!("c/{i}.html")), format!("<title>{i}</title>")).unwrap(); }
    let threads: Vec<_> = (0..4).map(|_| { let c = core.clone(); let id = r.id.clone(); std::thread::spawn(move || c.rescan_room(&id)) }).collect();
    fs::remove_file(d.path().join("c/0.html")).unwrap();
    fs::write(d.path().join("c/new.html"), "<title>new</title>").unwrap();
    for t in threads { t.join().unwrap(); }
    core.rescan_room(&r.id);
    let rels: std::collections::HashSet<String> = core.list_artifacts(&r.id).unwrap().into_iter().map(|a| a.rel_path).collect();
    assert!(!rels.contains("0.html") && rels.contains("new.html") && rels.len() == 300, "{}", rels.len());
}

#[test]
fn scan_of_removed_room_writes_nothing() {
    let (d, core) = home();
    let r = core.create_room("gone").unwrap();
    for i in 0..500 { fs::write(d.path().join(format!("gone/{i}.html")), "").unwrap(); }
    let c = core.clone(); let id = r.id.clone();
    let t = std::thread::spawn(move || c.rescan_room(&id));
    fs::remove_dir_all(d.path().join("gone")).unwrap();
    core.sync_home_dirs();
    t.join().unwrap();
    assert!(core.list_rooms().iter().all(|x| x.id != r.id));
    assert_eq!(core.list_artifacts(&r.id).unwrap_err(), CoreError::RoomNotFound);
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    assert!(core.journal_day(&today).unwrap().artifacts.iter().all(|a| a.room_id != r.id));
}

#[test]
fn api_calls_stay_fast_during_big_backfill() {
    let d = tempfile::tempdir().unwrap();
    let big = d.path().join("big");
    fs::create_dir_all(&big).unwrap();
    let head = format!("<title>t</title>{}", "x".repeat(20_000));
    for i in 0..3000 { fs::write(big.join(format!("{i}.html")), &head).unwrap(); }
    let core = RoomsCore::open(d.path()).unwrap();
    let c = core.clone();
    let t = std::thread::spawn(move || c.backfill_all().unwrap());
    let mut worst = Duration::ZERO;
    while !t.is_finished() {
        let s = Instant::now();
        let _ = core.list_rooms();
        let _ = core.current_seq();
        worst = worst.max(s.elapsed());
        std::thread::sleep(Duration::from_millis(5));
    }
    t.join().unwrap();
    assert!(worst < Duration::from_millis(150), "worst {worst:?}");
}

#[test]
fn one_new_file_in_big_room_is_added_within_a_second() {
    let d = tempfile::tempdir().unwrap();
    let big = d.path().join("big");
    fs::create_dir_all(&big).unwrap();
    for i in 0..3000 { fs::write(big.join(format!("{i}.html")), "<title>t</title>").unwrap(); }
    let (core, _w) = rooms_core::watch::open_and_watch(d.path()).unwrap();
    let id = core.list_rooms().into_iter().find(|r| r.name == "big").unwrap().id;
    let deadline = Instant::now() + Duration::from_secs(30);
    while core.list_artifacts(&id).unwrap().len() < 3000 { assert!(Instant::now() < deadline); std::thread::sleep(Duration::from_millis(50)); }
    let mut rx = core.subscribe();
    let s = Instant::now();
    fs::write(big.join("fresh.html"), "<title>fresh</title>").unwrap();
    wait_for(&mut rx, |k| matches!(k, EventKind::ArtifactAdded { artifact } if artifact.rel_path == "fresh.html"), Duration::from_secs(2));
    assert!(s.elapsed() < Duration::from_secs(1), "{:?}", s.elapsed());
}

#[test]
fn finder_rename_of_inbox_does_not_move_the_inbox() {
    let (d, core) = home();
    fs::write(d.path().join("inbox/x.html"), "").unwrap();
    fs::rename(d.path().join("inbox"), d.path().join("old-inbox")).unwrap();
    core.sync_home_dirs();
    let rooms = core.list_rooms();
    let inbox = rooms.iter().find(|r| r.id == "inbox").unwrap();
    assert_eq!(std::path::Path::new(&inbox.path), d.path().canonicalize().unwrap().join("inbox"));
    assert!(d.path().join("inbox").is_dir());
    assert!(rooms.iter().any(|r| r.name == "old-inbox" && r.id != "inbox"));
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p rooms-core --test core_flows -- --test-threads=1`
Expected: `finder_rename_of_inbox_does_not_move_the_inbox` fails (the inbox record follows the inode). `api_calls_stay_fast_during_big_backfill` fails (`worst` is above 150 ms because reads happen under the lock). The others may or may not fail today. Record which ones fail in the report.

- [ ] **Step 3: Write the implementation**

Implement the Interfaces bullets above. The core pipeline:
```rust
fn scan_lock(&self, room: &RoomId) -> Arc<Mutex<()>> {
    self.scan_locks.lock().unwrap().entry(room.clone()).or_default().clone()
}

fn try_rescan_room(&self, room: &RoomId) -> Result<(), CoreError> {
    let lock = self.scan_lock(room);
    let _serial = lock.lock().unwrap(); // lock order: room scan lock → Inner
    let Some((root, kind)) = self.room_root(room) else { return Ok(()) };
    if !root_available(&root) {
        let mut inner = self.inner.lock().unwrap();
        if inner.state.find(room).is_some() && inner.unavailable.insert(room.clone()) { self.emit_room_updated(&mut inner, room); }
        return Ok(());
    }
    let entries = scan_room(&root, kind == RoomKind::Linked, kind == RoomKind::Journal); // no lock
    let fps = { self.inner.lock().unwrap().index.fingerprints(room)? };
    let facts: Vec<_> = entries.iter().filter_map(|e| read_entry(room, e, fps.get(&e.rel_path))).collect(); // no lock
    let present: HashSet<String> = entries.iter().filter(|e| e.class == PathClass::Artifact).map(|e| e.rel_path.clone()).collect();
    let mut inner = self.inner.lock().unwrap();
    if room != JOURNAL_ROOM_ID && inner.state.find(room).is_none() { return Ok(()); } // removed mid-scan
    let ch = inner.index.apply(room, &facts, &present)?;
    self.emit_changes(&mut inner, ch);
    if inner.unavailable.remove(room) { self.emit_room_updated(&mut inner, room); }
    Ok(())
}
```
`room_summary` replaces `index.list` in `to_room`:
```rust
let (count, updated_at) = inner.index.room_summary(&r.id).unwrap_or((0, None));
```
When a room is removed (`HomeChange::Removed`), also remove its entry from `scan_locks`. Take the map lock only, never while holding a room lock.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --workspace -- --test-threads=1` three times in a row.
Expected: all pass each time, with no warnings. If a timing test is flaky, find the cause; don't raise the threshold. Report the measured `worst` and add-latency numbers.

- [ ] **Step 5: Commit**

```bash
git add crates/rooms-core
git commit -m "perf(core): scan and read files outside the core lock; serialize scans per room"
```

---

### Task 3: Watcher — weak helper threads, overflow resync, quieter retry log

**Files:**
- Modify: `crates/rooms-core/src/watch.rs`, `crates/rooms-core/src/core.rs` (additive)
- Test: append to `crates/rooms-core/tests/core_flows.rs`

**Interfaces:**
- Consumes: Task 2's `RoomsCore`.
- Produces:
  - `#[derive(Clone)] pub struct WeakRoomsCore { … }` with `pub fn upgrade(&self) -> Option<RoomsCore>`.
    - It holds `Weak<Mutex<Inner>>` and `broadcast::WeakSender<RoomsEvent>`, plus clones of the `Arc` fields and `home`.
    - `upgrade` returns `None` when either weak fails.
  - `impl RoomsCore { pub fn downgrade(&self) -> WeakRoomsCore }`
  - `impl RoomsCore { pub fn resync_all(&self) }` runs `backfill_all()` (logging an error) and then emits `EventKind::Resync { room_id: None }`.
  - Watcher:
    - The room-event listener thread and the retry thread hold only a `WeakRoomsCore` plus a `Weak` debouncer. Each loop iteration upgrades both, and the thread exits when either upgrade fails.
    - The debouncer callback may keep a strong `RoomsCore`, because it is owned by the debouncer, which `WatchHandle` owns.
    - In a batch, if any event has `need_rescan()`, or the result is `Err`, call `resync_all()` instead of per-room rescans (spec §3 `watch_overflow`).
    - A linked root whose `watch()` fails is logged **once** per path, through a `HashSet<PathBuf>` of already-logged paths. A later success clears the entry.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn dropping_handle_and_core_closes_the_event_channel() {
    let d = tempfile::tempdir().unwrap();
    let (core, w) = rooms_core::watch::open_and_watch(d.path()).unwrap();
    let mut rx = core.subscribe();
    drop(w);
    std::thread::sleep(Duration::from_millis(2500)); // one retry tick, so the retry thread sees the dropped debouncer
    drop(core);
    let s = Instant::now();
    loop {
        match rx.try_recv() {
            Err(tokio::sync::broadcast::error::TryRecvError::Closed) => break,
            _ => { assert!(s.elapsed() < Duration::from_secs(3), "a helper thread still holds the core"); std::thread::sleep(Duration::from_millis(20)); }
        }
    }
}

#[test]
fn resync_all_rescans_and_emits_resync() {
    let (d, core) = home();
    let r = core.create_room("a").unwrap();
    fs::write(d.path().join("a/x.html"), "").unwrap();
    let mut rx = core.subscribe();
    core.resync_all();
    let evs = drain(&mut rx);
    assert!(evs.iter().any(|e| matches!(&e.kind, EventKind::ArtifactAdded { artifact } if artifact.room_id == r.id)));
    assert!(matches!(evs.last().unwrap().kind, EventKind::Resync { room_id: None }));
}
```
Note: the background backfill thread from `open_and_watch` also holds a strong core. In this test the home is empty, so the backfill finishes within the 2.5 s sleep.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p rooms-core --test core_flows -- --test-threads=1 dropping_handle_and_core resync_all`
Expected: FAIL. `resync_all` is missing, so it doesn't compile. Once that is stubbed, the channel never closes, because the listener thread holds a strong core.

- [ ] **Step 3: Write the implementation**

Implement the Interfaces. The listener loop shape:
```rust
let (wcore, wdeb) = (core.downgrade(), Arc::downgrade(&deb));
std::thread::spawn(move || loop {
    match rx.blocking_recv() {
        Ok(e) => {
            let room = match e.kind { EventKind::RoomAdded { room } | EventKind::RoomUpdated { room } if room.kind == RoomKind::Linked => room, _ => continue };
            let (Some(core), Some(deb)) = (wcore.upgrade(), wdeb.upgrade()) else { break };
            /* existing unwatch / ensure_linked_watched body, using `core` and `deb` */
        }
        Err(RecvError::Lagged(_)) => continue,
        Err(RecvError::Closed) => break,
    }
});
```
The `rx` receiver does not keep the channel open, because only senders do. The retry thread does `let (Some(core), Some(deb)) = (wcore.upgrade(), wdeb.upgrade()) else { break };` on every tick.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --workspace -- --test-threads=1`
Expected: all pass, no warnings.

- [ ] **Step 5: Commit**

```bash
git add crates/rooms-core
git commit -m "fix(core): weak watcher helper threads, resync on watcher overflow, log failed watches once"
```

---

### Task 4: Update the follow-ups record

**Files:**
- Modify: `docs/superpowers/plans/2026-10-05-alto-rooms-plan-1-followups.md`

- [ ] **Step 1:** Mark these items resolved by Plan 1.5. Move them under a `## Resolved in Plan 1.5` heading, each with a one-line pointer to its task:
  - scan generation
  - thread leak
  - loose journal date
  - inbox rename
  - watcher overflow resync
  - IO out of lock
  - SSE `current_seq` on async worker
  - retry log spam
  - stray `journal.changed` after rollback

  Add one line explaining that per-path watcher updates were replaced by the fingerprint skip, and list the measured latencies from Task 2.
- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/plans/2026-10-05-alto-rooms-plan-1-followups.md
git commit -m "docs: mark Plan 1 follow-ups resolved by Plan 1.5"
```
